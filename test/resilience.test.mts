/**
 * The ladder that replaces retrying the same request twice.
 *
 * What matters here is that each rung is a *different* request, that a
 * recovered review says so, and that exhausting the ladder fails rather than
 * inventing a clean result.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ArgusReasoning, EmptyReviewError, ReviewResult } from "../src/reasoning.mjs";
import {
  CONTEXT_MARKER,
  ResilientReasoning,
  default_ladder,
  diff_only,
  type Rung,
} from "../src/resilience.mjs";

const DIFF = "--- a/x\n+++ b/x\n@@\n+const a = 1;";
const AUGMENTED = DIFF + CONTEXT_MARKER + "### src/x.mts\n```\nwhole file body\n```";

/** A rung that records what it was asked and answers however it is told. */
function rung(label: string, answer: string | Error, seen: string[] = []): Rung & { seen: string[] } {
  const reasoning = new ArgusReasoning(null);
  reasoning.review = async (d: string) => {
    seen.push(d);
    if (answer instanceof Error) throw answer;
    return new ReviewResult(answer, [], 0.9, "complex");
  };
  return { label, reasoning, seen };
}

/** No real waiting, but prove the ladder asked to wait. */
function fake_sleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("a ladder that recovers", () => {
  it("returns the first rung's review without touching the rest", async () => {
    const first = rung("primary", "A real review.");
    const second = rung("backup", "should not be reached");
    const ladder = new ResilientReasoning([first, second], fake_sleep());

    const result = await ladder.review(AUGMENTED);
    assert.equal(result.verdict, "A real review.");
    assert.equal(second.seen.length, 0, "a working first rung must cost nothing extra");
    assert.equal(result.fallback, undefined, "an unrecovered review has no fallback record");
  });

  it("sends a genuinely lighter request on the second attempt", async () => {
    // The whole point. The retry this replaces sent the identical request, so
    // a failure driven by request weight had the same odds the second time.
    const seen: string[] = [];
    const reasoning = new ArgusReasoning(null);
    let n = 0;
    reasoning.review = async (d: string) => {
      seen.push(d);
      if (++n === 1) throw new EmptyReviewError("empty");
      return new ReviewResult("Recovered review.", [], 0.9, "complex");
    };
    const ladder = new ResilientReasoning(
      default_ladder({ label: "plugin", reasoning }),
      fake_sleep(),
    );

    const result = await ladder.review(AUGMENTED);
    assert.equal(result.verdict, "Recovered review.");
    assert.equal(seen.length, 2);
    assert.ok(seen[0].includes("whole file body"), "the first attempt carries the context");
    assert.ok(!seen[1].includes("whole file body"), "the second must not");
    assert.equal(seen[1], DIFF, "the second attempt is the diff alone");
    assert.ok(seen[1].length < seen[0].length, "lighter, not merely different");
  });

  it("names what answered, so the record cannot misattribute it", async () => {
    const ladder = new ResilientReasoning(
      [rung("primary", new EmptyReviewError("nothing came back")), rung("backup", "Backup review.")],
      fake_sleep(),
    );

    const result = await ladder.review(AUGMENTED);
    assert.equal(result.verdict, "Backup review.");
    assert.equal(result.fallback?.attempted, "primary");
    assert.equal(result.fallback?.used, "backup");
    assert.equal(result.fallback?.attempts, 2);
    assert.match(result.fallback!.reason, /nothing came back/);
  });

  it("waits before each retry rather than firing again immediately", async () => {
    // An upstream incident needs time more than another instant request.
    const clock = fake_sleep();
    const ladder = new ResilientReasoning(
      [rung("a", new EmptyReviewError("x")), rung("b", new EmptyReviewError("y")), rung("c", "ok")],
      { ...clock, backoff_ms: 1500 },
    );

    await ladder.review(AUGMENTED);
    assert.deepEqual(clock.waits, [1500, 1500], "one wait before each attempt after the first");
  });

  it("treats an empty verdict as a failure, not an answer", async () => {
    // A rung can return successfully and say nothing; that is silence, and
    // silence reads as a clean review to everything downstream.
    const ladder = new ResilientReasoning(
      [rung("silent", "   \n  "), rung("backup", "A real review.")],
      fake_sleep(),
    );
    const result = await ladder.review(AUGMENTED);
    assert.equal(result.verdict, "A real review.");
    assert.equal(result.fallback?.used, "backup");
  });
});

describe("a ladder that runs out", () => {
  it("fails loudly rather than inventing a clean review", async () => {
    const ladder = new ResilientReasoning(
      [rung("a", new EmptyReviewError("first")), rung("b", new EmptyReviewError("second"))],
      fake_sleep(),
    );

    await assert.rejects(
      () => ladder.review(AUGMENTED),
      (e: unknown) =>
        e instanceof EmptyReviewError &&
        /failed review, not a clean one/i.test(e.message) &&
        /first/.test(e.message) &&
        /second/.test(e.message),
      "the failure must name every rung it tried",
    );
  });

  it("tries every rung, because a later one may be a different provider", async () => {
    const a = rung("a", new Error("binary missing"));
    const b = rung("b", new Error("also missing"));
    const c = rung("c", "A review from elsewhere.");
    const ladder = new ResilientReasoning([a, b, c], fake_sleep());

    const result = await ladder.review(AUGMENTED);
    assert.equal(result.verdict, "A review from elsewhere.");
    assert.equal(result.fallback?.used, "c");
  });

  it("refuses to be built with no rungs at all", () => {
    assert.throws(() => new ResilientReasoning([]), /at least one rung/);
  });
});

describe("diff_only", () => {
  it("cuts the gathered context and keeps the change", () => {
    assert.equal(diff_only(AUGMENTED), DIFF);
  });

  it("leaves a prompt that never had context alone", () => {
    assert.equal(diff_only(DIFF), DIFF);
  });
});

describe("the default ladder", () => {
  it("retries the same provider lighter before changing provider", () => {
    const primary = { label: "plugin", reasoning: new ArgusReasoning(null) };
    const alternate = { label: "gemini", reasoning: new ArgusReasoning(null) };

    assert.deepEqual(
      default_ladder(primary, alternate).map((r) => r.label),
      ["plugin", "plugin (diff only)", "gemini"],
    );
    // Changing provider is last: it is the rung most likely to be unconfigured.
    assert.deepEqual(
      default_ladder(primary).map((r) => r.label),
      ["plugin", "plugin (diff only)"],
    );
  });
});
