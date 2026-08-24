/**
 * The Anthropic route reports what it spent.
 *
 * `new ArgusReasoning()` builds an SDK client itself and announces nothing, so
 * an Anthropic review made real requests while the record showed zero calls and
 * zero tokens. A record claiming a review cost nothing is worse than one that
 * says nothing, because it reads as a fact.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AnthropicClient } from "../src/providers/anthropic.mjs";
import type { ProviderCallTrace } from "../src/provider_trace.mjs";

describe("an Anthropic call", () => {
  it("is announced with its model and token cost", async () => {
    const calls: ProviderCallTrace[] = [];
    const client = new AnthropicClient({
      on_call: (t) => calls.push(t),
      client: {
        messages: {
          create: async () => ({
            model: "claude-sonnet-4-6",
            content: [{ text: "reviewed" }],
            usage: { input_tokens: 900, output_tokens: 100, cache_read_input_tokens: 50 },
          }),
        },
      },
    });

    const out = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "review" }],
    });

    assert.equal(out.content[0].text, "reviewed");
    assert.equal(calls.length, 1);
    // What answered, not what was asked for.
    assert.equal(calls[0].model, "claude-sonnet-4-6");
    assert.equal(calls[0].usage.input_tokens, 900);
    assert.equal(calls[0].usage.total_tokens, 1000);
    assert.equal(calls[0].usage.cache_read_tokens, 50);
  });

  it("survives a response that reports no usage", async () => {
    const calls: ProviderCallTrace[] = [];
    const client = new AnthropicClient({
      on_call: (t) => calls.push(t),
      client: { messages: { create: async () => ({ content: [{ text: "x" }] }) } },
    });
    await client.messages.create({ model: "m", messages: [{ role: "user", content: "y" }] });
    assert.equal(calls[0].usage.total_tokens, 0);
    assert.equal(calls[0].model, "m", "falls back to the model requested");
  });
});
