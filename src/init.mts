/**
 * `argus init` — write the Claude Code integration files into a target repo.
 *
 * `.mcp.json` and `.claude/commands/argus-review.md` have to sit at the root of
 * the *consuming* repo for Claude Code to discover them, so they cannot live in
 * this package's src/. Generating them instead of shipping them to be copied
 * keeps the templates here as the single source of truth, and computes the path
 * back to this package rather than hardcoding one that only works in one layout.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to this package's dist/ directory, wherever it was installed. */
export function dist_dir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Path to `dist/<file>` as written into generated config: relative and POSIX-
 * separated when this package sits inside the target repo (portable, survives
 * the repo moving), absolute when it does not.
 */
export function reference_path(target_repo: string, file: string): string {
  const abs = path.join(dist_dir(), file);
  const rel = path.relative(path.resolve(target_repo), abs);
  const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  return inside ? rel.split(path.sep).join("/") : abs.split(path.sep).join("/");
}

function mcp_json(cli_ref: string): string {
  return `${JSON.stringify(
    { mcpServers: { argus: { command: "node", args: [cli_ref] } } },
    null,
    2,
  )}\n`;
}

/**
 * The slash command.
 *
 * Two things it must not do, both learned the hard way.
 *
 * It must not build the diff with `git diff HEAD`. That omits untracked files,
 * so every file a story *adds* was invisible while the edits around it were
 * not -- and it scopes to uncommitted work, so once the branch is committed
 * the review sees nothing at all, which is exactly the state it runs in
 * alongside a second reviewer working from the base branch.
 *
 * And it must not do that in shell. The untracked pass is a loop, and the loop
 * does not survive a Windows shell. In Node it is one tested implementation,
 * shared with the MCP tool rather than written twice.
 *
 * `allowed-tools` narrows to the single binary as a result: no mkdir, no git.
 */
function slash_command(cli_ref: string): string {
  return `---
description: Run the Argus governed code review (Gemini via agy) on this branch's changes
argument-hint: [extra argus flags, e.g. --project my-app --no-refine]
allowed-tools: Bash(node ${cli_ref}:*)
---

!\`node ${cli_ref} diff --repo . --out .argus/pending.diff\`
!\`node ${cli_ref} .argus/pending.diff --provider antigravity $ARGUMENTS\`

Above is Argus's review, produced by a *different* model family (Gemini, via the
\`agy\` CLI) than the one reading this.

The diff covers this branch's committed work, anything uncommitted, and files git does
not track yet -- the same body of code a reviewer running against the base branch sees.
If the first command reported nothing to review, say so and stop rather than reviewing
an empty diff.

Summarize the findings grouped by severity. Before you accept any finding, open the
cited file and confirm it -- Argus reviews from a token-budgeted context slice, so it
can cite a line it only partially saw, and it is a second opinion to check rather than
ground truth. Say explicitly which findings you confirmed, which you could not
reproduce, and which you disagree with. Then propose concrete fixes for the confirmed
ones.
`;
}

const GITIGNORE_ENTRIES = [".argus/"];

export interface InitResult {
  written: string[];
  skipped: string[];
  notes: string[];
}

/**
 * Write the integration files. Existing files are left alone unless `force` —
 * this runs against repos with their own .mcp.json and .gitignore, and silently
 * overwriting either would be destructive.
 */
export function init(target_repo: string, opts: { force?: boolean } = {}): InitResult {
  const root = path.resolve(target_repo);
  const result: InitResult = { written: [], skipped: [], notes: [] };

  const files: Array<[string, string]> = [
    [path.join(root, ".mcp.json"), mcp_json(reference_path(root, "mcp.mjs"))],
    [
      path.join(root, ".claude", "commands", "argus-review.md"),
      slash_command(reference_path(root, "cli.mjs")),
    ],
  ];

  for (const [file, content] of files) {
    if (fs.existsSync(file) && !opts.force) {
      result.skipped.push(file);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf-8");
    result.written.push(file);
  }

  // Append-only: never rewrite a .gitignore we did not author.
  const gitignore = path.join(root, ".gitignore");
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf-8") : "";
  const missing = GITIGNORE_ENTRIES.filter(
    (e) => !existing.split(/\r?\n/).some((l) => l.trim() === e),
  );
  if (missing.length) {
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gitignore, `${sep}${missing.join("\n")}\n`, "utf-8");
    result.written.push(`${gitignore} (+${missing.join(", ")})`);
  }

  if (result.skipped.length) {
    result.notes.push("existing files left untouched; re-run with --force to overwrite");
  }
  return result;
}
