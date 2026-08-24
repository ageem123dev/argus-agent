/**
 * Loading a reasoning provider from outside the repository.
 *
 * The seam exists so a provider that cannot ship here can still be used by
 * whoever has it. What matters is that a broken or missing plugin fails with a
 * message naming the path tried — the user is the only one who knows where
 * they put it, so an unadorned "cannot find module" is unactionable.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PluginError, load_plugin, plugin_spec, resolve_plugin_path } from "../src/providers/plugin.mjs";
import { PROVIDERS, resolve_route, route_note } from "../src/routing.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argus-plugin-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Write a plugin module and return its path. Named so imports stay distinct. */
function plugin(name: string, source: string): string {
  const file = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(file, source, "utf-8");
  return file;
}

const WORKING = `
export default {
  name: "stub-provider",
  create(opts) {
    return { review: async (diff) => ({ verdict: "reviewed " + diff.length + " chars, cwd=" + opts.cwd }) };
  },
};
`;

describe("a working plugin", () => {
  it("is loaded, named, and handed the provider options", async () => {
    const file = plugin("ok", WORKING);
    const loaded = await load_plugin(file, tmp, { cwd: "/somewhere" });

    assert.equal(loaded.name, "stub-provider");
    assert.equal(loaded.path, file);
    const result: any = await loaded.reasoning.review("abcd");
    assert.equal(result.verdict, "reviewed 4 chars, cwd=/somewhere");
  });

  it("may export { name, create } directly rather than as a default", async () => {
    const file = plugin("named", `
      export const name = "named-export";
      export function create() { return { review: async () => ({ verdict: "x" }) }; }
    `);
    assert.equal((await load_plugin(file, tmp)).name, "named-export");
  });

  it("resolves a relative path against the repo, so config can stay portable", () => {
    const rel = resolve_plugin_path(path.join("dist", "p.mjs"), tmp);
    assert.equal(rel, path.resolve(tmp, "dist", "p.mjs"));
    const abs = path.join(tmp, "abs.mjs");
    assert.equal(resolve_plugin_path(abs, "/elsewhere"), abs);
  });
});

describe("a plugin that cannot be used", () => {
  it("names the path when the module is missing", async () => {
    const missing = path.join(tmp, "nope.mjs");
    await assert.rejects(
      () => load_plugin(missing, tmp),
      (e: unknown) =>
        e instanceof PluginError && e.message.includes(missing),
      "the message must contain the path tried",
    );
  });

  it("says what a plugin must export when it exports nothing useful", async () => {
    const file = plugin("empty", `export const unrelated = 1;`);
    await assert.rejects(
      () => load_plugin(file, tmp),
      (e: unknown) =>
        e instanceof PluginError &&
        e.message.includes("create(opts)") &&
        e.message.includes(file),
    );
  });

  it("rejects something that is not a reasoning provider", async () => {
    const file = plugin("wrong", `export default { name: "x", create: () => ({ nope: true }) };`);
    await assert.rejects(
      () => load_plugin(file, tmp),
      (e: unknown) => e instanceof PluginError && e.message.includes("review(diff)"),
    );
  });
});

describe("where a plugin may be named", () => {
  it("prefers the environment, so the path need not be in any file", () => {
    assert.equal(
      plugin_spec("/repo", "from-config", { ARGUS_REASONING_PLUGIN: "from-env" } as NodeJS.ProcessEnv),
      "from-env",
    );
    assert.equal(plugin_spec("/repo", "from-config", {} as NodeJS.ProcessEnv), "from-config");
    assert.equal(plugin_spec("/repo", undefined, {} as NodeJS.ProcessEnv), undefined);
  });
});

describe("auto", () => {
  it("prefers a configured plugin — naming one is an explicit act", () => {
    assert.deepEqual(resolve_route("auto", { plugin: true, gemini_key: true }), {
      route: "plugin",
      auto: true,
    });
  });

  it("then the supported API path, then Anthropic, then offline", () => {
    assert.equal(resolve_route("auto", { gemini_key: true, anthropic_key: true }).route, "gemini");
    assert.equal(resolve_route("auto", { gemini_key: false, anthropic_key: true }).route, "anthropic");
    assert.equal(resolve_route("auto", { gemini_key: false, anthropic_key: false }).route, "offline");
  });

  it("never overrides a provider the user named", () => {
    for (const p of PROVIDERS.filter((x) => x !== "auto")) {
      assert.deepEqual(
        resolve_route(p, { plugin: true, gemini_key: true }),
        { route: p, auto: false },
        `${p} must be honoured as asked`,
      );
    }
  });

  it("says so when it lands on offline, which finds nothing", () => {
    const note = route_note("auto", resolve_route("auto", { gemini_key: false, anthropic_key: false }));
    assert.match(note, /offline/);
    assert.match(note, /finds nothing/);
    assert.equal(route_note("offline", { route: "offline", auto: false }), "", "silent when asked for");
  });
});
