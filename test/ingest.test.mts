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
import { lesson_from_finding } from "../src/memory.mjs";
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

  it("parses the agy provider's bracketed severity tags", () => {
    // The real shape of an agy verdict. Requiring the literal word "severity"
    // found nothing here, so every agy review compared as zero findings and
    // ingestion counted its own catches as misses.
    const verdict = [
      "## Findings",
      "- **[high]** .claude/skills/ship/SKILL.md:75 — reads review state from globalStorage.",
      "  ↳ Update the storage path to workspaceStorage.",
      "- **[medium]** src/auth/token.mts:76 — the token signature is never verified.",
    ].join("\n");

    const found = parse_findings(verdict);
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((f) => [f.severity, f.path, f.line]),
      [
        ["high", ".claude/skills/ship/SKILL.md", 75],
        ["medium", "src/auth/token.mts", 76],
      ],
    );
  });

  it("skips prose that carries no severity marker", () => {
    assert.deepEqual(parse_findings("## Findings\n\nThe diff looks broadly fine.\n"), []);
    // A bracketed word that is not a severity is prose, not a finding.
    assert.deepEqual(parse_findings("- see [note] in src/a.mts:3 for context"), []);
  });

  it("classifies the defect, not the directory it sits in", () => {
    // The whole line fed classification, path included, so the path competed
    // with the words describing the defect. The same race condition became an
    // auth lesson purely because the file sat under src/auth/.
    const race = (dir: string) =>
      parse_findings(`- **[high]** \`${dir}/worker.ts:1\` — a race on retry.`)[0]?.topic;

    assert.equal(race("src/billing"), "concurrency");
    for (const dir of ["src/auth", "src/session", "src/crypto", "src/locks"]) {
      assert.equal(race(dir), "concurrency", `${dir} must not rename the defect`);
    }
  });

  it("no longer collapses distinct defects filed under a topical directory", () => {
    // A mislabelled topic is deduped against the other findings in that
    // directory, so the real lesson is never stored at all.
    const verdict = [
      "- **[high]** `src/auth/worker.ts:1` — a race on retry.",
      "- **[high]** `src/auth/reader.ts:1` — an unclosed file handle.",
      "- **[high]** `src/auth/parser.ts:1` — unchecked array bounds.",
    ].join("\n");

    assert.deepEqual(
      parse_findings(verdict).map((f) => f.topic),
      ["concurrency", "resource leaks", "input validation"],
    );
  });

  it("still reads a genuine auth defect as auth, wherever it lives", () => {
    // The claim, not the path, is what should carry it.
    assert.equal(
      parse_findings("- **[high]** `src/billing/charge.ts:2` — the jwt signature is never verified.")[0]
        ?.topic,
      "authentication and token handling",
    );
  });

  it("keeps using a reviewer's own category when it supplies one", () => {
    // Category still leads: an explicit label beats our keyword scan.
    assert.equal(
      make_finding({
        source: "coderabbit",
        path: "src/billing/charge.ts",
        title: "this looks wrong",
        category: "SQL injection",
      }).topic,
      "injection and untrusted input",
    );
  });

  it("keeps underscores in a path, which markdown emphasis rules would eat", () => {
    // snake_case is the Python convention, and stripping "_" as emphasis
    // rewrote every such path: agent/watchdog_agent/tools_client.py became
    // agent/watchdogagent/toolsclient.py, and _bmad-output/ lost its leading
    // underscore. Lessons were then filed against directories that do not
    // exist, and could never be scoped to a real change.
    for (const cited of [
      "agent/watchdog_agent/tools_client.py",
      "_bmad-output/artifacts/story.md",
      "migrations/0009_add_units.sql",
    ]) {
      const [f] = parse_findings("- **[high]** `" + cited + ":1` — something.");
      assert.equal(f?.path, cited);
    }
  });

  it("matches a second reviewer on a snake_case path", () => {
    // The costly half. A second reviewer supplies paths as structured fields,
    // never through markdown, so a stripped underscore made the two spellings
    // disagree — and the *same* finding scored as a miss and a false positive
    // at once, understating recall and precision together.
    const mine = parse_findings(
      "- **[high]** `agent/watchdog_agent/tools_client.py:61` — empty body encodes wrong.",
    );
    const theirs = [
      make_finding({
        source: "coderabbit",
        path: "agent/watchdog_agent/tools_client.py",
        line: 61,
        severity: "high",
        title: "empty body encodes wrong",
      }),
    ];
    const p = partition_findings(mine, theirs);
    assert.equal(p.agreed.length, 1, "the same finding must not read as a miss");
    assert.deepEqual(p.missed, []);
    assert.deepEqual(p.argus_only, []);
  });

  it("keeps a dotfile directory intact, so both reviewers cite the same path", () => {
    // Anchoring the path on \b dropped the leading dot, and the resulting
    // "claude/skills/..." never matched CodeRabbit's ".claude/skills/...".
    const [f] = parse_findings("- **[high]** .claude/skills/ship/SKILL.md:75 — stale review.");
    assert.equal(f.path, ".claude/skills/ship/SKILL.md");
    assert.equal(f.locus, ".claude/skills/ship/**");
  });

  it("recognizes files an explicit code-extension list would miss", () => {
    const cited = (line: string) => parse_findings(`- severity: low ${line}`)[0]?.path;
    assert.equal(cited("`.gitlab-ci.yml` has a stale comment"), ".gitlab-ci.yml");
    assert.equal(cited("`docs/adr/0004-caching.md` is out of date"), "docs/adr/0004-caching.md");
    assert.equal(cited("`pyproject.toml` pins an old version"), "pyproject.toml");
  });

  it("counts a finding once when the verdict states it twice", () => {
    // The real shape of an agy verdict: a prose summary that says "High
    // Severity …(path:221)", then the structured list repeating it. Parsing
    // both doubled Argus's apparent finding count and skewed every ratio.
    const verdict = [
      "### Key Findings",
      "1. **High Severity Queue Starvation (`app/api/purge/route.ts:221`)**: the batch query…",
      "2. **Medium Severity Purge Omission (`app/api/purge/route.ts:224`)**: filtering excludes…",
      "## Findings",
      "- **[high]** app/api/purge/route.ts:221 — the purge batch query starves the queue.",
      "- **[medium]** app/api/purge/route.ts:224 — the filter excludes rows it should keep.",
    ].join("\n");

    const found = parse_findings(verdict);
    assert.deepEqual(
      found.map((f) => `${f.path}:${f.line}`),
      ["app/api/purge/route.ts:221", "app/api/purge/route.ts:224"],
    );
  });

  it("keeps the graver severity when the two statements disagree", () => {
    const verdict = [
      "- severity: low src/a.mts:10 — the summary underplays it.",
      "- **[critical]** src/a.mts:10 — the structured list is graver.",
    ].join("\n");
    assert.deepEqual(
      parse_findings(verdict).map((f) => f.severity),
      ["critical"],
    );
  });

  it("keeps unlocated findings apart, having no way to tell them apart", () => {
    const verdict = "- severity: high something vague\n- severity: high something else vague";
    assert.equal(parse_findings(verdict).length, 2);
  });

  it("does not read a missing space after a full stop as a filename", () => {
    assert.equal(
      parse_findings("- severity: low state lives in workspaceStorage.The next step is unclear")[0]
        ?.path,
      undefined,
    );
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

  it("attributes the lesson without letting attribution vary the text", () => {
    const [lesson] = ingest_findings([], [external()], "app").lessons;
    assert.equal(lesson.raised_by, "coderabbit");
    // Attribution and severity stay out of the sentence: in the text they made
    // one lesson several records, which then competed for the same recall slots.
    assert.equal(
      lesson.text,
      "[app] Look harder in TypeScript under src/auth/** for authentication and token handling.",
    );
  });

  it("gives one locus and topic one text, whoever raised it and however grave", () => {
    const mine = lesson_from_finding(ours(), "app", "a past review");
    const theirs = lesson_from_finding(
      make_finding({ ...external(), severity: "critical" }),
      "app",
      "coderabbit",
    );
    assert.equal(mine.text, theirs.text);
    assert.notEqual(mine.importance, theirs.importance);
  });

  it("still phrases a borrowed finding as where to look, not what to report", () => {
    const [lesson] = ingest_findings([], [external()], "app").lessons;
    assert.match(lesson.text, /^\[app\] Look harder in TypeScript under src\/auth\/\*\*/);
    assert.doesNotMatch(lesson.text, /jwt\.decode/);
  });

  it("keeps a lesson per language, not one per directory", () => {
    // The same directory holding a schema and its documentation yields two
    // lessons, not one: SQL injection says nothing about the Markdown beside it.
    const misses = [
      external({ path: "db/migrations/0002_add_users.sql", title: "unescaped identifier" }),
      external({ path: "db/migrations/README.md", title: "unescaped identifier" }),
    ];
    const { lessons } = ingest_findings([], misses, "app");
    assert.equal(lessons.length, 2);
    assert.deepEqual(lessons.map((l) => l.language).sort(), ["markdown", "sql"]);
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
