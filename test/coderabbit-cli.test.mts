import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODERABBIT_CLI_SEVERITY,
  extract_events,
  parse_coderabbit_cli_reviews,
} from "../src/adapters/coderabbit-cli.mjs";

/**
 * These fixtures are built from the CLI reference's documented event and field
 * names, NOT from a captured run — the CLI is Linux/macOS only and could not be
 * executed on the machine this was written on.
 *
 * So: the field names below are documented, the *values* are invented, and two
 * things the docs do not specify are guessed defensively — line numbers on a
 * finding, and where the commit lives on review_context. Confirm both against a
 * real capture before trusting an ingest run that depends on them.
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
