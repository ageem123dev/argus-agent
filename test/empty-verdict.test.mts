/**
 * An empty review is a failure, and must be impossible to mistake for a clean one.
 *
 * Three real runs against PayUp on 2026-09-02 produced a zero-length verdict,
 * exited 0, and appended a record whose every health field said the review had
 * gone fine. The fields were not lying about those runs specifically — measured
 * over all 103 records, `reflection.final_score` was 1 and `converged` was true
 * every single time. They could not report a failure because they could not
 * report anything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ArgusReasoning, EmptyReviewError } from "../src/reasoning.mjs";
import { ArgusReflection, count_findings } from "../src/reflection.mjs";
import { build_run_record } from "../src/run_record.mjs";
import { ReviewOutcome } from "../src/argus.mjs";
import { ReviewResult } from "../src/reasoning.mjs";
import { PerceptionTrace } from "../src/perception.mjs";

/** A client that answers with `text` to everything. */
function client_saying(text: string) {
  return { messages: { create: async () => ({ content: [{ text }] }) } };
}

/** Diffs sized to land on each of the three routed tiers. */
const TINY = "one line\n";
const BIG = "x\n".repeat(400);

describe("a provider that answers with nothing", () => {
  it("is refused rather than turned into a verdict", async () => {
    // Whatever tier the classifier picks, silence must not become a review.
    for (const diff of [TINY, BIG]) {
      await assert.rejects(
        () => new ArgusReasoning(client_saying("")).review(diff),
        (e: unknown) => e instanceof EmptyReviewError,
        `a ${diff.length}-char diff must not yield an empty review`,
      );
    }
  });

  it("is refused when it answers with only whitespace", async () => {
    await assert.rejects(
      () => new ArgusReasoning(client_saying("   \n\t  ")).review(BIG),
      (e: unknown) => e instanceof EmptyReviewError,
    );
  });

  it("says the review failed rather than that the code was clean", async () => {
    // The message is what a human reads in the terminal; it must not be
    // mistakable for a passing review.
    await assert.rejects(
      () => new ArgusReasoning(client_saying("")).review(BIG),
      (e: unknown) => e instanceof Error && /failed review, not a clean one/i.test(e.message),
    );
  });

  it("still returns a real answer unchanged", async () => {
    const result = await new ArgusReasoning(client_saying("Found one problem.")).review(BIG);
    assert.match(result.verdict, /Found one problem\./);
  });
});

describe("the critic", () => {
  it("refuses to score an empty review at all, let alone perfectly", () => {
    // The score is the fraction of findings that survive scrutiny. With no
    // findings there is nothing to disbelieve, so an empty verdict scored 1.0
    // and was approved — silence was the highest-quality review possible.
    const c = new ArgusReflection().critique_review("");
    assert.equal(c.score, 0);
    assert.equal(c.approved, false);
    assert.match(c.feedback_text, /empty/i);
  });

  it("counts findings in the format verdicts are actually written in", () => {
    // Structured providers render `- **[high]** path — issue`. Counting the
    // literal word "severity" saw zero findings in 101 of 103 real verdicts.
    const rendered =
      "Summary.\n\n## Findings\n" +
      "- **[high]** src/a.mts:4 — unchecked input\n" +
      "- **[low]** src/b.mts:9 — naming\n";
    assert.equal(count_findings(rendered), 2);
    // The prose spelling stays supported for the Anthropic path.
    assert.equal(count_findings("severity: high — something"), 1);
    assert.equal(count_findings("No issues found."), 0);
  });

  it("still approves a genuinely clean review", () => {
    // "Clean" and "empty" are different, and only one of them is a failure.
    const c = new ArgusReflection().critique_review("No issues found in this change.");
    assert.ok(c.approved, "a clean review must still pass");
  });
});

describe("the run record", () => {
  function record_for(verdict: string) {
    const review = new ReviewResult(verdict, [], 0.9, "complex");
    const outcome = new ReviewOutcome(review, new PerceptionTrace());
    return build_run_record(outcome, {
      project: "p",
      repo_root: ".",
      provider: "plugin",
      provider_requested: "plugin",
      invoked_via: "cli",
      calls: [],
    } as never);
  }

  it("says outright whether a review happened", () => {
    // The only field that answers that question. audit_chain_ok is hash
    // integrity, selectivity is budget fit, and the reflection score was 1.0
    // on all 103 records written before this field existed.
    assert.equal(record_for("A real verdict.").ok, true);
    assert.equal(record_for("").ok, false);
    assert.equal(record_for("   \n ").ok, false, "whitespace is not a review");
  });
});

describe("a response whose first block is not the answer", () => {
  it("is read as a review, not rejected as empty", async () => {
    // The COMPLEX tier sends thinking: {type: "adaptive"}, and the SDK then
    // returns a thinking block ahead of the text. Reading content[0] found no
    // text there and threw EmptyReviewError over a perfectly good review — the
    // guard rejecting exactly the tier it was meant to protect.
    const client = {
      messages: {
        create: async () => ({
          content: [
            { type: "thinking", thinking: "weighing the diff" },
            { type: "text", text: "One high-severity issue in auth." },
          ],
        }),
      },
    };
    const result = await new ArgusReasoning(client).review("x\n".repeat(400));
    assert.match(result.verdict, /One high-severity issue in auth\./);
  });

  it("still refuses when every block is a thinking block", async () => {
    const client = {
      messages: {
        create: async () => ({ content: [{ type: "thinking", thinking: "hmm" }] }),
      },
    };
    await assert.rejects(
      () => new ArgusReasoning(client).review("x\n".repeat(400)),
      (e: unknown) => e instanceof EmptyReviewError,
      "thinking alone is not a review",
    );
  });

  it("joins several text blocks rather than taking the first", async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [
            { type: "text", text: "First half. " },
            { type: "text", text: "Second half." },
          ],
        }),
      },
    };
    const result = await new ArgusReasoning(client).review("x\n".repeat(400));
    assert.equal(result.verdict, "First half. Second half.");
  });
});

describe("the finding counter", () => {
  it("counts whole list items, not any mention of the format", () => {
    // A clean review that explains the format was counted as having findings,
    // and could then be rejected when tool evidence said the tests passed.
    assert.equal(count_findings("All clean. Use **[high]** markers when reporting."), 0);
    assert.equal(count_findings("- **[high]** a.mts:4 — real finding"), 1);
  });

  it("falls back to `severity:`, not the bare word the prompt itself uses", () => {
    // "List up to 3 issues, severity-tagged" is in the prompt, so a verdict
    // echoing it would otherwise count as a finding.
    assert.equal(count_findings("List up to 3 issues, severity-tagged. Nothing found."), 0);
    assert.equal(count_findings("One issue, severity: high in a.mts"), 1);
  });
});
