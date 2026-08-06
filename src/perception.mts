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

  get selectivity(): number {
    if (this.tokens_considered === 0) return 0;
    return this.tokens_selected / this.tokens_considered;
  }
}

function read_text(full: string): string {
  return fs.readFileSync(full, { encoding: "utf-8" });
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
    const full = path.join(repo_root, fpath);
    if (fs.existsSync(full)) {
      contexts.push(new FileContext(fpath, read_text(full), "modified"));
    }
  }

  // Step 2: Follow imports from modified files
  for (const ctx of [...contexts]) {
    for (const imp of _find_imports(ctx.path, ctx.content)) {
      const imp_path = path.join(repo_root, imp);
      if (fs.existsSync(imp_path) && !modified.includes(imp)) {
        contexts.push(new FileContext(imp, read_text(imp_path), "imported"));
      }
    }
  }

  // Step 3: Find test files for modified modules
  for (const test of _find_test_files(modified, repo_root)) {
    if (!contexts.some((c) => c.path === test)) {
      const full = path.join(repo_root, test);
      if (fs.existsSync(full)) {
        contexts.push(new FileContext(test, read_text(full), "test"));
      }
    }
  }

  // Step 4: Load project configuration
  for (const cfg of ["pyproject.toml", "setup.cfg", ".flake8", "package.json", "tsconfig.json"]) {
    const cfg_path = path.join(repo_root, cfg);
    if (fs.existsSync(cfg_path)) {
      contexts.push(new FileContext(cfg, read_text(cfg_path), "config"));
    }
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
      imports.push(rel, rel.replace(/\.mjs$/, ".mts"), rel.replace(/\.js$/, ".ts"));
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
