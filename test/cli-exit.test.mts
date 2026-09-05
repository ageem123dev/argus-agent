/**
 * Exit codes, which are the only thing a shell gate can read.
 *
 * They are documented to distinguish two failures: 2 means the review ran and
 * produced nothing, 1 means it could not run. That distinction is worth a test
 * because it is easy to collapse — the guard that refuses an empty verdict
 * throws, and a throw lands in the same catch as a missing binary.
 *
 * These spawn the built CLI rather than calling into it: an exit code is a
 * property of the process, and reasoning about this one from the inside got it
 * wrong twice.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli.mjs");
const BUILT = fs.existsSync(CLI);

/** Built as line arrays: these are JS sources inside a JS source. */
const SILENT = [
  `export default {`,
  `  name: "silent",`,
  `  create() {`,
  `    return {`,
  `      review: async () => ({`,
  `        verdict: "",`,
  `        reasoning_steps: [],`,
  `        confidence: 0,`,
  `        complexity: "complex",`,
  `      }),`,
  `    };`,
  `  },`,
  `};`,
].join("\n");

/**
 * Throws the real error class, resolved through the same module the CLI loads,
 * so `instanceof` holds across the plugin boundary.
 */
function throws_empty(): string {
  const mod = pathToFileURL(path.join(ROOT, "dist", "reasoning.mjs")).href;
  return [
    `import { EmptyReviewError } from ${JSON.stringify(mod)};`,
    `export default {`,
    `  name: "throws",`,
    `  create() {`,
    `    return {`,
    `      review: async () => {`,
    `        throw new EmptyReviewError("nothing came back");`,
    `      },`,
    `    };`,
    `  },`,
    `};`,
  ].join("\n");
}

const BROKEN = [
  `export default {`,
  `  name: "broken",`,
  `  create() {`,
  `    return {`,
  `      review: async () => {`,
  `        throw new Error("binary missing");`,
  `      },`,
  `    };`,
  `  },`,
  `};`,
].join("\n");

let tmp: string;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argus-exit-"));
  fs.writeFileSync(
    path.join(tmp, "a.diff"),
    "--- a/a.mts\n+++ b/a.mts\n@@ -0,0 +1 @@\n+const a = 1;\n",
  );
  fs.writeFileSync(path.join(tmp, "silent.mjs"), SILENT);
  fs.writeFileSync(path.join(tmp, "throws-empty.mjs"), throws_empty());
  fs.writeFileSync(path.join(tmp, "broken.mjs"), BROKEN);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Run the built CLI against a stub plugin and return its exit code. */
function run(plugin: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        CLI,
        path.join(tmp, "a.diff"),
        "--repo",
        tmp,
        "--project",
        "exit",
        "--no-memory",
        "--no-record",
        "--provider",
        "plugin",
      ],
      { env: { ...process.env, ARGUS_REASONING_PLUGIN: path.join(tmp, plugin) } },
      (err) => resolve((err as { code?: number } | null)?.code ?? 0),
    );
  });
}

describe("CLI exit codes", { skip: !BUILT && "run npm run build first" }, () => {
  it("returns 2 when a provider answers with an empty verdict", async () => {
    assert.equal(await run("silent.mjs"), 2);
  });

  it("returns 2 when the empty-verdict guard throws instead", async () => {
    // A provider that returns "" reaches the empty-verdict check; one that
    // throws reaches the catch, alongside a missing binary. Both mean the same
    // thing to a caller, so both must be 2 — and only the first was, which is
    // what made an earlier version of this test unable to fail.
    assert.equal(await run("throws-empty.mjs"), 2);
  });

  it("returns 1 when the review could not run at all", async () => {
    // Kept apart from 2 so a gate can tell "the model went quiet" from
    // "the provider is misconfigured" without parsing prose.
    assert.equal(await run("broken.mjs"), 1);
  });
});
