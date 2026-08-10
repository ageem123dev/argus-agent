/**
 * Diff collection — what a review is actually shown.
 *
 * `git diff HEAD` was the wrong question twice over.
 *
 * It omits untracked files, so every file a story *adds* was invisible to the
 * reviewer while the edits around it were not — the worst possible split, since
 * new code is where the defects are.
 *
 * And it scopes to uncommitted work only. CodeRabbit reviews `--base main
 * --committed`, so once the branch is committed the two reviewers no longer see
 * the same code: Argus sees an empty diff, every CodeRabbit finding scores as a
 * miss, and memory fills with lessons blaming Argus for code it was never
 * shown. The join on commit SHA still succeeds, which is what makes it
 * dangerous — a mismatch that produced no join would at least be visible.
 *
 * Both are answered by one diff rather than two concatenated ones. `git diff
 * <merge-base>` compares the point the branch forked from its base to the
 * *working tree*, so committed branch work, staged changes and unstaged changes
 * all arrive once, with no overlapping hunks to read twice.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Bases tried, in order, when the caller does not name one. */
const DEFAULT_BASES = ["main", "master"];

/**
 * Untracked files larger than this are listed but not inlined.
 *
 * A tracked diff is bounded by what changed; an untracked file arrives whole.
 * One unignored fixture or lockfile would otherwise crowd the real change out
 * of the prompt — and silently, which is the failure mode worth spending a
 * guard on.
 */
const MAX_UNTRACKED_BYTES = 512 * 1024;

export interface CollectDiffOptions {
  /**
   * Branch to measure the change from. `null` restricts the diff to
   * uncommitted work; omitted tries `main`, then `master`, then falls back to
   * HEAD — which yields exactly the old working-tree behaviour.
   */
  base?: string | null;
  /** Include files git does not track yet. On by default; this was the bug. */
  include_untracked?: boolean;
  max_untracked_bytes?: number;
}

export interface CollectedDiff {
  diff: string;
  /** The ref the base was resolved from, when one was found. */
  base_ref?: string;
  /** The merge base itself — where this branch left its base. */
  base_commit?: string;
  /** Untracked files inlined into the diff. */
  untracked: string[];
  /** Untracked files too large to inline, named so the omission is visible. */
  skipped_untracked: string[];
}

function git(repo_root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd: repo_root,
      encoding: "utf-8",
      maxBuffer: 256 << 20,
      timeout: 120_000,
      // git writes progress and warnings to stderr; neither belongs in a diff,
      // and neither is a failure.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, out };
  } catch (e) {
    // `git diff --no-index` exits 1 precisely when it found a difference, which
    // is the case we want. Take stdout whenever there is any.
    const out = (e as { stdout?: string }).stdout;
    return { ok: false, out: typeof out === "string" ? out : "" };
  }
}

/** Where this branch left `base`, or undefined if that cannot be established. */
function merge_base(repo_root: string, base: string): string | undefined {
  const verified = git(repo_root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (!verified.ok || !verified.out.trim()) {
    return undefined;
  }
  const found = git(repo_root, ["merge-base", base, "HEAD"]);
  return found.ok ? found.out.trim() || undefined : undefined;
}

/**
 * Everything this change touches, as one unified diff.
 *
 * Collected entirely in memory and returned, never streamed to a file inside
 * the repo. Writing as it goes let an earlier version list its own output as an
 * untracked file and diff it into itself — which only stayed harmless because
 * `.argus/` happened to be gitignored.
 */
export function collect_diff(repo_root: string, opts: CollectDiffOptions = {}): CollectedDiff {
  const include_untracked = opts.include_untracked ?? true;
  const cap = opts.max_untracked_bytes ?? MAX_UNTRACKED_BYTES;

  let base_ref: string | undefined;
  let base_commit: string | undefined;
  if (opts.base !== null) {
    for (const candidate of opts.base ? [opts.base] : DEFAULT_BASES) {
      const found = merge_base(repo_root, candidate);
      if (found) {
        base_ref = candidate;
        base_commit = found;
        break;
      }
    }
  }

  // From the fork point when there is one, else from HEAD. On the base branch
  // itself the merge base *is* HEAD, so this degrades to the working tree
  // without a special case.
  const from = base_commit ?? "HEAD";
  const parts: string[] = [];
  const tracked = git(repo_root, ["diff", from]);
  if (tracked.out) {
    parts.push(tracked.out);
  }

  const untracked: string[] = [];
  const skipped_untracked: string[] = [];
  if (include_untracked) {
    const listed = git(repo_root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const file of listed.out.split("\0")) {
      if (!file) {
        continue;
      }
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(repo_root, file)).size;
      } catch {
        // Vanished between listing and reading; nothing to inline.
        continue;
      }
      if (bytes > cap) {
        skipped_untracked.push(file);
        continue;
      }
      // /dev/null is understood by git on every platform it runs on, including
      // Windows, because git supplies its own path handling here.
      const rendered = git(repo_root, ["diff", "--no-index", "--", "/dev/null", file]);
      if (rendered.out.trim()) {
        parts.push(rendered.out);
        untracked.push(file);
      }
    }
  }

  return {
    diff: parts.join(""),
    base_ref,
    base_commit,
    untracked,
    skipped_untracked,
  };
}


/** One line describing what was gathered, for the CLI and the tool report. */
export function describe_diff(collected: CollectedDiff): string {
  const scope = collected.base_ref
    ? `${collected.base_ref}...HEAD plus the working tree`
    : "the working tree";
  const bits = [`scope: ${scope}`];
  if (collected.untracked.length) {
    bits.push(`${collected.untracked.length} untracked file(s) included`);
  }
  if (collected.skipped_untracked.length) {
    bits.push(
      `${collected.skipped_untracked.length} untracked file(s) too large, omitted: ` +
        collected.skipped_untracked.join(", "),
    );
  }
  return bits.join("; ");
}
