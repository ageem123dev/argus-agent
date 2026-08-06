/**
 * Tests for the source-independent half of ingestion: normalizing findings,
 * partitioning them against Argus's own, and distilling the misses.
 *
 * The adapter that reads a specific reviewer's output is not covered here —
 * it does not exist yet, pending a real sample of that format.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { make_finding, parse_findings } from "../src/findings.mjs";
import { ingest_findings, partition_findings, score_partition } from "../src/ingest.mjs";
import { find_run_for_commit, read_run_records } from "../src/run_record.mjs";
import type { RunRecord } from "../src/run_record.mjs";

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-ingest-"));
after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

const external = (over: Partial<Parameters<typeof make_finding>[0]> = {}) =>
  make_finding({
    source: "coderabbit",
    path: "src/auth/token.mts",
    line: 42,
    severity: "high",
    title: "jwt.decode does not verify the signature",
    ...over,
  });

const ours = (over: Partial<Parameters<typeof make_finding>[0]> = {}) =>
  make_finding({
    source: "argus",
    path: "src/auth/token.mts",
    line: 42,
    severity: "high",
    title: "token signature is never checked",
    ...over,
  });

describe("findings", () => {
  it("parses path, line, and severity out of a verdict line", () => {
    const [f] = parse_findings(
      "- **severity: high** `src/auth/token.mts:42` calls jwt.decode instead of jwt.verify.",
    );
    assert.equal(f.path, "src/auth/token.mts");
    assert.equal(f.line, 42);
    assert.equal(f.severity, "high");
    assert.equal(f.locus, "src/auth/**");
    assert.equal(f.topic, "authentication and token handling");
  });

  it("skips prose that carries no severity marker", () => {
    assert.deepEqual(parse_findings("## Findings\n\nThe diff looks broadly fine.\n"), []);
  });

  it("normalizes diff-header and windows paths to one repo-relative form", () => {
    assert.equal(make_finding({ source: "x", path: "a/src/auth/x.mts", title: "" }).path, "src/auth/x.mts");
    assert.equal(make_finding({ source: "x", path: "src\\auth\\x.mts", title: "" }).path, "src/auth/x.mts");
  });

  it("defaults an unstated severity to medium rather than dropping the finding", () => {
    assert.equal(make_finding({ source: "x", path: "a.mts", title: "something" }).severity, "medium");
  });

  it("classifies from the reviewer's own category when its prose is uninformative", () => {
    const f = make_finding({
      source: "coderabbit",
      path: "src/db/query.mts",
      title: "this looks wrong",
      category: "SQL injection",
    });
    assert.equal(f.topic, "injection and untrusted input");
  });
});

describe("partition_findings", () => {
  it("counts a shared finding as agreement even when the cited lines differ", () => {
    const p = partition_findings([ours({ line: 45 })], [external({ line: 42 })]);
    assert.equal(p.agreed.length, 1);
    assert.equal(p.agreed[0].matched_on, "path+topic");
    assert.deepEqual(p.missed, []);
    assert.deepEqual(p.argus_only, []);
  });

  it("does not call two unrelated findings on one line agreement", () => {
    const p = partition_findings(
      [ours({ title: "quadratic scan over the request queue", severity: "low" })],
      [external()],
    );
    assert.equal(p.agreed.length, 0);
    assert.equal(p.missed.length, 1);
    assert.equal(p.argus_only.length, 1);
  });

  it("ranks topics by hits, so one stray term does not decide the class", () => {
    // "token" alone must not make a performance finding an auth finding —
    // that collision is what silently inflates the agreed set.
    const perf = ours({ title: "quadratic scan over the token list, slow" });
    assert.equal(perf.topic, "performance");
    assert.equal(partition_findings([perf], [external()]).agreed.length, 0);
  });

  it("records a same-line match as weaker evidence than a same-topic one", () => {
    // Known limit: unclassifiable findings on one line read as agreement.
    // matched_on is what makes that discountable rather than invisible.
    const vague = ours({ title: "looks off here" });
    const [pair] = partition_findings([vague], [external({ title: "also unclear" })]).agreed;
    assert.equal(pair?.matched_on, "path+line");
  });

  it("separates findings in different files", () => {
    const p = partition_findings([ours()], [external({ path: "src/util/fmt.mts" })]);
    assert.equal(p.agreed.length, 0);
    assert.equal(p.missed.length, 1);
  });

  it("respects the line window", () => {
    const far = partition_findings([ours({ line: 100 })], [external({ line: 42 })], {
      line_window: 5,
    });
    assert.equal(far.agreed.length, 0);
    const wide = partition_findings([ours({ line: 100 })], [external({ line: 42 })], {
      line_window: 100,
    });
    assert.equal(wide.agreed.length, 1);
  });

  it("lets one external finding confirm at most one Argus finding", () => {
    // A reviewer that reports the same issue twice must not double-count.
    const p = partition_findings([ours(), ours({ line: 43 })], [external()]);
    assert.equal(p.agreed.length, 1);
    assert.equal(p.argus_only.length, 1);
  });

  it("reports everything as missed when Argus found nothing", () => {
    const p = partition_findings([], [external(), external({ path: "src/db/query.mts" })]);
    assert.equal(p.missed.length, 2);
    assert.equal(p.agreed.length, 0);
  });
});

describe("score_partition", () => {
  it("scores recall against what the other reviewer found", () => {
    const p = partition_findings([ours()], [external(), external({ path: "src/db/q.mts" })]);
    const s = score_partition(p);
    assert.equal(s.agreed, 1);
    assert.equal(s.missed, 1);
    assert.equal(s.recall, 0.5);
  });

  it("treats an empty comparison as perfect rather than dividing by zero", () => {
    const s = score_partition(partition_findings([], []));
    assert.equal(s.recall, 1);
    assert.equal(s.confirmed_rate, 1);
  });

  it("counts unconfirmed Argus findings against confirmed_rate, not recall", () => {
    const s = score_partition(partition_findings([ours({ path: "src/other/x.mts" })], [external()]));
    assert.equal(s.recall, 0);
    assert.equal(s.confirmed_rate, 0);
    assert.equal(s.argus_only, 1);
  });
});

describe("ingest_findings", () => {
  it("writes lessons only from what Argus missed", () => {
    const result = ingest_findings(
      [ours({ path: "src/perf/loop.mts", title: "quadratic scan", severity: "low" })],
      [external()],
      "app",
    );
    assert.equal(result.lessons.length, 1);
    assert.equal(result.lessons[0].locus, "src/auth/**");
    // The Argus-only finding must not be reinforced into memory.
    assert.ok(!result.lessons.some((l) => l.locus === "src/perf/**"));
  });

  it("writes nothing when the reviewers agreed", () => {
    assert.deepEqual(ingest_findings([ours()], [external()], "app").lessons, []);
  });

  it("attributes the lesson to the reviewer that raised it", () => {
    const [lesson] = ingest_findings([], [external()], "app").lessons;
    assert.match(lesson.text, /coderabbit raised a high-severity finding/);
  });

  it("still phrases a borrowed finding as where to look, not what to report", () => {
    const [lesson] = ingest_findings([], [external()], "app").lessons;
    assert.match(lesson.text, /^\[app\] Look harder in src\/auth\/\*\*/);
    assert.doesNotMatch(lesson.text, /jwt\.decode/);
  });

  it("collapses many misses in one directory into one lesson", () => {
    const misses = [1, 2, 3, 4].map((n) => external({ line: n * 100 }));
    assert.equal(ingest_findings([], misses, "app").lessons.length, 1);
  });
});

describe("run record join", () => {
  const record = (over: Partial<RunRecord>): RunRecord => ({ project: "app", ...over }) as RunRecord;

  it("joins a short SHA against the full one recorded", () => {
    const runs = [record({ commit: "371a72148a30cf7ec82f72162fb93d65070e5177" })];
    assert.ok(find_run_for_commit(runs, "371a721"));
  });

  it("takes the most recent review of a commit", () => {
    const runs = [
      record({ commit: "abc123", verdict: "first" }),
      record({ commit: "abc123", verdict: "second" }),
    ];
    assert.equal(find_run_for_commit(runs, "abc123")?.verdict, "second");
  });

  it("does not join across projects, or on a missing commit", () => {
    const runs = [record({ commit: "abc123", project: "other" })];
    assert.equal(find_run_for_commit(runs, "abc123", "app"), undefined);
    assert.equal(find_run_for_commit([record({})], "abc123"), undefined);
    assert.equal(find_run_for_commit(runs, ""), undefined);
  });

  it("reads a log with a half-written trailing line", () => {
    const file = path.join(tmp_root, "runs.jsonl");
    fs.writeFileSync(file, JSON.stringify(record({ commit: "abc" })) + '\n{"commit":"trunc', "utf-8");
    assert.equal(read_run_records(file).length, 1);
  });

  it("reads a missing log as no history", () => {
    assert.deepEqual(read_run_records(path.join(tmp_root, "nope.jsonl")), []);
  });
});
