/**
 * Configuration.
 *
 * Argus needs two things it cannot hardcode: where another reviewer's output
 * lives, and which of its findings are worth recording. The first is
 * machine-specific — CodeRabbit's VS Code extension writes under
 * `workspaceStorage/<workspace-hash>/`, and both that hash and the filename
 * (a content hash, rotated per review) change. The second is project policy.
 *
 * So there are two files, and the split is deliberate:
 *
 *   argus.config.json        at the repo root — policy, meant to be committed
 *   .argus/config.json       machine-local, gitignored — paths for this box
 *
 * Later sources win, key by key: defaults < committed < local < environment <
 * explicit arguments. Nothing here throws; a malformed config is reported and
 * skipped rather than taking down a review.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface IngestSourceConfig {
  /**
   * File, or a directory to scan. A directory is usually right for CodeRabbit:
   * the filename is a content hash, so the newest matching review is found by
   * reading them, not by naming one.
   */
  path?: string;
  /**
   * Which of the reviewer's *own* severity labels to record, lowercased. Named
   * in the reviewer's vocabulary (CodeRabbit: critical, major, minor, trivial)
   * rather than Argus's, so the setting means what its documentation means.
   */
  severities?: string[];
}

export interface ArgusConfig {
  ingest?: {
    coderabbit?: IngestSourceConfig;
  };
}

/** Recorded by default: the two levels that represent real defects. */
export const DEFAULT_SEVERITIES = ["critical", "major"];

export const DEFAULT_CONFIG: ArgusConfig = {
  ingest: { coderabbit: { severities: DEFAULT_SEVERITIES } },
};

/** Committed policy. */
export function shared_config_path(repo_root: string): string {
  return path.join(path.resolve(repo_root), "argus.config.json");
}

/** Machine-local overrides, alongside the run records and the memory store. */
export function local_config_path(repo_root: string): string {
  return path.join(path.resolve(repo_root), ".argus", "config.json");
}

export interface ConfigLoad {
  config: ArgusConfig;
  /** Files that actually contributed, in precedence order. */
  sources: string[];
  /** Unreadable or malformed files, reported rather than thrown. */
  problems: string[];
}

function read_json(file: string, problems: string[]): ArgusConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${file}: expected a JSON object`);
      return null;
    }
    return parsed as ArgusConfig;
  } catch (e) {
    problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Merge one level deeper than Object.assign, which is as deep as this shape goes. */
function merge(base: ArgusConfig, over: ArgusConfig | null): ArgusConfig {
  if (!over) {
    return base;
  }
  return {
    ...base,
    ...over,
    ingest: {
      ...base.ingest,
      ...over.ingest,
      coderabbit: { ...base.ingest?.coderabbit, ...over.ingest?.coderabbit },
    },
  };
}

/** Comma or whitespace separated, lowercased; empty means "unset". */
export function parse_severities(raw: string | undefined): string[] | undefined {
  if (raw == null) {
    return undefined;
  }
  const list = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function from_environment(env: NodeJS.ProcessEnv): ArgusConfig {
  const coderabbit: IngestSourceConfig = {};
  if (env.ARGUS_CODERABBIT_PATH) {
    coderabbit.path = env.ARGUS_CODERABBIT_PATH;
  }
  const severities = parse_severities(env.ARGUS_CODERABBIT_SEVERITIES);
  if (severities) {
    coderabbit.severities = severities;
  }
  return Object.keys(coderabbit).length ? { ingest: { coderabbit } } : {};
}

export interface LoadOptions {
  /** Highest precedence — the CLI's flags. Undefined fields do not override. */
  overrides?: ArgusConfig;
  env?: NodeJS.ProcessEnv;
}

export function load_config(repo_root: string, opts: LoadOptions = {}): ConfigLoad {
  const problems: string[] = [];
  const sources: string[] = [];
  let config = DEFAULT_CONFIG;

  for (const file of [shared_config_path(repo_root), local_config_path(repo_root)]) {
    const parsed = read_json(file, problems);
    if (parsed) {
      sources.push(file);
      config = merge(config, parsed);
    }
  }

  config = merge(config, from_environment(opts.env ?? process.env));
  if (opts.overrides) {
    sources.push("(arguments)");
    config = merge(config, prune(opts.overrides));
  }
  return { config, sources, problems };
}

/** Drop undefined fields so an unset CLI flag does not erase a configured value. */
function prune(config: ArgusConfig): ArgusConfig {
  const coderabbit = config.ingest?.coderabbit ?? {};
  const kept: IngestSourceConfig = {};
  if (coderabbit.path !== undefined) {
    kept.path = coderabbit.path;
  }
  if (coderabbit.severities !== undefined) {
    kept.severities = coderabbit.severities;
  }
  return { ingest: { coderabbit: kept } };
}
