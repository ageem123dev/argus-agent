/**
 * Perception must not be able to fail a review.
 *
 * A module specifier is only text. One written inside a string literal — test
 * fixture data the module never imports — is harvested like any other, and if
 * it resolves to a directory that exists, existsSync said yes and readFileSync
 * threw EISDIR. The exception escaped gather_review_context and killed the
 * whole review, so a file's contents could stop Argus reviewing it.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { gather_review_context } from "../src/perception.mjs";

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-perception-"));
after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

/**
 * A repo holding one changed file two directories down, and a real directory
 * the planted specifier resolves to. Two levels matter: from the repo root the
 * same specifier escapes the repo and resolves to nothing, which is the
 * passing case and hid this for a while.
 */
function repo_with(specifier: string, name: string): { root: string; diff: string } {
  const root = fs.mkdtempSync(path.join(tmp_root, `${name}-`));
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  fs.mkdirSync(path.join(root, "adapters", "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "a", "b", "fixture.mts"),
    `const planted = "import { x } from '${specifier}'"\nexport default planted\n`,
  );
  const diff =
    "--- a/a/b/fixture.mts\n+++ b/a/b/fixture.mts\n@@ -0,0 +1,2 @@\n+const planted = 1\n";
  return { root, diff };
}

describe("a specifier that resolves to a directory", () => {
  it("is skipped, not read — the review still happens", () => {
    const { root, diff } = repo_with("../../adapters/agent", "dir");
    const [selected, trace] = gather_review_context(diff, root, 50_000);

    assert.deepEqual(
      selected.map((c) => c.path),
      ["a/b/fixture.mts"],
      "the changed file is still reviewed",
    );
    assert.deepEqual(
      trace.unreadable,
      [["adapters/agent", "imported"]],
      "and the skip is reported rather than swallowed",
    );
  });

  it("behaves exactly like one that resolves to nothing", () => {
    const planted = repo_with("../../adapters/agent", "same-a");
    const absent = repo_with("../../adapters/agent-does-not-exist", "same-b");
    const [a_sel] = gather_review_context(planted.diff, planted.root, 50_000);
    const [b_sel] = gather_review_context(absent.diff, absent.root, 50_000);
    assert.deepEqual(a_sel.map((c) => c.path), b_sel.map((c) => c.path));
  });
});

describe("an unreadable modified file", () => {
  it("does not take the rest of the review with it", () => {
    const root = fs.mkdtempSync(path.join(tmp_root, "modified-"));
    // A directory standing exactly where the diff says a file is.
    fs.mkdirSync(path.join(root, "src", "thing.mts"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    const diff = "--- a/src/thing.mts\n+++ b/src/thing.mts\n@@ -0,0 +1 @@\n+x\n";

    const [selected, trace] = gather_review_context(diff, root, 50_000);
    assert.deepEqual(selected.map((c) => c.path), ["package.json"]);
    assert.deepEqual(trace.unreadable, [["src/thing.mts", "modified"]]);
  });
});

describe("a specifier that resolves outside the repository", () => {
  it("is refused, so a fixture cannot read a file into the prompt", () => {
    // The prompt leaves the machine, so this is worse than the crash the
    // directory case caused: a string literal in a reviewed file was enough to
    // pull an unrelated file off disk and send it to the model.
    const base = fs.mkdtempSync(path.join(tmp_root, "escape-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(base, "outside"), { recursive: true });
    fs.writeFileSync(path.join(base, "outside", "secret.env"), "API_KEY=hunter2\n");
    fs.writeFileSync(
      path.join(root, "a", "b", "fixture.mts"),
      `const planted = "import { x } from '../../../outside/secret.env'"\nexport default planted\n`,
    );
    const diff = "--- a/a/b/fixture.mts\n+++ b/a/b/fixture.mts\n@@ -0,0 +1 @@\n+x\n";

    const [selected, trace] = gather_review_context(diff, root, 50_000);
    assert.deepEqual(selected.map((c) => c.path), ["a/b/fixture.mts"]);
    assert.ok(
      !selected.some((c) => c.content.includes("hunter2")),
      "no content from outside the repo reaches the prompt",
    );
    assert.deepEqual(trace.outside_repo, [["../outside/secret.env", "imported"]]);
  });

  it("refuses a diff header that climbs out of the repo too", () => {
    const base = fs.mkdtempSync(path.join(tmp_root, "escape-diff-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(base, "secret.env"), "API_KEY=hunter2\n");
    const diff = "--- a/../secret.env\n+++ b/../secret.env\n@@ -0,0 +1 @@\n+x\n";

    const [selected, trace] = gather_review_context(diff, root, 50_000);
    assert.deepEqual(selected, []);
    assert.deepEqual(trace.outside_repo, [["../secret.env", "modified"]]);
  });
});

describe("a link inside the repository pointing out of it", () => {
  it("is refused — a lexical boundary check is not enough", () => {
    // path.resolve is lexical; statSync and readFileSync follow links. A link
    // named `vendor` inside the repo produced a candidate that looked
    // repo-relative — `vendor/secret.env` — and read an external file anyway.
    const base = fs.mkdtempSync(path.join(tmp_root, "symlink-"));
    const root = path.join(base, "repo");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(base, "outside"), { recursive: true });
    fs.writeFileSync(path.join(base, "outside", "secret.env"), "API_KEY=hunter2\n");

    // Junctions need no elevation on Windows, where file symlinks do.
    try {
      fs.symlinkSync(
        path.join(base, "outside"),
        path.join(root, "vendor"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      // A platform or account that cannot make links cannot stage the escape.
      return;
    }

    fs.writeFileSync(
      path.join(root, "a", "b", "fixture.mts"),
      `const planted = "import { x } from '../../vendor/secret.env'"\nexport default planted\n`,
    );
    const diff = "--- a/a/b/fixture.mts\n+++ b/a/b/fixture.mts\n@@ -0,0 +1 @@\n+x\n";

    const [selected, trace] = gather_review_context(diff, root, 50_000);
    assert.ok(
      !selected.some((c) => c.content.includes("hunter2")),
      "the link target's contents must not reach the prompt",
    );
    assert.deepEqual(selected.map((c) => c.path), ["a/b/fixture.mts"]);
    assert.deepEqual(trace.outside_repo, [["vendor/secret.env", "imported"]]);
  });
});
