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
import * as fs from "node:fs";
import * as path from "node:path";

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
  /** Re-learn from reviews already ingested. Off by default — see ingest_ledger. */
  reingest?: boolean;
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
  /**
   * Configured paths that do not exist. Kept separate from "found no reviews":
   * a store that exists and is empty means CodeRabbit has not reviewed yet,
   * which is a legitimate null result, while a path that is not there is a
   * misconfiguration. Reporting both as "0 misses" would let a broken setup
   * read as a clean bill of health.
   */
  missing_paths: string[];
  reviews: ReviewIngestResult[];
  /** Findings dropped by the severity filter across all reviews. */
  filtered_out: number;
  /**
   * Why a capture yielded no reviews — an unfinished review, an interrupted
   * stream. Distinct from `config_problems`, and the difference between "no
   * findings" and "no result" lives here.
   */
  source_problems: string[];
  written: number;
  memory_file?: string;
}

/**
 * Reviews already learned from: `<repo>/.argus/ingested.json`.
 *
 * Without it, ingestion is not idempotent. Re-running it over an unchanged
 * CodeRabbit review rewrites the same lessons and bumps each one's `seen`
 * count again — so a store built from four reviews reported a lesson as
 * confirmed sixteen times. `seen` is meant to say how many independent reviews
 * reached the same conclusion; letting it count command invocations turns the
 * one signal that distinguishes a recurring problem from a one-off into noise.
 */
export function ingest_ledger_path(repo_root: string): string {
  return path.join(path.resolve(repo_root), ".argus", "ingested.json");
}

function read_ledger(file: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function write_ledger(file: string, ledger: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + "\n", "utf-8");
  } catch {
    // A ledger that cannot be written costs idempotence, not correctness.
  }
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
    missing_paths: paths.filter((p) => !fs.existsSync(p)),
    reviews: [],
    filtered_out: 0,
    source_problems: [],
    written: 0,
  };
  if (!paths.length) {
    return result;
  }

  const reviews = paths.flatMap((p) =>
    load_reviews(p, {
      severities: source.severities,
      // CLI streams carry no SHA; the join key can only come from the caller.
      commit: opts.commit,
      on_problem: (problem) => result.source_problems.push(problem),
    }),
  );
  if (!reviews.length) {
    return result;
  }

  const runs = read_run_records(opts.record_file ?? default_record_path(opts.repo_root));
  const ledger_file = ingest_ledger_path(opts.repo_root);
  const ledger = read_ledger(ledger_file);
  let ledger_changed = false;

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

    if (review.id && ledger[review.id] && !opts.reingest) {
      entry.skipped_reason = `already ingested on ${ledger[review.id]} (--reingest to repeat)`;
      continue;
    }
    const commit = opts.commit ?? review.head_commit;
    if (!commit) {
      entry.skipped_reason =
        review.mode === "cli"
          ? "a CLI stream records no commit — pass `commit` (git rev-parse HEAD at review time) " +
            "so the review can be joined to the Argus run of the same code"
          : "the review names no commit";
      continue;
    }
    const run = find_run_for_commit(runs, commit, opts.project);
    if (!run) {
      entry.skipped_reason = `no Argus run recorded for ${commit.slice(0, 8)}`;
      continue;
    }
    entry.matched_run = { commit: run.commit, project: run.project, timestamp: run.timestamp };

    // An empty verdict is a review that failed to produce output, not a review
    // that found nothing. Scoring it would report recall=0% and write every one
    // of the other reviewer's findings into memory as an Argus miss — blaming
    // the agent for a run that never happened, and poisoning future recall with
    // lessons drawn from a broken comparison.
    if (!run.verdict?.trim()) {
      entry.matched_run = undefined;
      entry.skipped_reason =
        `the Argus run for ${commit.slice(0, 8)} recorded an empty verdict ` +
        `(provider "${run.provider ?? "?"}" produced no output) — re-run the review before ingesting`;
      continue;
    }

    const outcome = ingest_findings(
      parse_findings(run.verdict ?? "", "argus"),
      review.findings,
      opts.project,
      { attribution: "coderabbit" },
    );
    entry.score = outcome.score;
    entry.lessons = outcome.lessons;

    if (!opts.dry_run) {
      if (outcome.lessons.length) {
        const m = store();
        for (const lesson of outcome.lessons) {
          m.memory.add(lesson.text, "reflection", lesson.importance, {
            project: opts.project,
            language: lesson.language,
            locus: lesson.locus,
          });
        }
        m.memory.consolidate();
        result.written += outcome.lessons.length;
      }
      // Recorded even when the comparison yielded no lessons: the review has
      // been accounted for, and re-reading it would find nothing new either.
      if (review.id) {
        ledger[review.id] = new Date().toISOString();
        ledger_changed = true;
      }
    }
  }

  if (ledger_changed) {
    write_ledger(ledger_file, ledger);
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
    const missing = r.missing_paths.includes(p) ? "  (does not exist)" : "";
    lines.push(`  ${r.discovered ? "discovered" : "configured"}: ${p}${missing}`);
  }
  if (r.missing_paths.length === r.paths.length) {
    lines.push(
      "  that path does not exist — check ingest.coderabbit.path, ARGUS_CODERABBIT_PATH, or --from.",
      "  Note the filename under coderabbit.coderabbit-vscode/ is a content hash that changes",
      "  per review; point at the directory, not at one file.",
    );
    return lines.join("\n");
  }
  if (!r.reviews.length) {
    // Say which: "nothing has been reviewed yet" and "a review ran but did not
    // finish" are the same empty list and opposite facts.
    if (r.source_problems.length) {
      lines.push("  no usable review found:");
      for (const problem of r.source_problems) {
        lines.push(`    ${problem}`);
      }
    } else {
      lines.push("  the store is there but holds no completed reviews yet.");
    }
    return lines.join("\n");
  }
  for (const problem of r.source_problems) {
    lines.push(`  note: ${problem}`);
  }

  for (const entry of r.reviews) {
    // The commit the review was *joined on*, which for a CLI capture comes from
    // the caller rather than the stream. Reporting the stream's own field showed
    // "over ?" on a join that had in fact succeeded.
    const commit = (entry.matched_run?.commit ?? entry.review.head_commit)?.slice(0, 8) ?? "?";
    lines.push(`\n  review ${entry.review.id?.slice(0, 12) ?? "?"} over ${commit}`);
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
