import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODERABBIT_CLI_SEVERITY,
  extract_events,
  parse_coderabbit_cli_reviews,
} from "../src/adapters/coderabbit-cli.mjs";

/**
 * Two kinds of fixture here, and the difference matters.
 *
 * The hand-built ones below are shaped from the CLI reference's documented
 * field names. They pin behaviour that is easy to state and easy to get wrong:
 * severity mapping, what counts as a clean review versus unreadable output,
 * tolerance of shapes other than newline-delimited.
 *
 * They cannot catch a wrong assumption about the real output, because they
 * encode the same assumption. The real capture at the bottom of this file can,
 * and did — see the note there.
 */

const line = (event: unknown): string => JSON.stringify(event);

function stream(...events: unknown[]): string {
  return events.map(line).join("\n") + "\n";
}

const REVIEW_CONTEXT = {
  type: "review_context",
  headCommitId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  baseCommitId: "0000000000000000000000000000000000000000",
  startedAt: "2026-08-08T10:00:00.000Z",
};

const COMPLETE = { type: "complete", status: "completed", findings: 2 };

const CRITICAL_FINDING = {
  type: "finding",
  severity: "critical",
  fileName: "core/auth/password.ts",
  comment: "**Timing leak in comparison.**\n\nUse timingSafeEqual instead.",
  codegenInstructions: "Replace the === comparison with crypto.timingSafeEqual.",
  fingerprint: "cr-abc123",
};

const MINOR_FINDING = {
  type: "finding",
  severity: "minor",
  fileName: "app/page.tsx",
  comment: "Prefer a named export here.",
};

test("parses a documented event stream into one review", () => {
  const reviews = parse_coderabbit_cli_reviews(
    stream(REVIEW_CONTEXT, CRITICAL_FINDING, MINOR_FINDING, COMPLETE),
  );

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.findings.length, 2);
  assert.equal(reviews[0]!.head_commit, REVIEW_CONTEXT.headCommitId);
  assert.equal(reviews[0]!.mode, "cli");
});

test("maps CodeRabbit severity words onto the Argus scale", () => {
  const [review] = parse_coderabbit_cli_reviews(
    stream(REVIEW_CONTEXT, CRITICAL_FINDING, MINOR_FINDING, COMPLETE),
  );

  assert.equal(review!.findings[0]!.severity, "critical");
  assert.equal(review!.findings[0]!.raw_severity, "critical");
  assert.equal(review!.findings[1]!.severity, "low");
});

test("info is a CLI-only severity and sits at the bottom of the scale", () => {
  assert.equal(CODERABBIT_CLI_SEVERITY["info"], "nit");

  const [review] = parse_coderabbit_cli_reviews(
    stream(REVIEW_CONTEXT, { ...MINOR_FINDING, severity: "info" }, COMPLETE),
  );

  assert.equal(review!.findings[0]!.severity, "nit");
});

test("takes the title from the first line, markdown stripped", () => {
  const [review] = parse_coderabbit_cli_reviews(stream(REVIEW_CONTEXT, CRITICAL_FINDING, COMPLETE));

  assert.equal(review!.findings[0]!.title, "Timing leak in comparison.");
});

test("falls back to codegenInstructions when comment is absent", () => {
  const { comment, ...withoutComment } = CRITICAL_FINDING;
  const [review] = parse_coderabbit_cli_reviews(stream(REVIEW_CONTEXT, withoutComment, COMPLETE));

  assert.equal(review!.findings.length, 1);
  assert.match(review!.findings[0]!.title, /timingSafeEqual/);
});

test("filters on CodeRabbit's own severity words and counts what it dropped", () => {
  const [review] = parse_coderabbit_cli_reviews(
    stream(REVIEW_CONTEXT, CRITICAL_FINDING, MINOR_FINDING, COMPLETE),
    { severities: ["critical", "major"] },
  );

  assert.equal(review!.findings.length, 1);
  assert.equal(review!.filtered_out, 1, "a dropped finding must be counted, never silently lost");
});

/**
 * The distinction the whole pipeline rests on: a review that ran and found
 * nothing is a real result; output that could not be parsed is not. Collapsing
 * the two would report a false clean.
 */
test("a clean review is one review with no findings, not zero reviews", () => {
  const reviews = parse_coderabbit_cli_reviews(stream(REVIEW_CONTEXT, COMPLETE));

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.findings.length, 0);
});

test("unrecognisable output yields no reviews at all", () => {
  assert.deepEqual(parse_coderabbit_cli_reviews(""), []);
  assert.deepEqual(parse_coderabbit_cli_reviews("not json at all"), []);
  assert.deepEqual(parse_coderabbit_cli_reviews('{"unrelated":"object"}'), []);
  // Valid JSON of the wrong kind — load_reviews hands this parser every .json
  // file in a directory, including another tool's state.
  assert.deepEqual(parse_coderabbit_cli_reviews('[{"categories":["a","b"]}]'), []);
});

test("a skipped review is not scored", () => {
  const reviews = parse_coderabbit_cli_reviews(
    stream(REVIEW_CONTEXT, { type: "complete", status: "review_skipped", findings: 0 }),
  );

  assert.deepEqual(reviews, [], "a skipped run must not count as a clean review");
});

/**
 * Ingest joins reviews to Argus runs on commit SHA and skips what it cannot
 * join. Guessing a commit would be worse than having none — a wrong join scores
 * Argus against a review of different code — so the field is left undefined and
 * the skip stays visible.
 */
test("leaves head_commit undefined when the stream carries no commit", () => {
  const [review] = parse_coderabbit_cli_reviews(
    stream({ type: "review_context" }, CRITICAL_FINDING, COMPLETE),
  );

  assert.equal(review!.head_commit, undefined);
  assert.equal(review!.findings.length, 1);
});

test("accepts a line number under any of the plausible spellings", () => {
  for (const key of ["line", "startLine", "start_line", "lineNumber", "line_number"]) {
    const [review] = parse_coderabbit_cli_reviews(
      stream(REVIEW_CONTEXT, { ...CRITICAL_FINDING, [key]: 42 }, COMPLETE),
    );
    assert.equal(review!.findings[0]!.line, 42, `line not read from ${key}`);
  }
});

test("reads a line number that arrived as a string", () => {
  const [review] = parse_coderabbit_cli_reviews(
    stream(REVIEW_CONTEXT, { ...CRITICAL_FINDING, line: "42" }, COMPLETE),
  );

  assert.equal(review!.findings[0]!.line, 42);
});

test("survives a finding with no line at all, which is the documented shape", () => {
  const [review] = parse_coderabbit_cli_reviews(stream(REVIEW_CONTEXT, CRITICAL_FINDING, COMPLETE));

  assert.equal(review!.findings[0]!.line, undefined)
  assert.equal(review!.findings[0]!.path, "core/auth/password.ts")
});

/**
 * Output shape is not guaranteed to stay newline-delimited. Reading it as "no
 * findings" would be indistinguishable from a clean review.
 */
test("extract_events survives shapes other than newline-delimited", () => {
  const events = [REVIEW_CONTEXT, CRITICAL_FINDING, COMPLETE];

  assert.equal(extract_events(JSON.stringify(events)).length, 3, "array form");
  assert.equal(extract_events(events.map((e) => JSON.stringify(e, null, 2)).join("\n")).length, 3, "pretty-printed");
  assert.equal(
    extract_events(`starting review...\n${stream(...events)}done.\n`).length,
    3,
    "interleaved with human-readable noise",
  );
  assert.equal(extract_events(stream(...events).replace(/\n/g, "\r\n")).length, 3, "CRLF");
});

test("braces inside strings do not split an event", () => {
  const tricky = {
    type: "finding",
    severity: "major",
    fileName: "a.ts",
    comment: 'Avoid the literal { and } here, and the "quoted" text too.',
  };

  const events = extract_events(JSON.stringify(tricky, null, 2));

  assert.equal(events.length, 1);
  assert.equal(events[0]!["comment"], tricky.comment);
});

/**
 * Against a real capture — CLI 0.7.2, `--base main --committed --agent`, taken
 * from the HOA-Treasurer-Assistant repo on 2026-08-09.
 *
 * The fixtures above are hand-built from documented field names and cannot
 * catch a wrong assumption about the real output. This one can, and did: the
 * first version of this adapter took the first line of `codegenInstructions` as
 * the title, and every finding in this capture would have been titled with the
 * same boilerplate preamble.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CAPTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures-cr-cli.jsonl"),
  "utf-8",
);

test("real capture: parses into one completed review", () => {
  const reviews = parse_coderabbit_cli_reviews(CAPTURE);

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.status, "review_completed");
  assert.equal(reviews[0]!.findings.length, 10);
});

test("real capture: every finding gets its own title, not the shared preamble", () => {
  const [review] = parse_coderabbit_cli_reviews(CAPTURE);
  const titles = review!.findings.map((f) => f.title);

  assert.equal(new Set(titles).size, titles.length, "titles collapsed — preamble leaked in");
  for (const title of titles) {
    assert.doesNotMatch(title, /^Verify each finding/, "preamble used as a title");
  }
});

test("real capture: a line number is recovered for every finding", () => {
  const [review] = parse_coderabbit_cli_reviews(CAPTURE);

  for (const finding of review!.findings) {
    assert.equal(typeof finding.line, "number", `no line for ${finding.path}`);
  }
});

test("real capture: every finding names a file", () => {
  const [review] = parse_coderabbit_cli_reviews(CAPTURE);

  for (const finding of review!.findings) {
    assert.ok(finding.path && finding.path.length > 0);
  }
});

test("real capture: reviewed_files records coverage the finding list cannot", () => {
  const [review] = parse_coderabbit_cli_reviews(CAPTURE);

  // 25 files examined, 10 with findings: the other 15 are reviewed-and-clean,
  // which is exactly the distinction a finding list cannot express.
  assert.equal(review!.reviewed_files?.length, 25);
  assert.ok(review!.reviewed_files!.length > review!.findings.length);
});

/**
 * The stream carries no commit, so ingest cannot join this review to an Argus
 * run on its own. Asserted rather than merely documented: if a future CLI adds
 * one, this fails and tells us to stop passing `commit` by hand.
 */
test("real capture: carries no commit, so the caller must supply one", () => {
  const [review] = parse_coderabbit_cli_reviews(CAPTURE);

  assert.equal(review!.head_commit, undefined);
});

test("real capture: severity filtering keeps CodeRabbit's own vocabulary", () => {
  const [review] = parse_coderabbit_cli_reviews(CAPTURE, { severities: ["critical", "major"] });

  assert.equal(review!.findings.length, 6, "6 major findings in this capture");
  assert.equal(review!.filtered_out, 4, "4 trivial findings dropped and counted");
});
