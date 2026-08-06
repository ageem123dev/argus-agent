/**
 * `argus ingest` — score Argus against CodeRabbit and learn from the misses.
 *
 * The flow: find CodeRabbit's reviews, keep the severities configured as worth
 * recording, join each review to the Argus run over the same commit, partition
 * the two sets of findings, and write only what Argus missed into memory.
 *
 * Reviews that cannot be joined to a run are reported, not guessed at. Without
 * a matching run there is nothing to compare against, and treating every
 * CodeRabbit finding as a miss would flood memory with lessons Argus never had
 * a chance to learn.
 */
import { load_reviews, resolve_coderabbit_paths, type LoadedReview } from "./adapters/coderabbit.mjs";
import { load_config, type ArgusConfig } from "./config.mjs";
import { parse_findings } from "./findings.mjs";
import { ingest_findings, type IngestScore } from "./ingest.mjs";
import { ArgusMemory, HierarchicalMemory, type DistilledLesson } from "./memory.mjs";
import { JsonlVectorDB, default_memory_path } from "./memory_store.mjs";
import { default_record_path, find_run_for_commit, read_run_records } from "./run_record.mjs";

export interface IngestRunOptions {
  repo_root: string;
  project: string;
  /** Overrides the configured path. */
  from?: string;
  /** Overrides the configured severities. */
  severities?: string[];
  /** Ignore each review's headCommitId and join everything to this commit. */
  commit?: string;
  /** Compare and report, write nothing. */
  dry_run?: boolean;
  record_file?: string;
  memory_file?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReviewIngestResult {
  review: LoadedReview;
  /** The Argus run this was compared against, if one was found. */
  matched_run?: { commit?: string; project: string; timestamp: string };
  skipped_reason?: string;
  score?: IngestScore;
  lessons: DistilledLesson[];
}

export interface IngestRunResult {
  config: ArgusConfig;
  config_sources: string[];
  config_problems: string[];
  /** Where reviews were read from, and whether that was discovered or configured. */
  paths: string[];
  discovered: boolean;
  reviews: ReviewIngestResult[];
  /** Findings dropped by the severity filter across all reviews. */
  filtered_out: number;
  written: number;
  memory_file?: string;
}

export function run_ingest(opts: IngestRunOptions): IngestRunResult {
  const { config, sources, problems } = load_config(opts.repo_root, {
    env: opts.env,
    overrides: {
      ingest: { coderabbit: { path: opts.from, severities: opts.severities } },
    },
  });
  const source = config.ingest?.coderabbit ?? {};
  const { paths, discovered } = resolve_coderabbit_paths(
    opts.repo_root,
    source.path,
    opts.env ?? process.env,
  );

  const result: IngestRunResult = {
    config,
    config_sources: sources,
    config_problems: problems,
    paths,
    discovered,
    reviews: [],
    filtered_out: 0,
    written: 0,
  };
  if (!paths.length) {
    return result;
  }

  const reviews = paths.flatMap((p) => load_reviews(p, { severities: source.severities }));
  if (!reviews.length) {
    return result;
  }

  const runs = read_run_records(opts.record_file ?? default_record_path(opts.repo_root));

  // Opened once and only if something is actually written: ingestion should
  // not create an empty memory store just by being run.
  let memory: ArgusMemory | null = null;
  const memory_file = opts.memory_file ?? default_memory_path(opts.repo_root);
  const store = () => {
    if (!memory) {
      memory = new ArgusMemory(new HierarchicalMemory(new JsonlVectorDB(memory_file)));
      result.memory_file = memory_file;
    }
    return memory;
  };

  for (const review of reviews) {
    result.filtered_out += review.filtered_out;
    const entry: ReviewIngestResult = { review, lessons: [] };
    result.reviews.push(entry);

    const commit = opts.commit ?? review.head_commit;
    if (!commit) {
      entry.skipped_reason = "the review names no commit";
      continue;
    }
    const run = find_run_for_commit(runs, commit, opts.project);
    if (!run) {
      entry.skipped_reason = `no Argus run recorded for ${commit.slice(0, 8)}`;
      continue;
    }
    entry.matched_run = { commit: run.commit, project: run.project, timestamp: run.timestamp };

    const outcome = ingest_findings(
      parse_findings(run.verdict ?? "", "argus"),
      review.findings,
      opts.project,
      { attribution: "coderabbit" },
    );
    entry.score = outcome.score;
    entry.lessons = outcome.lessons;

    if (!opts.dry_run && outcome.lessons.length) {
      const m = store();
      for (const lesson of outcome.lessons) {
        m.memory.add(lesson.text, "reflection", lesson.importance, opts.project);
      }
      m.memory.consolidate();
      result.written += outcome.lessons.length;
    }
  }
  return result;
}

/** Human-readable report — the CLI prints this verbatim. */
export function format_ingest_report(r: IngestRunResult): string {
  const lines: string[] = [];
  const severities = r.config.ingest?.coderabbit?.severities;

  lines.push("=== Ingest (coderabbit) ===");
  lines.push(`  recording: ${severities?.join(", ") ?? "every severity"}`);
  if (r.config_sources.length) {
    lines.push(`  config: ${r.config_sources.join(" < ")}`);
  }
  for (const problem of r.config_problems) {
    lines.push(`  config problem: ${problem}`);
  }

  if (!r.paths.length) {
    lines.push(
      "  no CodeRabbit review store found.",
      "  Set ingest.coderabbit.path in .argus/config.json (or ARGUS_CODERABBIT_PATH,",
      "  or --from) to the extension's directory for this workspace.",
    );
    return lines.join("\n");
  }
  for (const p of r.paths) {
    lines.push(`  ${r.discovered ? "discovered" : "configured"}: ${p}`);
  }
  if (!r.reviews.length) {
    lines.push("  no completed reviews found there.");
    return lines.join("\n");
  }

  for (const entry of r.reviews) {
    const commit = entry.review.head_commit?.slice(0, 8) ?? "?";
    lines.push(`\n  review ${entry.review.id?.slice(0, 8) ?? "?"} over ${commit}`);
    if (entry.skipped_reason) {
      lines.push(`    skipped: ${entry.skipped_reason}`);
      continue;
    }
    const s = entry.score!;
    lines.push(
      `    agreed=${s.agreed}  missed=${s.missed}  argus_only=${s.argus_only}` +
        `  recall=${(s.recall * 100).toFixed(0)}%  confirmed=${(s.confirmed_rate * 100).toFixed(0)}%`,
    );
    for (const lesson of entry.lessons) {
      lines.push(`    lesson: ${lesson.text}`);
    }
  }

  if (r.filtered_out) {
    lines.push(
      `\n  ${r.filtered_out} finding(s) below the recorded severities were skipped.`,
    );
  }
  lines.push(
    r.written
      ? `  wrote ${r.written} lesson(s) to ${r.memory_file}`
      : "  wrote nothing.",
  );
  lines.push(
    "",
    "  confirmed% is a floor on precision, not precision: an Argus-only finding is",
    "  unconfirmed, not wrong. Watch it over time rather than reading one run.",
  );
  return lines.join("\n");
}
