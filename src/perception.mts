/**
 * Perception — decide what the agent looks at before it reasons.
 *
 * Given a diff, gather the smallest useful context: the modified files,
 * the files they import, their tests, and project configuration — then
 * fill a token budget greedily by priority. Every decision is recorded
 * on a PerceptionTrace so selectivity is observable.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export class FileContext {
  constructor(
    public path: string,
    public content: string,
    public relevance: string, // "modified" | "imported" | "test" | "config"
    public tokens = 0,
  ) {
    if (this.tokens === 0) {
      this.tokens = Math.floor(this.content.length / 4);
    }
  }
}

/** Observable record of perception decisions. */
export class PerceptionTrace {
  files_discovered = 0;
  files_selected = 0;
  files_dropped = 0;
  tokens_considered = 0;
  tokens_selected = 0;
  dropped_files: Array<[string, string]> = [];
  /** Paths that exist but could not be read, with how they were reached. */
  unreadable: Array<[string, string]> = [];
  /** Paths that resolved outside the repository and were refused. */
  outside_repo: Array<[string, string]> = [];

  get selectivity(): number {
    if (this.tokens_considered === 0) return 0;
    return this.tokens_selected / this.tokens_considered;
  }
}

/**
 * Best-effort read: the contents, or null for anything that is not a file we
 * can read.
 *
 * Context gathering must not be able to fail a review. existsSync answers yes
 * for a directory, so a specifier resolving to one reached readFileSync and
 * threw EISDIR, which escaped and killed the whole review — and a specifier is
 * only text: one sitting inside a string literal in a test fixture, which the
 * module never imports, was enough to produce it. An unreadable path is
 * information about the repo, reported through the trace, not an error.
 */
function read_text(full: string): string | null {
  try {
    // Checked rather than left to the catch below: reading a directory does
    // throw, but a fifo or a device file would block instead, and a review
    // that hangs is worse than one that crashes.
    if (!fs.statSync(full).isFile()) {
      return null;
    }
    return fs.readFileSync(full, { encoding: "utf-8" });
  } catch {
    // A directory, a race with a delete, a permission we lack, a device file:
    // every one of them gets the same answer as a path that was never there.
    return null;
  }
}

/**
 * The real path, following any links. Falls back to the given path when it
 * cannot be resolved — a path that does not exist has no canonical form, and
 * read_text refuses it on its own.
 */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Read a repo-relative path into the context list, or record why not.
 *
 * The path is resolved and confined to the repository. A specifier is only
 * text, and one written inside a string literal is harvested like any other,
 * so `../../../outside/secret.env` in a fixture was enough to read a file the
 * review has no business seeing into the prompt — and the prompt leaves the
 * machine. Confinement is checked here rather than at each caller so a path
 * from a diff header gets the same treatment as one from a specifier.
 */
function add_context(
  contexts: FileContext[],
  trace: PerceptionTrace,
  repo_root: string,
  rel: string,
  relevance: string,
): void {
  // Canonicalized, not merely resolved: path.resolve is lexical, while statSync
  // and readFileSync follow links. A link inside the repository pointing out of
  // it — `vendor` -> an external directory — produced a candidate that looked
  // repo-relative and read an external file anyway. Both sides are canonicalized
  // because the root itself may sit behind a link (/var -> /private/var), which
  // would otherwise put every candidate outside its own repository.
  const root = canonical(path.resolve(repo_root));
  const full = canonical(path.resolve(root, rel));
  const inside = path.relative(root, full);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    trace.outside_repo.push([rel, relevance]);
    return;
  }
  const content = read_text(full);
  if (content === null) {
    if (fs.existsSync(full)) {
      trace.unreadable.push([rel, relevance]);
    }
    return;
  }
  contexts.push(new FileContext(rel, content, relevance));
}

export function gather_review_context(
  diff: string,
  repo_root: string,
  budget: number = 50_000,
): [FileContext[], PerceptionTrace] {
  const contexts: FileContext[] = [];
  const trace = new PerceptionTrace();

  // Step 1: Modified files (always included)
  const modified = _extract_modified_files(diff);
  for (const fpath of modified) {
    add_context(contexts, trace, repo_root, fpath, "modified");
  }

  // Step 2: Follow imports from modified files
  for (const ctx of [...contexts]) {
    for (const imp of _find_imports(ctx.path, ctx.content)) {
      if (!modified.includes(imp)) {
        add_context(contexts, trace, repo_root, imp, "imported");
      }
    }
  }

  // Step 3: Find test files for modified modules
  for (const test of _find_test_files(modified, repo_root)) {
    if (!contexts.some((c) => c.path === test)) {
      add_context(contexts, trace, repo_root, test, "test");
    }
  }

  // Step 4: Load project configuration
  for (const cfg of ["pyproject.toml", "setup.cfg", ".flake8", "package.json", "tsconfig.json"]) {
    add_context(contexts, trace, repo_root, cfg, "config");
  }

  // Triage: sort by priority, fill greedily
  const priority_order: Record<string, number> = { modified: 0, imported: 1, test: 1, config: 2 };
  contexts.sort(
    (a, b) => (priority_order[a.relevance] ?? 3) - (priority_order[b.relevance] ?? 3),
  );

  trace.files_discovered = contexts.length;
  trace.tokens_considered = contexts.reduce((sum, c) => sum + c.tokens, 0);

  const selected: FileContext[] = [];
  let used = 0;
  for (const ctx of contexts) {
    if (used + ctx.tokens <= budget) {
      selected.push(ctx);
      used += ctx.tokens;
    } else {
      trace.dropped_files.push([ctx.path, ctx.relevance]);
    }
  }

  trace.files_selected = selected.length;
  trace.files_dropped = trace.files_discovered - trace.files_selected;
  trace.tokens_selected = used;
  if (trace.dropped_files.length) {
    console.warn("argus.perception: dropped", trace.dropped_files);
  }

  return [selected, trace];
}

/**
 * Repo-relative paths a unified diff touches, in order, deduplicated.
 *
 * Exported because memory retrieval needs exactly this: lessons are keyed by
 * the directory a past finding sat in, so the paths a diff touches are the
 * query, not a character-count prefix of the diff text.
 */
export function extract_modified_files(diff: string): string[] {
  return _extract_modified_files(diff);
}

function _extract_modified_files(diff: string): string[] {
  const out: string[] = [];
  const re = /^\+\+\+ [ab]\/(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    if (!out.includes(m[1])) {
      out.push(m[1]);
    }
  }
  return out;
}

/** Resolve import statements to candidate repo paths (Python + TS/JS sources). */
function _find_imports(from_path: string, source: string): string[] {
  const imports: string[] = [];
  if (from_path.endsWith(".py")) {
    const re = /^(?:from|import)\s+([\w.]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      imports.push(m[1].replaceAll(".", "/") + ".py");
    }
  } else if (/\.(mts|cts|ts|tsx|mjs|cjs|js|jsx)$/.test(from_path)) {
    const dir = path.dirname(from_path);
    const re = /from\s+["'](\.\.?\/[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // .mjs specifiers compile from .mts sources; check both spellings.
      const rel = path.posix.join(dir.replaceAll("\\", "/"), m[1]);
      // Deduplicated because the spellings collapse: a specifier with no
      // .mjs or .js suffix yields the same candidate three times, and one
      // ending .js yields its own name twice — which read the same file into
      // the prompt twice, against the same token budget.
      for (const candidate of [rel, rel.replace(/\.mjs$/, ".mts"), rel.replace(/\.js$/, ".ts")]) {
        if (!imports.includes(candidate)) {
          imports.push(candidate);
        }
      }
    }
  }
  return imports;
}

function _find_test_files(modified: string[], repo_root: string): string[] {
  const tests: string[] = [];
  for (const fpath of modified) {
    const name = path.basename(fpath, path.extname(fpath));
    const parent = path.dirname(fpath);
    const candidates = [
      `tests/test_${name}.py`,
      `test/test_${name}.py`,
      `${parent}/test_${name}.py`,
      `tests/${name}.test.ts`,
      `${parent}/${name}.test.ts`,
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(repo_root, c))) {
        tests.push(c);
      }
    }
  }
  return tests;
}
