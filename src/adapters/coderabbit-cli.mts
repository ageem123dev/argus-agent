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
 * Two things the documentation does NOT specify, both handled defensively and
 * both worth confirming against a real capture:
 *
 *   1. **Line numbers.** No line field is documented on `finding`. Several
 *      plausible spellings are accepted below. If findings really are
 *      file-level, ingest still works — the partitioner falls back from
 *      path+line to path+topic — but matches get coarser, so a genuine miss and
 *      a near-miss become harder to tell apart.
 *
 *   2. **The commit.** `review_context` is the only event that could carry it,
 *      and its fields are undocumented. This matters more than it looks: ingest
 *      joins reviews to Argus runs on commit SHA and *skips* a review it cannot
 *      join, so a stream with no commit teaches nothing and says so only in the
 *      run report. `head_commit` is left undefined rather than guessed, so the
 *      skip is visible; callers can pass `commit` explicitly to override.
 *
 * As with the sibling adapter, every field is optional regardless. This is
 * another tool's output, and it will drift.
 */
import { make_finding, strip_markdown, type Finding } from "../findings.mjs";
import type { CodeRabbitParseOptions, CodeRabbitReview } from "./coderabbit.mjs";

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

/** First non-empty line of the comment, markdown stripped. */
function title_of(text: string): string {
  const first = String(text)
    .split("\n")
    .map(strip_markdown)
    .find((l) => l.length > 0);
  return first ?? "";
}

function finding_from_event(event: Event): Finding | undefined {
  const raw_severity = first_string(event, ["severity"]);
  // `comment` is the human-readable claim; `codegenInstructions` is fix
  // guidance and is the documented fallback when `comment` is absent.
  const body =
    first_string(event, ["comment"]) ?? first_string(event, ["codegenInstructions"]) ?? "";
  const title = title_of(body);
  if (title === "") return undefined;

  return make_finding({
    source: "coderabbit",
    path: first_string(event, ["fileName", "filename", "file", "path"]),
    line: first_number(event, LINE_KEYS),
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
  const complete = typed.find((e) => e["type"] === "complete") ?? {};

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

  // `completed_only` defaults on in the sibling adapter, because a partial
  // review under-reports and would score Argus against work that never
  // finished. The CLI marks a skipped run explicitly.
  if (opts.completed_only !== false && status === "review_skipped") return [];

  return [
    {
      id: first_string(context, ["reviewId", "id"]),
      status,
      mode: first_string(context, ["mode"]) ?? "cli",
      head_commit: first_string(context, HEAD_COMMIT_KEYS),
      base_commit: first_string(context, BASE_COMMIT_KEYS),
      started_at: first_string(context, ["startedAt", "started_at", "timestamp"]),
      ended_at: first_string(complete, ["endedAt", "ended_at", "timestamp"]),
      findings,
      filtered_out,
    },
  ];
}
