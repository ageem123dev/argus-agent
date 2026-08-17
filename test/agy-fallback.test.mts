/**
 * Tests for degrading instead of losing the review.
 *
 * The single-call path fails hard on large diffs — six consecutive reviews of a
 * 24-file change produced either an empty SUCCESS or a non-zero exit, while the
 * shim answered the identical diff immediately. These pin what happens next.
 *
 * agy is injected rather than executed: the behaviours worth pinning are what
 * Argus does with an envelope, and a real CLI cannot be made to return an empty
 * SUCCESS on demand.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgyError,
  AntigravityReasoning,
  AutoAntigravityReasoning,
  type AgyEnvelope,
  AntigravityClient,
  AGY_ROUTING,
  resolve_route,
  tier_for_size,
} from "../src/providers/antigravity.mjs";
import { parse_findings } from "../src/findings.mjs";
import { ArgusReasoning, ReviewResult, ROUTING_TABLE, Complexity, deepest } from "../src/reasoning.mjs";

const BIG_DIFF = "diff --git a/x b/x\n" + "+line\n".repeat(400);

const envelope = (over: Partial<AgyEnvelope> = {}): AgyEnvelope => ({
  conversation_id: "conv-1",
  status: "SUCCESS",
  response: "",
  duration_seconds: 1,
  num_turns: 1,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
  ...over,
});

/** An agy that returns SUCCESS carrying nothing — the observed failure. */
function empty_agy() {
  const calls: string[] = [];
  return {
    calls,
    run: async (_p: string, model: string) => {
      calls.push(model);
      return envelope();
    },
  };
}

/** A stand-in for the shim, which is known to answer these diffs. */
function working_fallback(verdict = "## Findings\n- **[high]** src/a.ts:1 — real.") {
  const calls: string[] = [];
  const reasoning = new ArgusReasoning(null);
  reasoning.review = async () => {
    calls.push("shim");
    return new ReviewResult(verdict, [], 0.8, "complex", "complex");
  };
  return { calls, reasoning };
}

describe("empty responses are retried, not lost", () => {
  it("retries once when agy returns nothing, then reports it", async () => {
    const agy = empty_agy();
    const reasoning = new AntigravityReasoning({}, undefined, {
      empty_retries: 1,
      run: agy.run as never,
    });

    await assert.rejects(
      () => reasoning.review(BIG_DIFF),
      (e: unknown) => e instanceof AgyError && e.kind === "empty",
    );
    assert.equal(agy.calls.length, 2, "one call plus one retry");
  });

  it("succeeds on the retry when the second call answers", async () => {
    let n = 0;
    const reasoning = new AntigravityReasoning({}, undefined, {
      empty_retries: 1,
      run: (async () => {
        n += 1;
        return n === 1 ? envelope() : envelope({ response: "a real prose review" });
      }) as never,
    });

    const result = await reasoning.review(BIG_DIFF);
    assert.equal(result.verdict, "a real prose review");
    assert.equal(n, 2);
  });

  it("explicit antigravity makes exactly one call and does not retry", async () => {
    // `provider: "antigravity"` is documented as one agy call per review; the
    // retry belongs to auto, not to it.
    const agy = empty_agy();
    const reasoning = new AntigravityReasoning({}, undefined, { run: agy.run as never });

    await assert.rejects(() => reasoning.review(BIG_DIFF), AgyError);
    assert.equal(agy.calls.length, 1, "no retry without opting in");
  });

  it("does not retry a request that was rejected", async () => {
    // A rejected request is rejected identically the second time; only an
    // ignored one is worth resending.
    const calls: string[] = [];
    const reasoning = new AntigravityReasoning({}, undefined, {
      empty_retries: 1,
      run: (async () => {
        calls.push("x");
        throw new AgyError("agy failed: Command failed: agy.exe -p ...", "failed");
      }) as never,
    });

    await assert.rejects(() => reasoning.review(BIG_DIFF), AgyError);
    assert.equal(calls.length, 1, "an argument error must fail fast");
  });
});

describe("auto degrades instead of throwing the review away", () => {
  it("falls back to the shim when the single call stays empty", async () => {
    const agy = empty_agy();
    const shim = working_fallback();
    const auto = new AutoAntigravityReasoning(
      {},
      new AntigravityReasoning({}, undefined, { empty_retries: 1, run: agy.run as never }),
      shim.reasoning,
    );

    const result = await auto.review(BIG_DIFF);
    assert.match(result.verdict, /real/, "a real review, not a synthesised one");
    assert.equal(agy.calls.length, 2, "primary tried twice first");
    assert.equal(shim.calls.length, 1);
  });

  it("names the path that actually answered", async () => {
    const shim = working_fallback();
    const auto = new AutoAntigravityReasoning(
      {},
      new AntigravityReasoning({}, undefined, { empty_retries: 1, run: empty_agy().run as never }),
      shim.reasoning,
    );

    const { fallback } = await auto.review(BIG_DIFF);
    assert.ok(fallback, "a fallback review must be identifiable as one");
    assert.equal(fallback.attempted, "antigravity");
    assert.equal(fallback.used, "antigravity-shim");
    assert.equal(fallback.attempts, 2);
    assert.match(fallback.reason, /neither structured output nor prose/);
  });

  it("falls back on a non-zero exit too, without retrying it", async () => {
    const calls: string[] = [];
    const shim = working_fallback();
    const auto = new AutoAntigravityReasoning(
      {},
      new AntigravityReasoning({}, undefined, {
        empty_retries: 1,
        run: (async () => {
          calls.push("x");
          throw new AgyError("agy failed: Command failed", "failed");
        }) as never,
      }),
      shim.reasoning,
    );

    const result = await auto.review(BIG_DIFF);
    assert.equal(calls.length, 1, "rejected requests are not resent");
    assert.equal(result.fallback?.attempts, 1);
    assert.equal(shim.calls.length, 1);
  });

  it("does not fall back when the binary is missing", async () => {
    // Every path runs the same binary, so a fallback would only fail twice.
    const shim = working_fallback();
    const auto = new AutoAntigravityReasoning(
      {},
      new AntigravityReasoning({}, undefined, {
        run: (async () => {
          throw new AgyError("agy not found at ...", "unavailable");
        }) as never,
      }),
      shim.reasoning,
    );

    await assert.rejects(
      () => auto.review(BIG_DIFF),
      (e: unknown) => e instanceof AgyError && e.kind === "unavailable",
    );
    assert.equal(shim.calls.length, 0, "must not spend a fallback on a missing binary");
  });

  it("propagates rather than synthesising when the fallback also fails", async () => {
    // The empty-verdict guard's reasoning: a manufactured "no findings" is
    // indistinguishable from a clean diff and would be recorded as a real run.
    const failing = new ArgusReasoning(null);
    failing.review = async () => {
      throw new AgyError("shim failed too", "failed");
    };
    const auto = new AutoAntigravityReasoning(
      {},
      new AntigravityReasoning({}, undefined, { run: empty_agy().run as never }),
      failing,
    );

    await assert.rejects(() => auto.review(BIG_DIFF), /shim failed too/);
  });
});

describe("the fallback keeps the reasoning model", () => {
  /** The agy model a request actually resolves to, observed at the spawn seam. */
  async function model_for(req: { model: string; thinking?: unknown }): Promise<string> {
    let used = "";
    const client = new AntigravityClient(
      {},
      { "claude-sonnet-4-6": "gemini-3.6-flash-high" },
      "gemini-3.1-pro-high",
      (async (_p: string, model: string) => {
        used = model;
        return envelope({ response: "ok" });
      }) as never,
    );
    await client.messages.create({ ...req, messages: [{ role: "user", content: "x" }] });
    return used;
  }

  it("sends a deep-reasoning turn to the complex model, not flash", async () => {
    // ROUTING_TABLE gives moderate and complex the same Claude slug and
    // separates them by reasoning budget, so mapping on the slug alone
    // collapsed them — the shim answered the hardest changes on flash.
    const asked: Array<{ thinking: boolean; model: string }> = [];
    const client = {
      messages: {
        create: async (req: { model: string; thinking?: unknown; messages: Array<{ content: string }> }) => {
          const classifying = /Classify the complexity/.test(req.messages?.[0]?.content ?? "");
          asked.push({ thinking: Boolean(req.thinking), model: req.model });
          return { content: [{ text: classifying ? "complex" : "Final answer: reviewed." }] };
        },
      },
    };

    await new ArgusReasoning(client as never).review("x\n".repeat(400));
    const deep = asked.find((a) => a.thinking);
    assert.ok(deep, "the complex tier must ask for a deep-reasoning turn");
    assert.equal(deep.model, "claude-sonnet-4-6");
  });

  it("routes on the reasoning budget, since the slug cannot tell the tiers apart", async () => {
    assert.equal(await model_for({ model: "claude-sonnet-4-6" }), "gemini-3.6-flash-high");
    assert.equal(
      await model_for({ model: "claude-sonnet-4-6", thinking: { type: "adaptive" } }),
      "gemini-3.1-pro-high",
      "a deep-reasoning turn must not be answered on flash",
    );
  });

  it("agrees with the single-call path at the complex tier", () => {
    // The two tables disagreed at exactly the tier that matters: the primary
    // used gemini-3.1-pro-high and its own fallback used flash.
    assert.equal(AGY_ROUTING[Complexity.COMPLEX], "gemini-3.1-pro-high");
    assert.equal(ROUTING_TABLE[Complexity.COMPLEX].thinking?.type, "adaptive");
    assert.equal(
      ROUTING_TABLE[Complexity.COMPLEX].model,
      ROUTING_TABLE[Complexity.MODERATE].model,
      "the slug alone cannot distinguish them — which is why routing reads `thinking`",
    );
  });
});

describe("the fallback notice reports what actually happened", () => {
  it("counts the attempts the primary really spent, not the default budget", async () => {
    // `attempts` was inferred from the failure kind, which is only right for the
    // default retry budget. build_run_record writes it straight into the run
    // record, so a guessed call count is wrong exactly where ingestion reads it.
    const shim = working_fallback();
    const auto = new AutoAntigravityReasoning(
      {},
      new AntigravityReasoning({}, undefined, {
        empty_retries: 3, // not the default
        run: empty_agy().run as never,
      }),
      shim.reasoning,
    );

    const { fallback } = await auto.review(BIG_DIFF);
    assert.equal(fallback?.attempts, 4, "one call plus three retries");
  });

  it("labels the primary it was actually given", async () => {
    const shim = working_fallback();
    const auto = new AutoAntigravityReasoning(
      {},
      new AntigravityReasoning({}, undefined, { run: empty_agy().run as never }),
      shim.reasoning,
      "custom-primary",
      "custom-fallback",
    );

    const { fallback } = await auto.review(BIG_DIFF);
    assert.equal(fallback?.attempted, "custom-primary");
    assert.equal(fallback?.used, "custom-fallback");
  });
});

describe("resolving what `auto` means", () => {
  it("names the provider that will answer, never the request itself", async () => {
    // The MCP path left `route` as the literal "auto", so a successful
    // automatic review recorded a provider that names nothing — and disagreed
    // with the CLI record for the same run. `provider` is meant to say what
    // answered.
    const d = await resolve_route("auto", { available: async () => true });
    assert.equal(d.route, "antigravity", "a record must name a provider, not a request");
    assert.equal(d.auto, true, "but the degrading path is still what gets constructed");
  });

  it("degrades by availability before any call is made", async () => {
    assert.deepEqual(
      await resolve_route("auto", { available: async () => false, anthropic_key: true }),
      { route: "anthropic", auto: true },
    );
    assert.deepEqual(
      await resolve_route("auto", { available: async () => false, anthropic_key: false }),
      { route: "offline", auto: true },
    );
  });

  it("leaves an explicit provider alone, and never marks it auto", async () => {
    for (const p of ["antigravity", "antigravity-shim", "anthropic", "offline"] as const) {
      const d = await resolve_route(p, { available: async () => true });
      assert.deepEqual(d, { route: p, auto: false });
    }
  });
});

describe("the fallback does not answer below the tier already established", () => {
  it("holds the tier when its own classifier says simple", async () => {
    // Observed live: a 24-file change fell back, the shim's classifier read the
    // first 500 characters, called it simple, and answered on flash-low — the
    // cheapest model, on the change least able to afford it.
    const asked: Array<{ thinking: boolean }> = [];
    const client = {
      messages: {
        create: async (req: { thinking?: unknown; messages: Array<{ content: string }> }) => {
          const classifying = /Classify the complexity/.test(req.messages?.[0]?.content ?? "");
          asked.push({ thinking: Boolean(req.thinking) });
          return { content: [{ text: classifying ? "simple" : "Final answer: reviewed." }] };
        },
      },
    };
    const primary = new AntigravityReasoning({}, undefined, {
      empty_retries: 1,
      run: (async () => envelope()) as never,
    });

    await new AutoAntigravityReasoning({}, primary, new ArgusReasoning(client as never)).review(
      "x\n".repeat(400),
    );
    assert.ok(
      asked.some((a) => a.thinking),
      "a large change must not be answered on the shallow tier",
    );
  });

  it("leaves a genuinely small change alone", async () => {
    const asked: Array<{ thinking: boolean }> = [];
    const client = {
      messages: {
        create: async (req: { thinking?: unknown; messages: Array<{ content: string }> }) => {
          const classifying = /Classify the complexity/.test(req.messages?.[0]?.content ?? "");
          asked.push({ thinking: Boolean(req.thinking) });
          return { content: [{ text: classifying ? "simple" : "Final answer: reviewed." }] };
        },
      },
    };
    const primary = new AntigravityReasoning({}, undefined, { run: (async () => envelope()) as never });
    await new AutoAntigravityReasoning({}, primary, new ArgusReasoning(client as never)).review("x\n");
    assert.ok(!asked.some((a) => a.thinking), "a small diff should not be forced deep");
  });

  it("routes by size the same way for the primary and the floor", () => {
    assert.equal(tier_for_size("x\n".repeat(10)), Complexity.SIMPLE);
    assert.equal(tier_for_size("x\n".repeat(60)), Complexity.MODERATE);
    assert.equal(tier_for_size("x\n".repeat(400)), Complexity.COMPLEX);
  });

  it("takes the deeper of a classification and a floor", () => {
    assert.equal(deepest(Complexity.SIMPLE, Complexity.COMPLEX), Complexity.COMPLEX);
    assert.equal(deepest(Complexity.COMPLEX, Complexity.SIMPLE), Complexity.COMPLEX);
    assert.equal(deepest(Complexity.MODERATE, undefined), Complexity.MODERATE);
  });
});

describe("prose that looks like a filename", () => {
  it("does not file a lesson against a product name", () => {
    // "Node.js" was stored as a lesson locus — a directory that cannot exist.
    assert.equal(parse_findings("- **[medium]** The Node.js runtime needs a hook.")[0]?.path, undefined);
  });

  it("still finds the real path when a product name precedes it", () => {
    // The regex takes the leftmost candidate, so this line yielded "Node.js"
    // and never reached the file the finding was actually about.
    const [f] = parse_findings("- **[low]** blocks the Node.js event loop in app/x.ts:4");
    assert.equal(f?.path, "app/x.ts");
    assert.equal(f?.line, 4);
  });

  it("keeps a real file that happens to share the name", () => {
    assert.equal(parse_findings("- **[high]** `lib/node.js:3` — a real file.")[0]?.path, "lib/node.js");
  });
});
