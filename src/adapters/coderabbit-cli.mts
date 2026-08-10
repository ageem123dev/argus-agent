/**
 * CodeRabbit adapter — reads the CLI's agent-mode event stream.
 *
 * The sibling adapter (`coderabbit.mts`) reads the VS Code extension's private
 * storage: an undocumented shape, behind a path with two rotating hashes. This
 * one reads what `coderabbit review --agent` writes, which is a documented
 * contract. Prefer it.
 *
 * Shape, per the CLI reference (docs.coderabbit.ai/cli/reference):
 *
 *   a stream of JSON events, each carrying `type`, one of
 *   review_context | finding | status | heartbeat | complete | error
 *
 *   a `finding` event carries:
 *     severity              critical | major | minor | trivial | info
 *     fileName              the file it is about
 *     comment               human-readable feedback
 *     codegenInstructions   agent-oriented fix guidance
 *     suggestions           proposed fix commands or code
 *
 * Confirmed against a real capture (CLI 0.7.2, `--base main --committed
 * --agent`, 10 findings). Three things the documentation does not say, and all
 * three matter:
 *
 *   1. **There is no `comment` field.** Only `codegenInstructions` and
 *      `suggestions` are present. The documented fallback is the only path.
 *
 *   2. **`codegenInstructions` opens with a fixed preamble**, identical on every
 *      finding ("Verify each finding against current code. …"). Taking the first
 *      line as the title gave all ten findings the *same* title, which would
 *      have collapsed every comparison into one topic. The real claim is the
 *      paragraph after it, in the form
 *      `In @<path> around lines 122 - 128, <claim>`.
 *
 *   3. **There is no line field, but there are line numbers** — in that prose.
 *      Parsing them back out restores path+line matching; without it the
 *      partitioner falls back to path+topic and a genuine miss becomes hard to
 *      tell from a near-miss. 10/10 findings carried a range.
 *
 * And one thing the stream genuinely does not carry:
 *
 *   **The commit.** `review_context` holds only `baseBranch`, `currentBranch`,
 *   `reviewType` and `workingDirectory`. Ingest joins reviews to Argus runs on
 *   commit SHA and *skips* what it cannot join, so a CLI review ingested without
 *   help teaches nothing — quietly. `head_commit` is left undefined rather than
 *   guessed, and **the caller must pass `commit` to `argus_ingest`**, captured
 *   with `git rev-parse HEAD` at review time. A guessed commit would be worse
 *   than none: it would score Argus against a review of different code.
 *
 * As with the sibling adapter, every field is optional regardless. This is
 * another tool's output, and it will drift.
 */
import { createHash } from "node:crypto";

import { make_finding, strip_markdown, type Finding } from "../findings.mjs";
import type { CodeRabbitParseOptions, CodeRabbitReview } from "./coderabbit.mjs";

/** Short content hash, used to give an id-less capture a stable identity. */
function digest(raw: string): string {
  return createHash("sha256").update(String(raw), "utf-8").digest("hex").slice(0, 16);
}

/**
 * CodeRabbit's CLI severity words. The first four match the extension's; `info`
 * is the CLI's alone and sits below `trivial`.
 */
export const CODERABBIT_CLI_SEVERITY: Record<string, string> = {
  critical: "critical",
  major: "high",
  minor: "low",
  trivial: "nit",
  info: "nit",
};

/** Field names a line number might arrive under, since none is documented. */
const LINE_KEYS = ["line", "startLine", "start_line", "lineNumber", "line_number"];

/** Likewise for the reviewed commit, on the review_context event. */
const HEAD_COMMIT_KEYS = [
  "headCommitId",
  "headCommit",
  "head_commit",
  "commit",
  "sha",
  "headSha",
  "head_sha",
];

const BASE_COMMIT_KEYS = ["baseCommitId", "baseCommit", "base_commit", "baseSha", "base_sha"];

type Event = Record<string, unknown>;

function first_string(source: Event, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function first_number(source: Event, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    // A line that arrived as text is still a line; dropping it would cost a
    // path+line match and quietly coarsen every comparison.
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

/**
 * Pulls JSON objects out of raw output.
 *
 * Newline-delimited is the expected form, but a stream that is pretty-printed,
 * wrapped in an array, or interleaved with human-readable noise must not read
 * as "no findings" — that is indistinguishable from a clean review, and a false
 * clean is the one failure this pipeline must never make silently.
 */
export function extract_events(raw: string): Event[] {
  const text = String(raw ?? "");
  const events: Event[] = [];

  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (value !== null && typeof value === "object") events.push(value as Event);
  };

  // Whole document first: an array, or a single object.
  try {
    push(JSON.parse(text));
    if (events.length > 0) return events;
  } catch {
    // Not one document; fall through to line and brace scanning.
  }

  // Newline-delimited, the expected form.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try {
      push(JSON.parse(trimmed));
    } catch {
      // Not a complete object on this line; the brace scan below may recover it.
    }
  }
  if (events.length > 0) return events;

  // Last resort: pretty-printed objects concatenated. Scan balanced braces,
  // ignoring braces that appear inside strings.
  let depth = 0;
  let start = -1;
  let in_string = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (in_string) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') in_string = false;
      continue;
    }
    if (ch === '"') in_string = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // Not valid JSON; skip it.
        }
        start = -1;
      }
    }
  }

  return events;
}

/** First non-empty line, markdown stripped. */
function title_of(text: string): string {
  const first = String(text)
    .split("\n")
    .map(strip_markdown)
    .find((l) => l.length > 0);
  return first ?? "";
}

/**
 * The fixed instruction block the CLI prepends to every `codegenInstructions`.
 * Matched on its opening sentence rather than the whole paragraph, which reads
 * like prompt text and will be reworded.
 */
const PREAMBLE = /^\s*Verify each finding against current code\.[^\n]*\n+/;

/**
 * The claim itself: `In @<path> around lines 122 - 128, <claim>`.
 *
 * The line range is the only place a line number appears anywhere in the
 * stream. Both the `@` and the end of the range are optional — a single-line
 * finding writes "around line 42".
 */
const CLAIM = /^\s*In\s+@?(\S+?)\s+around\s+lines?\s+(\d+)\s*(?:[-–—]\s*(\d+)\s*)?,\s*([\s\S]*)$/i;

interface ParsedInstructions {
  title: string;
  line?: number;
}

/**
 * Recovers the claim and its line number from the instruction prose.
 *
 * Exported for testing: this is the part most likely to break when CodeRabbit
 * rewords its instruction template, and a break here is silent — every finding
 * would still parse, they would just all share the preamble as their title and
 * collapse into a single topic.
 */
export function parse_instructions(text: string): ParsedInstructions {
  const withoutPreamble = String(text ?? "").replace(PREAMBLE, "");

  const match = CLAIM.exec(withoutPreamble);
  if (match) {
    const [, , start, , claim] = match;
    const title = title_of(claim ?? "");
    if (title !== "") {
      return { title, line: start ? Number(start) : undefined };
    }
  }

  // Unrecognised shape: fall back to the first line of whatever remains after
  // the preamble. Worse than a parsed claim, still better than the preamble.
  return { title: title_of(withoutPreamble) };
}

function finding_from_event(event: Event): Finding | undefined {
  const raw_severity = first_string(event, ["severity"]);
  // No `comment` field exists in practice, despite the documentation; the
  // instructions are the only prose the stream carries.
  const body =
    first_string(event, ["comment"]) ?? first_string(event, ["codegenInstructions"]) ?? "";
  const { title, line } = parse_instructions(body);
  if (title === "") return undefined;

  return make_finding({
    source: "coderabbit",
    path: first_string(event, ["fileName", "filename", "file", "path"]),
    // A real field would win if one ever appears; today the prose is all there is.
    line: first_number(event, LINE_KEYS) ?? line,
    severity: raw_severity ? CODERABBIT_CLI_SEVERITY[raw_severity.toLowerCase()] : undefined,
    raw_severity,
    title,
    category: first_string(event, ["category", "ruleId"]),
    id: first_string(event, ["fingerprint", "id"]),
  });
}

/**
 * Parse one CLI run into a single review.
 *
 * An empty array means no events were recognised at all. The caller must not
 * confuse that with a review that found nothing: a review that ran and found
 * nothing yields one review carrying zero findings.
 */
export function parse_coderabbit_cli_reviews(
  raw: string,
  opts: CodeRabbitParseOptions = {},
): CodeRabbitReview[] {
  const events = extract_events(raw);
  if (events.length === 0) return [];

  const typed = events.filter((e) => typeof e["type"] === "string");
  if (typed.length === 0) return [];

  // Guard against being handed something that merely happens to be JSON — the
  // sibling adapter's directory scan hands this parser every .json file it sees.
  const kinds = new Set(typed.map((e) => String(e["type"])));
  const recognised = ["finding", "review_context", "complete", "status", "error", "heartbeat"];
  if (!recognised.some((k) => kinds.has(k))) return [];

  const context = typed.find((e) => e["type"] === "review_context") ?? {};
  const complete_event = typed.find((e) => e["type"] === "complete");
  const complete = complete_event ?? {};

  const keep = opts.severities?.map((s) => s.toLowerCase());
  let filtered_out = 0;
  const findings: Finding[] = [];

  for (const event of typed) {
    if (event["type"] !== "finding") continue;

    const raw_severity = first_string(event, ["severity"])?.toLowerCase();
    if (keep && (raw_severity === undefined || !keep.includes(raw_severity))) {
      filtered_out += 1;
      continue;
    }

    const finding = finding_from_event(event);
    if (finding) findings.push(finding);
    else filtered_out += 1;
  }

  const status = first_string(complete, ["status"]) ?? first_string(context, ["status"]);

  // A partial review under-reports, and scoring Argus against work that never
  // finished manufactures misses out of code the reviewer never read.
  //
  // The test is that the run positively declared itself complete — not merely
  // that it failed to declare itself skipped. Checking only for
  // "review_skipped" passed two shapes that must not pass: any other terminal
  // status, and a stream that simply stops, which is what a crashed or
  // still-running review looks like. Both then read as a finished review, which
  // is the false-clean this pipeline exists to refuse.
  if (opts.completed_only !== false && status !== "review_completed") {
    opts.on_problem?.(
      complete_event
        ? `the review did not complete (status=${status ?? "unset"}) — nothing to ingest from it`
        : "the stream ends without a `complete` event — the review was interrupted or is " +
          "still running, so its findings are not a final result",
    );
    return [];
  }

  return [
    {
      // The stream carries no review id, and the ingest ledger keys on one: a
      // review with no id is recorded nowhere, so every re-run re-learns the
      // same lessons and re-inflates their confirmation counts — the exact
      // failure the ledger was added to stop. Content-addressing is the honest
      // substitute. An identical capture is the same review; a re-run that
      // found something different is genuinely a new one.
      id: first_string(context, ["reviewId", "id"]) ?? `cli:${digest(raw)}`,
      status,
      mode: first_string(context, ["mode"]) ?? "cli",
      // The stream's own field if it ever grows one, else the caller's. Both
      // beat guessing, and `opts.commit` is exactly what the caller passed.
      head_commit: first_string(context, HEAD_COMMIT_KEYS) ?? opts.commit,
      base_commit: first_string(context, BASE_COMMIT_KEYS),
      started_at: first_string(context, ["startedAt", "started_at", "timestamp"]),
      ended_at: first_string(complete, ["endedAt", "ended_at", "timestamp"]),
      // What the run actually looked at. The sibling adapter reconstructs this
      // from fileReviewMap so a caller can tell "reviewed and clean" from "never
      // reviewed"; the CLI states it outright on `complete`.
      reviewed_files: Array.isArray(complete["reviewedFiles"])
        ? (complete["reviewedFiles"] as unknown[]).filter((f): f is string => typeof f === "string")
        : undefined,
      findings,
      filtered_out,
    },
  ];
}
