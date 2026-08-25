/**
 * The Gemini API provider.
 *
 * Every test drives a stub `fetch` or a stub `call_gemini`, so the suite makes
 * no network calls and needs no key. What is asserted is the request Argus
 * actually builds and how it reads the answer back — not that Google replies.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GeminiClient,
  GeminiError,
  GeminiReasoning,
  call_gemini,
  has_api_key,
  resolve_api_key,
} from "../src/providers/gemini.mjs";
import { EmptyReviewError } from "../src/review_schema.mjs";
import type { ProviderCallTrace } from "../src/provider_trace.mjs";

/** A well-formed structured review, as the schema asks for it. */
const REVIEW = {
  complexity: "moderate",
  confidence: 0.9,
  steps: [{ content: "read the diff", confidence: 0.9 }],
  findings: [
    {
      severity: "high",
      location: "src/auth/token.mts:42",
      issue: "jwt.decode does not verify the signature",
      suggestion: "use jwt.verify",
    },
  ],
  final_answer: "One high-severity issue.",
};

/** A fetch that returns `body` as JSON, recording what it was asked. */
function stub_fetch(body: unknown, init: { status?: number } = {}) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const impl = (async (url: any, opts: any) => {
    seen.push({
      url: String(url),
      headers: opts.headers,
      body: JSON.parse(opts.body),
    });
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function envelope(text: string, usage?: Record<string, number>) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: usage ?? {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
    },
  };
}

describe("the API key", () => {
  it("comes from either spelling Google's own tooling uses", () => {
    assert.equal(resolve_api_key({ api_key: "explicit" }), "explicit");
    assert.equal(resolve_api_key({}, ), process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  });

  it("is never required just to construct the provider", () => {
    // Construction must not touch the environment: the CLI builds a provider
    // before it knows whether the review will run.
    assert.doesNotThrow(() => new GeminiReasoning({}));
  });

  it("produces a named failure rather than an unauthorised call", async () => {
    const { impl, seen } = stub_fetch(envelope("{}"));
    await assert.rejects(
      () => call_gemini("hi", "gemini-3.7-flash", { api_key: "", fetch_impl: impl }, {}),
      (e: unknown) => e instanceof GeminiError && e.kind === "no_key",
    );
    assert.equal(seen.length, 0, "no request may be sent without a key");
  });
});

describe("a review over the API", () => {
  it("asks for the schema and reads the findings back out", async () => {
    const { impl, seen } = stub_fetch(envelope(JSON.stringify(REVIEW)));
    const result = await new GeminiReasoning({ api_key: "k", fetch_impl: impl }).review(
      "--- a/x\n+++ b/x\n@@\n+one line\n",
    );

    assert.equal(seen.length, 1, "one call per review");
    assert.equal(seen[0].headers["x-goog-api-key"], "k");
    assert.equal(
      seen[0].body.generationConfig.responseMimeType,
      "application/json",
      "structured output must be requested, not hoped for",
    );
    assert.ok(seen[0].body.generationConfig.responseSchema, "the schema must be sent");

    // The rendered verdict is what parse_findings reads and ingestion scores.
    assert.match(result.verdict, /\*\*\[high\]\*\* src\/auth\/token\.mts:42/);
    assert.match(result.verdict, /One high-severity issue\./);
    assert.equal(result.confidence, 0.9);
  });

  it("reports what the call cost, so a record can be written", async () => {
    const { impl } = stub_fetch(
      envelope(JSON.stringify(REVIEW), {
        promptTokenCount: 1000,
        candidatesTokenCount: 250,
        totalTokenCount: 1250,
      }),
    );
    const calls: ProviderCallTrace[] = [];
    await new GeminiReasoning({
      api_key: "k",
      fetch_impl: impl,
      on_call: (t) => calls.push(t),
    }).review("x\n");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].usage.input_tokens, 1000);
    assert.equal(calls[0].usage.total_tokens, 1250);
    assert.equal(calls[0].model, "gemini-3.7-flash");
  });

  it("refuses to pass off an empty answer as a clean review", async () => {
    // A 200 with nothing in it must not become "no findings" — that is
    // indistinguishable from a clean diff and scores as a total miss later.
    const { impl } = stub_fetch(envelope(""));
    await assert.rejects(
      () => new GeminiReasoning({ api_key: "k", fetch_impl: impl }).review("x\n"),
      (e: unknown) => e instanceof EmptyReviewError,
    );
  });

  it("keeps prose when the schema did not hold", async () => {
    const { impl } = stub_fetch(envelope("Not JSON, but a real review of the change."));
    const result = await new GeminiReasoning({ api_key: "k", fetch_impl: impl }).review("x\n");
    assert.match(result.verdict, /a real review of the change/);
    assert.equal(result.confidence, 0.6, "and says it trusts it less");
  });

  it("names the failure kind, so a caller knows whether to retry", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [429, "rate_limit"],
      [500, "http"],
    ] as const) {
      const { impl } = stub_fetch({ error: { message: "nope" } }, { status });
      await assert.rejects(
        () => new GeminiReasoning({ api_key: "k", fetch_impl: impl }).review("x\n"),
        (e: unknown) => e instanceof GeminiError && e.kind === kind && e.status === status,
        `status ${status} should be ${kind}`,
      );
    }
  });

  it("retries an empty answer only when asked to", async () => {
    let n = 0;
    const call = (async () => {
      n += 1;
      return { text: "", usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, duration_seconds: 0 };
    }) as unknown as typeof call_gemini;

    await assert.rejects(() => new GeminiReasoning({ api_key: "k" }, undefined, call).review("x\n"));
    assert.equal(n, 1, "no retry by default: one call per review, as documented");

    n = 0;
    await assert.rejects(
      () => new GeminiReasoning({ api_key: "k", empty_retries: 1 }, undefined, call).review("x\n"),
    );
    assert.equal(n, 2);
  });
});

describe("Gemini as a plain completion backend", () => {
  it("flattens system and turns the way the reasoning layer expects", async () => {
    const { impl, seen } = stub_fetch(envelope("done"));
    const client = new GeminiClient({ api_key: "k", fetch_impl: impl });
    const out = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      system: "be terse",
      messages: [{ role: "user", content: "review this" }],
    });

    assert.equal(out.content[0].text, "done");
    const prompt = seen[0].body.contents[0].parts[0].text;
    assert.match(prompt, /\[System instructions\]\nbe terse/);
    assert.match(prompt, /review this/);
  });

  it("sends the deep model when a thinking budget is asked for", async () => {
    // The routing table separates complex from moderate by reasoning budget
    // rather than model name, so both arrive under one slug; mapping by slug
    // alone would answer the hardest change on the shallowest setting.
    const { impl, seen } = stub_fetch(envelope("done"));
    const client = new GeminiClient({ api_key: "k", fetch_impl: impl }, "gemini-deep");
    await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "x" }],
      thinking: { budget_tokens: 10 },
    });
    assert.match(seen[0].url, /gemini-deep:generateContent/);
  });
});

describe("has_api_key", () => {
  it("answers without revealing or validating the key", () => {
    assert.equal(has_api_key({ api_key: "something" }), true);
    assert.equal(has_api_key({ api_key: "" }), Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY));
  });
});

describe("the thinking level", () => {
  it("is sent as thinkingLevel, which is what Gemini 3.x takes", async () => {
    // These models take a level, not the token budget earlier models used. A
    // budget is ignored rather than rejected, so the tiers would all have run
    // at the default depth while the routing table looked correct.
    for (const [diff, level] of [
      ["one line\n", "low"],
      ["x\n".repeat(50), "medium"],
      ["x\n".repeat(200), "high"],
    ] as const) {
      const { impl, seen } = stub_fetch(envelope(JSON.stringify(REVIEW)));
      await new GeminiReasoning({ api_key: "k", fetch_impl: impl }).review(diff);
      const cfg = seen[0].body.generationConfig;
      assert.equal(cfg.thinkingConfig.thinkingLevel, level);
      assert.equal(cfg.thinkingConfig.thinkingBudget, undefined, "no deprecated budget");
    }
  });
});

describe("the request deadline", () => {
  it("is always set, so a stalled connection cannot hang the review", async () => {
    // Without one the review awaits forever and neither the CLI nor an MCP
    // request ever returns — a hang is worse than a failure.
    let signal: AbortSignal | undefined;
    const impl = (async (_url: any, opts: any) => {
      signal = opts.signal;
      return { ok: true, status: 200, text: async () => JSON.stringify(envelope("{}")) } as any;
    }) as unknown as typeof fetch;

    await new GeminiReasoning({ api_key: "k", fetch_impl: impl }).review("x\n").catch(() => {});
    assert.ok(signal instanceof AbortSignal, "a signal must be attached by default");
  });

  it("reports a timeout as a reachability failure, not an empty review", async () => {
    const impl = (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => new GeminiReasoning({ api_key: "k", fetch_impl: impl, timeout_ms: 1 }).review("x\n"),
      (e: unknown) => e instanceof GeminiError && e.kind === "network",
    );
  });
});
