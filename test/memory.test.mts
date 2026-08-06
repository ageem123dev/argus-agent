/**
 * Tests for the durable memory layer.
 *
 * The two things that must hold: a lesson learned in one process is recalled
 * by the next, and a memory that cannot be read or written degrades to amnesia
 * rather than failing the review.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import {
  ArgusMemory,
  HierarchicalMemory,
  distill_lessons,
  score_overlap,
  tokenize,
} from "../src/memory.mjs";
import { JsonlVectorDB, default_memory_path } from "../src/memory_store.mjs";

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-memory-"));
after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

let counter = 0;
function tmp_file(): string {
  counter += 1;
  return path.join(tmp_root, `store-${counter}`, "memory.jsonl");
}

describe("tokenize / score_overlap", () => {
  it("splits paths into terms so diff headers can match a directory lesson", () => {
    assert.deepEqual(tokenize("a/src/auth/token.mts").sort(), ["auth", "token"]);
  });

  it("drops corpus-wide noise words", () => {
    assert.deepEqual(tokenize("diff --git index review severity"), []);
  });

  it("scores shared terms and ignores unrelated text", () => {
    const lesson = "[app] Look harder in src/auth/** for authentication and token handling.";
    assert.ok(score_overlap("diff --git a/src/auth/token.mts", lesson) > 0);
    assert.equal(score_overlap("unrelated payment ledger rounding", lesson), 0);
  });

  it("returns 0 rather than dividing by zero on an all-noise query", () => {
    assert.equal(score_overlap("the diff", "anything"), 0);
  });
});

describe("distill_lessons", () => {
  const verdict = [
    "## Findings",
    "1. **severity: high** — `src/auth/token.mts:42` calls jwt.decode instead of jwt.verify.",
    "2. severity=low  `src/util/fmt.mts` has an unused import.",
  ].join("\n");

  it("generalizes a finding to a directory and an issue class", () => {
    const [first] = distill_lessons(verdict, "app");
    assert.equal(first.locus, "src/auth/**");
    assert.equal(first.topic, "authentication and token handling");
    assert.equal(first.importance, 0.9);
  });

  it("phrases lessons as where to look, not what to report", () => {
    const [first] = distill_lessons(verdict, "app");
    assert.match(first.text, /^\[app\] Look harder in src\/auth\/\*\*/);
    // The specific defect must not survive into the next review's prompt.
    assert.doesNotMatch(first.text, /jwt\.decode/);
  });

  it("drops findings that generalize to nothing", () => {
    const offline =
      "[offline] Review summary:\n - severity=info  Offline mode; set the key for live reasoning.\n";
    assert.deepEqual(distill_lessons(offline, "app"), []);
  });

  it("keeps one lesson per locus+topic pair", () => {
    const repetitive = Array.from(
      { length: 5 },
      () => "- severity: high `src/auth/token.mts` token handling problem",
    ).join("\n");
    assert.equal(distill_lessons(repetitive, "app").length, 1);
  });

  it("caps how much one review can write", () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `- severity: high \`src/mod${i}/a.mts\` unhandled rejection`,
    ).join("\n");
    assert.equal(distill_lessons(many, "app").length, 5);
  });
});

describe("JsonlVectorDB", () => {
  it("recalls across processes", () => {
    const file = tmp_file();
    const first = new JsonlVectorDB(file);
    first.upsert({
      text: "[app] Look harder in src/auth/** for authentication and token handling.",
      metadata: { importance: 0.9, project: "app", source: "reflection" },
    });

    // A second instance is what the next `argus` invocation gets.
    const second = new JsonlVectorDB(file);
    const hits = second.search("diff --git a/src/auth/token.mts", 3, { project: "app" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].score, 0.9);
  });

  it("collapses a re-learned lesson instead of accumulating duplicates", () => {
    const file = tmp_file();
    const db = new JsonlVectorDB(file);
    for (let i = 0; i < 4; i++) {
      db.upsert({ text: "  Look harder in src/auth/**  ", metadata: { importance: 0.6 } });
    }
    assert.equal(db.size, 1);
    assert.equal(db.records()[0].seen, 4);
  });

  it("does not count merely recalling a lesson as re-learning it", () => {
    const file = tmp_file();
    const db = new JsonlVectorDB(file);
    db.upsert({ text: "Look harder in src/auth/**", metadata: { source: "reflection" } });
    db.upsert({ text: "Look harder in src/auth/**", metadata: { source: "longterm_retrieval" } });
    assert.equal(db.records()[0].seen, 1);
    assert.equal(db.records()[0].source, "reflection");
  });

  it("keeps the strongest importance a lesson has ever carried", () => {
    const file = tmp_file();
    const db = new JsonlVectorDB(file);
    db.upsert({ text: "Look harder in src/auth/**", metadata: { importance: 0.9 } });
    db.upsert({ text: "Look harder in src/auth/**", metadata: { importance: 0.4 } });
    assert.equal(db.records()[0].importance, 0.9);
  });

  it("scopes recall to the project, and keeps unscoped lessons visible", () => {
    const file = tmp_file();
    const db = new JsonlVectorDB(file);
    db.upsert({ text: "Look harder in src/auth/** here", metadata: { project: "app" } });
    db.upsert({ text: "Look harder in src/auth/** elsewhere", metadata: { project: "other" } });
    const hits = db.search("src/auth", 5, { project: "app" });
    assert.deepEqual(
      hits.map((h) => h.text),
      ["Look harder in src/auth/** here"],
    );
  });

  it("survives a half-written line from a killed process", () => {
    const file = tmp_file();
    const db = new JsonlVectorDB(file);
    db.upsert({ text: "Look harder in src/auth/** for token handling", metadata: {} });
    fs.appendFileSync(file, '{"text":"truncated', "utf-8");

    const reopened = new JsonlVectorDB(file);
    assert.equal(reopened.size, 1);
    assert.equal(reopened.search("token handling", 3).length, 1);
  });

  it("compacts the log and drops the weakest once over budget", () => {
    const file = tmp_file();
    const db = new JsonlVectorDB(file, { max_records: 3, compaction_ratio: 100 });
    for (let i = 0; i < 6; i++) {
      db.upsert({ text: `lesson about module${i} handling`, metadata: { importance: i / 10 } });
    }
    assert.equal(db.size, 3);
    const on_disk = fs.readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(on_disk.length, 3);
    // Highest importance survives, lowest is gone.
    assert.ok(db.records().some((r) => r.text.includes("module5")));
    assert.ok(!db.records().some((r) => r.text.includes("module0")));
  });

  it("degrades to amnesia rather than throwing when the file is unwritable", () => {
    // A directory where the file should be: every read and write fails.
    const dir = path.join(tmp_root, "blocked", "memory.jsonl");
    fs.mkdirSync(dir, { recursive: true });

    const db = new JsonlVectorDB(dir);
    assert.doesNotThrow(() => db.upsert({ text: "Look harder in src/auth/**", metadata: {} }));
    assert.doesNotThrow(() => db.search("src/auth"));
    assert.ok(db.last_error, "the failure should be reported, not silently swallowed");
  });

  it("puts the store next to the run records", () => {
    assert.equal(
      default_memory_path("/repo"),
      path.join(path.resolve("/repo"), ".argus", "memory.jsonl"),
    );
  });
});

describe("ArgusMemory", () => {
  it("carries a lesson from one review's verdict into the next review's recall", () => {
    const file = tmp_file();
    const verdict =
      "- **severity: high** `src/auth/token.mts:42` calls jwt.decode instead of jwt.verify.";

    const first = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(file)));
    const stored = first.after_review(verdict, "app");
    assert.equal(stored.length, 1);

    const next = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(file)));
    const recalled = next.before_review("app", "diff --git a/src/auth/token.mts b/src/auth/token.mts");
    assert.equal(recalled.length, 1);
    assert.match(recalled[0], /Look harder in src\/auth\/\*\*/);
  });

  it("reports which store is in use, so amnesia is visible", () => {
    assert.equal(new ArgusMemory().trace.store, "InMemoryVectorDB");
    assert.equal(
      new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(tmp_file()))).trace.store,
      "JsonlVectorDB",
    );
  });

  it("recalls nothing on a fresh in-memory store — the pre-existing behaviour", () => {
    assert.deepEqual(new ArgusMemory().before_review("app", "diff --git a/src/auth/x.mts"), []);
  });
});
