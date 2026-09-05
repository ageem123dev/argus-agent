/**
 * The configured provider actually answers.
 *
 * Opt-in, because it makes a real call and costs real quota: run it with
 * ARGUS_LIVE_TEST=1. It is skipped otherwise, including in CI.
 *
 * It exists because the rest of the suite structurally cannot catch this class.
 * On 2026-09-05 every review of a diff over 30 lines came back empty for days,
 * while a trivial prompt kept working. Measured on one fixed ~12k review task:
 *
 *   gemini-3.8-flash-high     1/2 empty   ~45k thinking tokens, ~164s
 *   gemini-3.7-flash-high     1/2 empty   ~53k thinking tokens, ~202s
 *   gemini-3.8-flash-medium   1/3 empty   ~17-27k thinking,   ~83-118s
 *   gemini-3.7-flash-medium   0/6 empty   ~10k thinking,       ~30-37s
 *
 * The failures track request weight, not model generation: the heavier and
 * slower the call, the likelier it comes back empty, and the failures arrive as
 * upstream aborts — one CANCELED mid-thinking, one bailing after 6s having
 * thought 106 tokens. That is what a provider-side outage looks like from here,
 * not a bad slug. Every stubbed test passed throughout, because a stub answers
 * whatever it is told to. Only a real call can tell you a real model has
 * stopped answering.
 *
 *   ARGUS_LIVE_TEST=1 npm test
 *   ARGUS_LIVE_TEST=1 ARGUS_REASONING_PLUGIN=<path> npx tsx --test test/live-provider.test.mts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { load_config } from "../src/config.mjs";
import { load_plugin, plugin_spec } from "../src/providers/plugin.mjs";
import { GeminiReasoning, has_api_key } from "../src/providers/gemini.mjs";
import { resolve_route } from "../src/routing.mjs";
import type { ArgusReasoning } from "../src/reasoning.mjs";
import type { ProviderCallTrace } from "../src/provider_trace.mjs";

const LIVE = process.env.ARGUS_LIVE_TEST === "1";

/**
 * Sized deliberately, and honest about what that buys.
 *
 * Routing above the SIMPLE tier is necessary but not sufficient: the failing
 * model still answered short prompts, so a 40-line diff passed against it and
 * proved nothing. ~18k characters is where the failure was reproducible by hand.
 *
 * It is still not a reliable detector of *that* fault. Measured over three runs
 * of one fixed prompt, gemini-3.7-flash-high came back empty 1/3 while
 * gemini-3.7-flash-medium came back empty 0/3 — the emptiness is intermittent
 * per call and seemingly deterministic per prompt, so a single call can pass
 * against a model that is failing most reviews. What this test does catch, with
 * one call and no flakiness in the other direction, is the general class: the
 * provider this repo is configured to use has stopped returning text. That is
 * the check no stub can perform.
 */
const HEADER = "--- a/src/token.mts\n+++ b/src/token.mts\n@@ -1,240 +1,240 @@\n";
const BODY = Array.from(
  { length: 240 },
  (_, i) => `+const value_${i} = compute(${i}, options.retries, options.timeout_ms, cache);`,
).join("\n");
const TAIL = "\n+export function verify(token: string) {\n+  return jwt.decode(token);\n+}\n";
const DIFF = HEADER + BODY + TAIL;

/** The provider the CLI would pick here, built the same way. */
async function configured(repo_root: string, calls: ProviderCallTrace[]) {
  const opts = { cwd: repo_root, on_call: (t: ProviderCallTrace) => calls.push(t) };
  const spec = plugin_spec(repo_root, load_config(repo_root).config.reasoning?.plugin);
  const route = resolve_route("auto", {
    plugin: Boolean(spec?.trusted),
    gemini_key: has_api_key(),
  });
  if (route.route === "plugin" && spec) {
    return (await load_plugin(spec.path, repo_root, opts)).reasoning;
  }
  if (route.route === "gemini") {
    return new GeminiReasoning(opts) as ArgusReasoning;
  }
  return null;
}

describe("the configured provider, for real", { skip: !LIVE && "set ARGUS_LIVE_TEST=1" }, () => {
  it("returns a non-empty review for a diff that routes above the simple tier", async () => {
    const calls: ProviderCallTrace[] = [];
    const reasoning = await configured(process.cwd(), calls);
    assert.ok(
      reasoning,
      "no live provider is configured — set ARGUS_REASONING_PLUGIN or GEMINI_API_KEY",
    );

    const result = await reasoning.review(DIFF);
    const models = [...new Set(calls.map((c) => c.model))].join(", ");

    // The message names the models, because "empty" on its own is what made the
    // original failure take days: the answer is always "which model went quiet".
    assert.ok(
      result.verdict.trim().length > 0,
      `the provider returned an empty verdict. Models called: ${models || "(none reported)"}. ` +
        `A model that consumes tokens and answers with nothing looks exactly like a clean review.`,
    );
  });
});
