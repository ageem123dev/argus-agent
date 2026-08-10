/**
 * Tests for diff collection.
 *
 * Each builds a real repository, because the thing under test is what git
 * reports and no fixture can stand in for that. An earlier ad-hoc check of
 * these same cases was misread when `git stash pop` quietly staged the files it
 * restored — the shell state moved, the assertion did not.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { collect_diff, describe_diff } from "../src/diff.mjs";

const tmp_root = fs.mkdtempSync(path.join(os.tmpdir(), "argus-diff-"));
after(() => fs.rmSync(tmp_root, { recursive: true, force: true }));

let counter = 0;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

/** A repo on `main` with one commit. */
function repo(): string {
  counter += 1;
  const dir = path.join(tmp_root, `repo-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--initial-branch=main", ".");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  write(dir, "tracked.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

function write(repo_root: string, file: string, body: string): void {
  const full = path.join(repo_root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf-8");
}

const files = (diff: string): string[] =>
  [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim()).sort();

describe("collect_diff", () => {
  it("sees a file git does not track yet", () => {
    // The defect this exists to fix: `git diff HEAD` reports the edit around
    // new code and not the new code, which is where the defects are.
    const dir = repo();
    write(dir, "tracked.ts", "export const a = 2;\n");
    write(dir, "brand-new.ts", "export const b = 2;\n");

    assert.deepEqual(files(git(dir, "diff", "HEAD")), ["tracked.ts"]);
    assert.deepEqual(files(collect_diff(dir).diff), ["brand-new.ts", "tracked.ts"]);
  });

  it("covers committed branch work and uncommitted work in one diff", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "story/1");
    write(dir, "committed.ts", "export const c = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "branch work");
    write(dir, "tracked.ts", "export const a = 3;\n");
    write(dir, "untracked.ts", "export const d = 1;\n");

    const collected = collect_diff(dir);
    assert.equal(collected.base_ref, "main");
    assert.deepEqual(files(collected.diff), ["committed.ts", "tracked.ts", "untracked.ts"]);

    // Once committed, `git diff HEAD` is empty — which is the state the review
    // runs in alongside CodeRabbit, and why every finding scored as a miss.
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "rest");
    assert.equal(git(dir, "diff", "HEAD").trim(), "");
    assert.deepEqual(files(collect_diff(dir).diff), ["committed.ts", "tracked.ts", "untracked.ts"]);
  });

  it("reports each file once, with no overlapping hunks", () => {
    // A file changed on the branch and again in the working tree must not be
    // shown twice; two concatenated diffs would do exactly that.
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "story/2");
    write(dir, "tracked.ts", "export const a = 2;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "edit once");
    write(dir, "tracked.ts", "export const a = 3;\n");

    const found = files(collect_diff(dir).diff);
    assert.deepEqual(found, ["tracked.ts"]);
    assert.equal(found.length, new Set(found).size);
  });

  it("falls back to the working tree when the base cannot be resolved", () => {
    const dir = repo();
    write(dir, "tracked.ts", "export const a = 2;\n");
    const collected = collect_diff(dir, { base: "no-such-branch" });
    assert.equal(collected.base_ref, undefined);
    assert.deepEqual(files(collected.diff), ["tracked.ts"]);
  });

  it("degrades to the working tree on the base branch itself", () => {
    // The merge base *is* HEAD there, so this needs no special case.
    const dir = repo();
    write(dir, "tracked.ts", "export const a = 2;\n");
    assert.deepEqual(files(collect_diff(dir).diff), ["tracked.ts"]);
  });

  it("omits untracked files when asked", () => {
    const dir = repo();
    write(dir, "tracked.ts", "export const a = 2;\n");
    write(dir, "untracked.ts", "export const d = 1;\n");
    assert.deepEqual(files(collect_diff(dir, { include_untracked: false }).diff), ["tracked.ts"]);
  });

  it("respects gitignore, so its own output cannot feed back in", () => {
    const dir = repo();
    write(dir, ".gitignore", ".argus/\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "ignore");
    write(dir, ".argus/pending.diff", "whatever was written last time\n");
    write(dir, "real.ts", "export const r = 1;\n");
    assert.deepEqual(files(collect_diff(dir).diff), ["real.ts"]);
  });

  it("names an oversized untracked file rather than inlining it", () => {
    // One unignored fixture would otherwise crowd the real change out of the
    // prompt, and silently.
    const dir = repo();
    write(dir, "huge.json", "x".repeat(4096));
    write(dir, "small.ts", "export const s = 1;\n");

    const collected = collect_diff(dir, { max_untracked_bytes: 1024 });
    assert.deepEqual(collected.skipped_untracked, ["huge.json"]);
    assert.deepEqual(files(collected.diff), ["small.ts"]);
    assert.match(describe_diff(collected), /too large, omitted: huge\.json/);
  });

  it("reports nothing at all when there is nothing to review", () => {
    const dir = repo();
    const collected = collect_diff(dir);
    assert.equal(collected.diff.trim(), "");
    assert.deepEqual(collected.untracked, []);
  });

  it("does not throw outside a git repository", () => {
    counter += 1;
    const dir = path.join(tmp_root, `bare-${counter}`);
    fs.mkdirSync(dir, { recursive: true });
    assert.doesNotThrow(() => collect_diff(dir));
    assert.equal(collect_diff(dir).diff, "");
  });
});
