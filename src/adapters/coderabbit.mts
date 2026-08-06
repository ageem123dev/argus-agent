/**
 * CodeRabbit adapter — reads the VS Code extension's review store.
 *
 * The extension writes one JSON file per review under
 * `<workspaceStorage>/<workspace-hash>/coderabbit.coderabbit-vscode/`. Neither
 * half of that path is stable: the workspace hash is per-checkout, and the
 * filename is a content hash that rotates on every review. So nothing here
 * names a file — a *directory* is scanned and the reviews are identified by
 * reading them. Configure the directory (see config.mts); discovery below is
 * only a fallback for when it is unset.
 *
 * Shape, as of the 2026-08 extension build:
 *
 *   [ { id, status, mode, headCommitId, baseCommitId, startedAt, endedAt,
 *       fileReviewMap: {
 *         "<repo-relative path>": {
 *           comments: [ { type, filename, comment, startLine, endLine,
 *                         severity, indicatorTypes, fingerprint, id } ] } } } ]
 *
 * Every field is treated as optional regardless: this is another tool's
 * private storage, not a published contract, and it will drift.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { make_finding, strip_markdown, type Finding } from "../findings.mjs";
import type { FindingsAdapter } from "../ingest.mjs";

/**
 * CodeRabbit's severity words, mapped onto the scale the rest of Argus uses.
 * Filtering happens on CodeRabbit's own words, so configuration says what its
 * documentation says; this mapping only sets how heavily a lesson weighs.
 */
export const CODERABBIT_SEVERITY: Record<string, string> = {
  critical: "critical",
  major: "high",
  minor: "low",
  trivial: "nit",
};

/** One review, with the metadata that lets it join to an Argus run record. */
export interface CodeRabbitReview {
  id?: string;
  status?: string;
  mode?: string;
  /** The commit reviewed — the join key into runs.jsonl. */
  head_commit?: string;
  base_commit?: string;
  started_at?: string;
  ended_at?: string;
  findings: Finding[];
  /** Findings dropped by the severity filter, so a silent cap stays visible. */
  filtered_out: number;
}

export interface CodeRabbitParseOptions {
  /** CodeRabbit severity words to keep. Undefined keeps everything. */
  severities?: string[];
  /** Only reviews that finished. On by default — a partial review under-reports. */
  completed_only?: boolean;
}

/** First line of the comment, which CodeRabbit writes as a bold sentence. */
function title_of(comment: string): string {
  const first = String(comment)
    .split("\n")
    .map(strip_markdown)
    .find((l) => l.length > 0);
  return first ?? "";
}

function to_finding(raw: Record<string, any>, file: string): Finding {
  const severity = String(raw.severity ?? "").toLowerCase();
  const indicators: string[] = Array.isArray(raw.indicatorTypes) ? raw.indicatorTypes : [];
  return make_finding({
    source: "coderabbit",
    // `filename` and the map key agree in practice; the key is authoritative
    // because it is what the extension indexes by.
    path: file || raw.filename,
    line: typeof raw.startLine === "number" ? raw.startLine : undefined,
    severity: CODERABBIT_SEVERITY[severity] ?? severity,
    raw_severity: severity || undefined,
    title: title_of(raw.comment ?? ""),
    category: indicators.join(", ") || raw.type,
    id: raw.fingerprint ?? raw.id,
  });
}

/**
 * Parse the extension's store. Never throws: malformed JSON, an unexpected
 * top-level shape, or a comment missing every field all yield fewer findings,
 * not an exception. Ingestion is a background improvement to memory, and it
 * must not be able to break the thing it is improving.
 */
export function parse_coderabbit_reviews(
  raw: string,
  opts: CodeRabbitParseOptions = {},
): CodeRabbitReview[] {
  const completed_only = opts.completed_only ?? true;
  const wanted = opts.severities?.map((s) => s.toLowerCase());

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // The store is an array today; tolerate a bare object in case that changes.
  const reviews = Array.isArray(parsed) ? parsed : [parsed];

  const out: CodeRabbitReview[] = [];
  for (const review of reviews) {
    if (!review || typeof review !== "object") {
      continue;
    }
    const r = review as Record<string, any>;
    const file_map = r.fileReviewMap;
    if (!file_map || typeof file_map !== "object") {
      continue;
    }
    if (completed_only && r.status && r.status !== "completed") {
      continue;
    }

    const findings: Finding[] = [];
    let filtered_out = 0;
    for (const [file, entry] of Object.entries(file_map as Record<string, any>)) {
      const comments = Array.isArray(entry?.comments) ? entry.comments : [];
      for (const comment of comments) {
        if (!comment || typeof comment !== "object") {
          continue;
        }
        const severity = String(comment.severity ?? "").toLowerCase();
        if (wanted && !wanted.includes(severity)) {
          filtered_out += 1;
          continue;
        }
        findings.push(to_finding(comment, file));
      }
    }

    out.push({
      id: r.id,
      status: r.status,
      mode: r.mode,
      head_commit: r.headCommitId,
      base_commit: r.baseCommitId,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      findings,
      filtered_out,
    });
  }
  return out;
}

/** Satisfies the generic adapter contract, for callers that want only findings. */
export function coderabbit_adapter(opts: CodeRabbitParseOptions = {}): FindingsAdapter {
  return {
    format: "coderabbit",
    parse: (raw) => parse_coderabbit_reviews(raw, opts).flatMap((r) => r.findings),
  };
}

// ---------------------------------------------------------------------------
// Locating the store
// ---------------------------------------------------------------------------

export interface LoadedReview extends CodeRabbitReview {
  /** Which file it came from — the filename rotates, so this is worth showing. */
  file: string;
}

/**
 * Read every review under a path, newest last.
 *
 * `target` may be a single file or a directory to scan. Files that are not
 * CodeRabbit reviews (the extension keeps `categories.json` and assorted small
 * state files in the same directory) simply yield nothing.
 */
export function load_reviews(target: string, opts: CodeRabbitParseOptions = {}): LoadedReview[] {
  let files: string[];
  try {
    files = fs.statSync(target).isDirectory()
      ? fs
          .readdirSync(target)
          .filter((f) => f.toLowerCase().endsWith(".json"))
          .map((f) => path.join(target, f))
      : [target];
  } catch {
    return [];
  }

  const loaded: LoadedReview[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const review of parse_coderabbit_reviews(raw, opts)) {
      loaded.push({ ...review, file });
    }
  }
  // Oldest first, so callers can take the last as "most recent".
  return loaded.sort((a, b) => String(a.ended_at ?? "").localeCompare(String(b.ended_at ?? "")));
}

/** Where VS Code keeps per-workspace extension state, per platform. */
export function workspace_storage_roots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const editors = ["Code", "Code - Insiders", "VSCodium"];
  const bases =
    process.platform === "win32"
      ? [env.APPDATA ?? path.join(home, "AppData", "Roaming")]
      : process.platform === "darwin"
        ? [path.join(home, "Library", "Application Support")]
        : [env.XDG_CONFIG_HOME ?? path.join(home, ".config")];
  return bases.flatMap((base) =>
    editors.map((editor) => path.join(base, editor, "User", "workspaceStorage")),
  );
}

/**
 * Best-effort discovery of the CodeRabbit directory for a repo.
 *
 * The extension's `categories.json` keys are prefixed with the absolute repo
 * path, which is the only link from a workspace hash back to a checkout. This
 * is a convenience for an unconfigured first run, not a contract — configure
 * `ingest.coderabbit.path` and none of it runs.
 */
export function discover_coderabbit_dirs(
  repo_root: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const wanted = path.resolve(repo_root).toLowerCase();
  const found: string[] = [];

  for (const root of workspace_storage_roots(env)) {
    let workspaces: string[];
    try {
      workspaces = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const workspace of workspaces) {
      const dir = path.join(root, workspace, "coderabbit.coderabbit-vscode");
      let categories: string;
      try {
        categories = fs.readFileSync(path.join(dir, "categories.json"), "utf-8");
      } catch {
        continue;
      }
      // Windows paths appear JSON-escaped in the keys; compare on the raw text
      // rather than reconstructing each key.
      const haystack = categories.toLowerCase().replaceAll("\\\\", "\\");
      if (haystack.includes(wanted)) {
        found.push(dir);
      }
    }
  }
  return found;
}

/**
 * The configured directory if there is one, otherwise whatever discovery
 * turns up. Returns every candidate so a caller can report an ambiguous match
 * instead of silently picking one.
 */
export function resolve_coderabbit_paths(
  repo_root: string,
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { paths: string[]; discovered: boolean } {
  if (configured) {
    return { paths: [configured], discovered: false };
  }
  return { paths: discover_coderabbit_dirs(repo_root, env), discovered: true };
}
