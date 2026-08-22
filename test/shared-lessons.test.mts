/**
 * Tests for lessons pooled across projects.
 *
 * The premise: a locus is repo-relative and does not travel, but a (language,
 * topic) pair does. These pin that the pool carries only the portable half, and
 * that it can never displace a lesson about the code actually under review.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { ArgusMemory, HierarchicalMemory, seed_shared, shared_prior } from "../src/memory.mjs";
import { JsonlVectorDB } from "../src/memory_store.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argus-shared-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (name: string) => path.join(tmp, `${name}-${(n += 1)}.jsonl`);

const TS_FINDING = "- **[high]** `src/auth/token.ts:4` — jwt.decode does not verify the signature.";

describe("what travels between projects", () => {
  it("keeps the language and the topic, drops the place", () => {
    const prior = shared_prior({
      text: "[a] Look harder in TypeScript under src/auth/** for authentication and token handling.",
      importance: 0.9,
      locus: "src/auth/**",
      topic: "authentication and token handling",
      language: "typescript",
    });
    assert.ok(prior);
    assert.match(prior.text, /TypeScript/);
    assert.match(prior.text, /authentication and token handling/);
    assert.doesNotMatch(prior.text, /src\/auth/, "a repo-relative place must not travel");
  });

  it("carries nothing when there is no topic", () => {
    // A lesson that only knows where is evidence about one repo, not the team.
    assert.equal(
      shared_prior({ text: "x", importance: 0.9, locus: "src/**", language: "typescript" }),
      undefined,
    );
  });
});

describe("a pooled prior never outranks a local lesson", () => {
  it("fills only the slots local memory did not claim", () => {
    const pool = new JsonlVectorDB(file("pool"));
    for (const topic of ["error handling", "input validation", "concurrency"]) {
      pool.upsert({
        text: `Across projects, TypeScript changes have repeatedly had ${topic} problems.`,
        metadata: { language: "typescript", importance: 0.9 },
      });
    }
    const local = file("local");
    new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(local))).after_review(TS_FINDING, "p2");

    const mem = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(local)), pool);
    const got = mem.before_review("p2", ["src/auth/token.ts"]);

    assert.match(got[0], /Look harder/, "the local, placed lesson comes first");
    assert.equal(mem.trace.from_shared.length, got.length - 1);
    assert.ok(got.length <= 3);
  });

  it("yields no slot at all when local memory fills every one", () => {
    // The guarantee in its strongest form: a repo with its own history should
    // never be told about another project instead of about itself.
    const pool = new JsonlVectorDB(file("pool"));
    pool.upsert({
      text: "Across projects, TypeScript changes have repeatedly had concurrency problems.",
      metadata: { language: "typescript", importance: 0.99 },
    });
    const local = file("local");
    const seed = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(local)));
    seed.after_review(
      [
        // Distinct places, because topic classification reads the whole line
        // — four findings under one directory all classify alike and collapse
        // into a single lesson.
        "- **[high]** `src/auth/token.ts:4` — unverified jwt.",
        "- **[high]** `src/jobs/worker.ts:9` — a race on retry.",
        "- **[high]** `src/api/upload.ts:2` — unchecked bounds.",
        "- **[high]** `src/db/pool.ts:7` — an unclosed handle.",
      ].join("\n"),
      "p",
    );

    const mem = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(local)), pool);
    const got = mem.before_review("p", ["src/auth/token.ts"]);
    assert.equal(got.length, 3);
    assert.deepEqual(mem.trace.from_shared, [], "no room for a prior, and none taken");
  });

  it("gives a project with no history something to go on", () => {
    // The case that motivated this: a repo that has never run Argus.
    const pool = new JsonlVectorDB(file("pool"));
    pool.upsert({
      text: "Across projects, TypeScript changes have repeatedly had error handling problems.",
      metadata: { language: "typescript", importance: 0.9 },
    });
    const mem = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(file("empty"))), pool);
    const got = mem.before_review("brand-new", ["src/api/orders.ts"]);
    assert.equal(got.length, 1);
    assert.match(got[0], /Across projects/);
  });

  it("selects priors by evidence, not by resembling a path", () => {
    // A prior carries no place, so it shares no tokens with a query made of
    // changed paths. Ranking by keyword overlap returned nothing at all, and
    // the pool looked empty to every review.
    const pool = new JsonlVectorDB(file("pool"));
    pool.upsert({
      text: "Across projects, TypeScript changes have repeatedly had concurrency problems.",
      metadata: { language: "typescript", importance: 0.9 },
    });
    const mem = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(file("empty"))), pool);
    assert.equal(
      mem.before_review("p", ["totally/unrelated/path.ts"]).length,
      1,
      "a prior must be reachable from a query it shares no words with",
    );
  });

  it("does not hand a Python change a TypeScript prior", () => {
    const pool = new JsonlVectorDB(file("pool"));
    pool.upsert({
      text: "Across projects, TypeScript changes have repeatedly had concurrency problems.",
      metadata: { language: "typescript", importance: 0.9 },
    });
    const mem = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(file("empty"))), pool);
    assert.deepEqual(mem.before_review("p", ["svc/worker.py"]), []);
  });

  it("stays exactly as it was when no pool is configured", () => {
    const local = file("local");
    new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(local))).after_review(TS_FINDING, "p");
    const mem = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(local)));
    const got = mem.before_review("p", ["src/auth/token.ts"]);
    assert.equal(got.length, 1);
    assert.deepEqual(mem.trace.from_shared, []);
  });
});

describe("seeding a pool from a repo that already has history", () => {
  it("carries the portable lessons and reports what it left behind", () => {
    const local = new JsonlVectorDB(file("local"));
    const mem = new ArgusMemory(new HierarchicalMemory(local));
    mem.after_review(TS_FINDING, "p");
    mem.after_review("- **[high]** `docs/setup.md:2` — a step is missing.", "p");

    const pool = new JsonlVectorDB(file("pool"));
    const { contributed, skipped } = seed_shared(local, pool);
    assert.ok(contributed >= 1);
    assert.equal(contributed + skipped, local.size);
    assert.ok(pool.records().every((r) => !r.locus && !r.project));
  });

  it("is idempotent — re-seeding confirms rather than duplicates", () => {
    const local = new JsonlVectorDB(file("local"));
    new ArgusMemory(new HierarchicalMemory(local)).after_review(TS_FINDING, "p");
    const pool = new JsonlVectorDB(file("pool"));
    seed_shared(local, pool);
    const once = pool.size;
    seed_shared(local, pool);
    assert.equal(pool.size, once, "the same prior must not become two");
  });
});
