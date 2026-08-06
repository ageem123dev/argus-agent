/**
 * Tests for the CodeRabbit adapter, configuration, and the ingest command.
 *
 * The fixture mirrors the shape the VS Code extension actually writes (as of
 * the 2026-08 build) but the content is synthetic — the real store belongs to
 * whatever repo was open at the time.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  discover_coderabbit_dirs,
  load_reviews,
  parse_coderabbit_reviews,
  resolve_coderabbit_paths,
} from "../src/adapters/coderabbit.mjs";
import { DEFAULT_SEVERITIES, load_config, parse_severities } from "../src/config.mjs";
import { format_ingest_report, run_ingest } from "../src/ingest_run.mjs";
import { JsonlVectorDB, default_memory_path } from "../src/memory_store.mjs";
import { default_record_path } from "../src/run_record.mjs";

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-cr-"));
after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

let counter = 0;
function scratch(name: string): string {
  counter += 1;
  const dir = path.join(tmp_root, `${name}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const HEAD = "fa3cab2011223344556677889900aabbccddeeff";

function comment(over: Record<string, unknown> = {}) {
  return {
    type: "actionable",
    filename: "src/auth/token.mts",
    comment: "**Verify the token signature.**\n\njwt.decode does not check the signature.",
    startLine: 42,
    endLine: 42,
    codegenInstructions: "…",
    indicatorTypes: ["potential_issue"],
    severity: "major",
    suggestions: [],
    fingerprint: "phantom:poseidon:caracal",
    id: "3b36e59b-2f5d-4a84-9b96-15d07cb1e4ca",
    ...over,
  };
}

function review_json(comments: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const fileReviewMap: Record<string, { comments: unknown[] }> = {};
  for (const c of comments) {
    const file = String(c.filename);
    (fileReviewMap[file] ??= { comments: [] }).comments.push(c);
  }
  return JSON.stringify([
    {
      id: "abaacccb-b319-46c7-a46e-65890871d018",
      status: "completed",
      mode: "manual",
      startedAt: "2026-08-06T14:02:05.322Z",
      endedAt: "2026-08-06T14:12:54.418Z",
      headCommitId: HEAD,
      baseCommitId: "fc96357c0011223344556677889900aabbccddee",
      fileReviewMap,
      ...over,
    },
  ]);
}

describe("parse_coderabbit_reviews", () => {
  it("reads a finding out of the extension's store", () => {
    const [review] = parse_coderabbit_reviews(review_json([comment()]));
    assert.equal(review.head_commit, HEAD);
    assert.equal(review.findings.length, 1);

    const [f] = review.findings;
    assert.equal(f.source, "coderabbit");
    assert.equal(f.path, "src/auth/token.mts");
    assert.equal(f.line, 42);
    assert.equal(f.title, "Verify the token signature.");
    assert.equal(f.category, "potential_issue");
    assert.equal(f.id, "phantom:poseidon:caracal");
    assert.equal(f.topic, "authentication and token handling");
    assert.equal(f.locus, "src/auth/**");
  });

  it("maps CodeRabbit severities onto Argus's scale, keeping the original", () => {
    const raw = review_json([
      comment({ severity: "critical" }),
      comment({ severity: "major", filename: "a/b.mts" }),
      comment({ severity: "minor", filename: "c/d.mts" }),
      comment({ severity: "trivial", filename: "e/f.mts" }),
    ]);
    const [review] = parse_coderabbit_reviews(raw);
    assert.deepEqual(
      review.findings.map((f) => [f.raw_severity, f.severity]),
      [
        ["critical", "critical"],
        ["major", "high"],
        ["minor", "low"],
        ["trivial", "nit"],
      ],
    );
  });

  it("records only the configured severities, and counts what it dropped", () => {
    const raw = review_json([
      comment({ severity: "critical" }),
      comment({ severity: "major", filename: "a/b.mts" }),
      comment({ severity: "minor", filename: "c/d.mts" }),
      comment({ severity: "trivial", filename: "e/f.mts" }),
    ]);
    const [review] = parse_coderabbit_reviews(raw, { severities: DEFAULT_SEVERITIES });
    assert.deepEqual(review.findings.map((f) => f.raw_severity), ["critical", "major"]);
    assert.equal(review.filtered_out, 2);
  });

  it("skips a review that has not finished", () => {
    assert.deepEqual(parse_coderabbit_reviews(review_json([comment()], { status: "running" })), []);
  });

  it("returns nothing rather than throwing on junk", () => {
    assert.deepEqual(parse_coderabbit_reviews("not json"), []);
    assert.deepEqual(parse_coderabbit_reviews("{}"), []);
    assert.deepEqual(parse_coderabbit_reviews('[{"fileReviewMap":null}]'), []);
  });

  it("tolerates comments missing every optional field", () => {
    const raw = JSON.stringify([
      { status: "completed", fileReviewMap: { "x.mts": { comments: [{}, null, "junk"] } } },
    ]);
    const [review] = parse_coderabbit_reviews(raw);
    assert.equal(review.findings.length, 1);
    assert.equal(review.findings[0].severity, "medium");
  });
});

describe("load_reviews", () => {
  it("scans a directory, ignoring the extension's other state files", () => {
    const dir = scratch("store");
    // The filename is a content hash that rotates — nothing may depend on it.
    fs.writeFileSync(path.join(dir, "93e2b9d4.json"), review_json([comment()]), "utf-8");
    fs.writeFileSync(path.join(dir, "categories.json"), '{"default-reviewType":"review"}', "utf-8");
    fs.writeFileSync(path.join(dir, "21ddf08c.json"), "null", "utf-8");

    const reviews = load_reviews(dir);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].findings.length, 1);
    assert.ok(reviews[0].file.endsWith("93e2b9d4.json"));
  });

  it("accepts a single file as well as a directory", () => {
    const dir = scratch("store");
    const file = path.join(dir, "one.json");
    fs.writeFileSync(file, review_json([comment()]), "utf-8");
    assert.equal(load_reviews(file).length, 1);
  });

  it("orders reviews oldest first, so the last is the most recent", () => {
    const dir = scratch("store");
    fs.writeFileSync(
      path.join(dir, "old.json"),
      review_json([comment()], { endedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, "new.json"),
      review_json([comment()], { endedAt: "2026-09-09T00:00:00.000Z" }),
      "utf-8",
    );
    assert.deepEqual(
      load_reviews(dir).map((r) => r.ended_at),
      ["2026-01-01T00:00:00.000Z", "2026-09-09T00:00:00.000Z"],
    );
  });

  it("reads a missing path as no reviews", () => {
    assert.deepEqual(load_reviews(path.join(tmp_root, "nowhere")), []);
  });
});

describe("configuration", () => {
  it("defaults to recording critical and major only", () => {
    const { config } = load_config(scratch("repo"), { env: {} });
    assert.deepEqual(config.ingest?.coderabbit?.severities, ["critical", "major"]);
  });

  it("layers committed policy under machine-local paths", () => {
    const repo = scratch("repo");
    fs.writeFileSync(
      path.join(repo, "argus.config.json"),
      JSON.stringify({ ingest: { coderabbit: { severities: ["critical"] } } }),
      "utf-8",
    );
    fs.mkdirSync(path.join(repo, ".argus"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".argus", "config.json"),
      JSON.stringify({ ingest: { coderabbit: { path: "D:/store" } } }),
      "utf-8",
    );

    const { config, sources } = load_config(repo, { env: {} });
    assert.deepEqual(config.ingest?.coderabbit?.severities, ["critical"]); // committed policy
    assert.equal(config.ingest?.coderabbit?.path, "D:/store"); // local path
    assert.equal(sources.length, 2);
  });

  it("lets the environment override files, and arguments override the environment", () => {
    const repo = scratch("repo");
    fs.writeFileSync(
      path.join(repo, "argus.config.json"),
      JSON.stringify({ ingest: { coderabbit: { path: "from-file" } } }),
      "utf-8",
    );
    const env = { ARGUS_CODERABBIT_PATH: "from-env", ARGUS_CODERABBIT_SEVERITIES: "critical major" };

    assert.equal(load_config(repo, { env }).config.ingest?.coderabbit?.path, "from-env");
    assert.deepEqual(load_config(repo, { env }).config.ingest?.coderabbit?.severities, [
      "critical",
      "major",
    ]);
    assert.equal(
      load_config(repo, { env, overrides: { ingest: { coderabbit: { path: "from-flag" } } } })
        .config.ingest?.coderabbit?.path,
      "from-flag",
    );
  });

  it("does not let an unset flag erase a configured value", () => {
    const repo = scratch("repo");
    fs.writeFileSync(
      path.join(repo, "argus.config.json"),
      JSON.stringify({ ingest: { coderabbit: { path: "kept" } } }),
      "utf-8",
    );
    const { config } = load_config(repo, {
      env: {},
      overrides: { ingest: { coderabbit: { path: undefined, severities: ["minor"] } } },
    });
    assert.equal(config.ingest?.coderabbit?.path, "kept");
    assert.deepEqual(config.ingest?.coderabbit?.severities, ["minor"]);
  });

  it("reports a malformed config instead of throwing", () => {
    const repo = scratch("repo");
    fs.writeFileSync(path.join(repo, "argus.config.json"), "{ not json", "utf-8");
    const { problems, config } = load_config(repo, { env: {} });
    assert.equal(problems.length, 1);
    assert.deepEqual(config.ingest?.coderabbit?.severities, DEFAULT_SEVERITIES);
  });

  it("parses severity lists from either separator", () => {
    assert.deepEqual(parse_severities("critical, major"), ["critical", "major"]);
    assert.deepEqual(parse_severities("CRITICAL major"), ["critical", "major"]);
    assert.equal(parse_severities(""), undefined);
    assert.equal(parse_severities(undefined), undefined);
  });
});

describe("discovery", () => {
  /** A workspaceStorage tree, with each workspace declared as VS Code declares it. */
  function storage(
    workspaces: Array<{ hash: string; folder?: string; categories?: Record<string, string> }>,
  ): string {
    const appdata = scratch("appdata");
    const root = path.join(appdata, "Code", "User", "workspaceStorage");
    for (const ws of workspaces) {
      const dir = path.join(root, ws.hash);
      fs.mkdirSync(path.join(dir, "coderabbit.coderabbit-vscode"), { recursive: true });
      if (ws.folder) {
        fs.writeFileSync(
          path.join(dir, "workspace.json"),
          JSON.stringify({ folder: pathToFileURL(ws.folder).href }),
          "utf-8",
        );
      }
      if (ws.categories) {
        fs.writeFileSync(
          path.join(dir, "coderabbit.coderabbit-vscode", "categories.json"),
          JSON.stringify(ws.categories),
          "utf-8",
        );
      }
    }
    return appdata;
  }

  const repo = (name: string) => path.join(tmp_root, "checkouts", name);

  it("identifies a workspace by VS Code's own folder metadata", () => {
    const appdata = storage([
      { hash: "aaaa", folder: repo("my-app") },
      { hash: "bbbb", folder: repo("other") },
    ]);
    const found = discover_coderabbit_dirs(repo("my-app"), { APPDATA: appdata });
    assert.equal(found.length, 1);
    assert.ok(found[0].includes("aaaa"));
  });

  it("does not match a repo whose path is a prefix of another's", () => {
    // The live case this was written for: repos/argus and repos/argus-agent
    // both exist, and substring matching had the first discovering the
    // second's reviews — ingesting another project's findings into its memory.
    const appdata = storage([{ hash: "aaaa", folder: repo("argus-agent") }]);
    assert.deepEqual(discover_coderabbit_dirs(repo("argus"), { APPDATA: appdata }), []);
    assert.equal(discover_coderabbit_dirs(repo("argus-agent"), { APPDATA: appdata }).length, 1);
  });

  it("finds a workspace that has storage but no reviews yet", () => {
    // Also live: CodeRabbit creates its directory before the first review, and
    // categories.json then names no repo. Missing that reports "no store
    // found" for a workspace that is set up and simply idle.
    const appdata = storage([
      { hash: "aaaa", folder: repo("my-app"), categories: { "default-reviewType": "review" } },
    ]);
    assert.equal(discover_coderabbit_dirs(repo("my-app"), { APPDATA: appdata }).length, 1);
  });

  it("falls back to whole categories keys when workspace.json is absent", () => {
    const appdata = storage([
      { hash: "aaaa", categories: { [`${repo("my-app")}-reviewType`]: "review" } },
      { hash: "bbbb", categories: { [`${repo("my-app-two")}-reviewType`]: "review" } },
    ]);
    const found = discover_coderabbit_dirs(repo("my-app"), { APPDATA: appdata });
    assert.equal(found.length, 1);
    assert.ok(found[0].includes("aaaa"));
  });

  it("ignores a workspace with no CodeRabbit directory at all", () => {
    const appdata = scratch("appdata");
    fs.mkdirSync(path.join(appdata, "Code", "User", "workspaceStorage", "cccc"), {
      recursive: true,
    });
    assert.deepEqual(discover_coderabbit_dirs(repo("my-app"), { APPDATA: appdata }), []);
  });

  it("prefers configuration over discovery, and never searches when set", () => {
    const resolved = resolve_coderabbit_paths("C:\\repo", "D:/explicit", { APPDATA: "nope" });
    assert.deepEqual(resolved, { paths: ["D:/explicit"], discovered: false });
  });
});

describe("run_ingest", () => {
  /** A repo with one recorded Argus run over HEAD, and a CodeRabbit store. */
  function fixture(argus_verdict: string, comments = [comment()]) {
    const repo = scratch("repo");
    const store = scratch("store");
    fs.writeFileSync(path.join(store, "review.json"), review_json(comments), "utf-8");
    fs.mkdirSync(path.join(repo, ".argus"), { recursive: true });
    fs.writeFileSync(
      default_record_path(repo),
      JSON.stringify({
        timestamp: "2026-08-06T14:00:00.000Z",
        project: "app",
        commit: HEAD,
        verdict: argus_verdict,
      }) + "\n",
      "utf-8",
    );
    return { repo, store };
  }

  const run = (repo: string, store: string, over = {}) =>
    run_ingest({ repo_root: repo, project: "app", from: store, env: {}, ...over });

  it("joins on the commit and learns from what Argus missed", () => {
    const { repo, store } = fixture("- severity: low `src/perf/loop.mts` quadratic scan");
    const result = run(repo, store);

    assert.equal(result.reviews.length, 1);
    const entry = result.reviews[0];
    assert.equal(entry.matched_run?.commit, HEAD);
    assert.equal(entry.score?.missed, 1);
    assert.equal(entry.lessons.length, 1);
    assert.match(entry.lessons[0].text, /Look harder in src\/auth\/\*\* .*coderabbit raised/);

    // And it reached the store the next review will read.
    assert.equal(result.written, 1);
    assert.equal(new JsonlVectorDB(default_memory_path(repo)).size, 1);
  });

  it("learns nothing when Argus already found it", () => {
    const { repo, store } = fixture(
      "- severity: high `src/auth/token.mts:42` the token signature is never verified",
    );
    const result = run(repo, store);
    assert.equal(result.reviews[0].score?.agreed, 1);
    assert.equal(result.written, 0);
    assert.ok(!fs.existsSync(default_memory_path(repo)));
  });

  it("skips a review with no matching Argus run rather than treating it as all misses", () => {
    const { repo, store } = fixture("- severity: low `src/perf/loop.mts` quadratic scan");
    fs.writeFileSync(default_record_path(repo), "", "utf-8");

    const result = run(repo, store);
    assert.match(result.reviews[0].skipped_reason!, /no Argus run recorded for fa3cab20/);
    assert.equal(result.written, 0);
  });

  it("refuses to score a run whose verdict is empty", () => {
    // Seen live: an agy call returned successfully with no verdict text. Scored
    // naively that reads as recall=0%, and writes every one of the other
    // reviewer's findings into memory as an Argus miss.
    const { repo, store } = fixture("   \n  ");
    const result = run(repo, store);

    assert.match(result.reviews[0].skipped_reason!, /empty verdict/);
    assert.equal(result.reviews[0].matched_run, undefined);
    assert.equal(result.reviews[0].lessons.length, 0);
    assert.equal(result.written, 0);
    assert.ok(!fs.existsSync(default_memory_path(repo)));
  });

  it("writes nothing on a dry run", () => {
    const { repo, store } = fixture("- severity: low `src/perf/loop.mts` quadratic scan");
    const result = run(repo, store, { dry_run: true });
    assert.equal(result.reviews[0].lessons.length, 1);
    assert.equal(result.written, 0);
    assert.ok(!fs.existsSync(default_memory_path(repo)));
  });

  it("honours the configured severities and reports what they excluded", () => {
    const { repo, store } = fixture("", [
      comment({ severity: "minor" }),
      comment({ severity: "trivial", filename: "src/util/fmt.mts" }),
    ]);
    const result = run(repo, store);
    assert.equal(result.filtered_out, 2);
    assert.equal(result.written, 0);
  });

  it("reports a missing store instead of failing", () => {
    const { repo } = fixture("");
    const result = run(repo, path.join(tmp_root, "nowhere"));
    assert.deepEqual(result.reviews, []);
    assert.equal(result.written, 0);
  });

  it("distinguishes a path that is not there from a store with nothing in it", () => {
    // Both yield zero lessons, but only one is a misconfiguration — and a
    // misconfiguration must not read as "Argus missed nothing".
    const { repo } = fixture("");
    const absent = run(repo, path.join(tmp_root, "nowhere"));
    assert.equal(absent.missing_paths.length, 1);
    assert.match(format_ingest_report(absent), /does not exist/);

    const empty = run(repo, scratch("empty-store"));
    assert.deepEqual(empty.missing_paths, []);
    assert.match(format_ingest_report(empty), /no completed reviews yet/);
  });
});
