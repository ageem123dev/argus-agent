/**
 * Ingestion — scoring Argus against a second reviewer.
 *
 * Another reviewer running over the same commit partitions the findings three
 * ways, and the three sets mean different things:
 *
 *   * agreed      — both found it. Confirmation, and the least interesting set.
 *   * missed      — only the other reviewer found it. Supervised signal: the
 *                   thing Argus should have caught and did not.
 *   * argus_only  — only Argus found it. Either a false positive or a genuine
 *                   catch the other reviewer does not do. Not separable from
 *                   here, which is exactly why the count is worth tracking:
 *                   it is the precision side of the ledger.
 *
 * Only `missed` becomes memory. `argus_only` is deliberately *not* fed back —
 * reinforcing Argus's unconfirmed findings is how a reviewer talks itself into
 * its own false positives.
 *
 * The adapter that reads a specific reviewer's output format is separate on
 * purpose: everything here works on normalized Findings and knows nothing
 * about who produced them or how they were serialized.
 */
import { lessons_from_findings, type DistilledLesson } from "./memory.mjs";
import type { Finding } from "./findings.mjs";

/**
 * Reads one reviewer's output into normalized findings.
 *
 * Implementations are per-format, not per-reviewer: a tool that can emit both
 * JSON and markdown needs two.
 */
export interface FindingsAdapter {
  /** Format name, as the CLI would name it. */
  readonly format: string;
  /** Parse raw output. Must not throw on malformed input — return what it can. */
  parse(raw: string): Finding[];
}

export interface MatchedPair {
  argus: Finding;
  external: Finding;
  /** Why these were judged the same finding — "path+line" or "path+topic". */
  matched_on: string;
}

export interface Partition {
  agreed: MatchedPair[];
  /** External-only: what Argus missed. */
  missed: Finding[];
  /** Argus-only: unconfirmed, and possibly false positives. */
  argus_only: Finding[];
}

export interface PartitionOptions {
  /**
   * How far apart two line numbers can be and still be the same finding.
   * Reviewers disagree about whether to cite the call or the declaration, so
   * exact-line matching under-counts agreement badly.
   */
  line_window?: number;
}

/** Same file, and close enough in it to plausibly be the same thing. */
function same_place(a: Finding, b: Finding, window: number): boolean {
  if (!a.path || !b.path || a.path !== b.path) {
    return false;
  }
  if (a.line == null || b.line == null) {
    return true; // same file and no line to separate them
  }
  return Math.abs(a.line - b.line) <= window;
}

function match_reason(a: Finding, b: Finding, window: number): string | null {
  if (!same_place(a, b, window)) {
    return null;
  }
  // Same place is not sufficient: two reviewers can flag one line for two
  // unrelated reasons, and calling that agreement inflates the agreed set.
  if (a.topic && b.topic) {
    return a.topic === b.topic ? "path+topic" : null;
  }
  // One side unclassified — proximity is the best evidence available.
  return a.line != null && b.line != null ? "path+line" : "path";
}

/**
 * Three-way partition. Greedy and first-match-wins: one external finding can
 * confirm at most one Argus finding, so a reviewer that reports the same issue
 * twice cannot make Argus look twice as accurate.
 *
 * Known limit: matching is heuristic, and its failure mode is asymmetric. Two
 * different issues on one line are counted as agreement whenever the topic
 * classifier lands both in the same class (or cannot classify either) — which
 * overstates recall rather than understating it. `matched_on` records how each
 * pair was judged, so "path+line" agreement can be discounted against
 * "path+topic" when the numbers matter.
 */
export function partition_findings(
  argus: Finding[],
  external: Finding[],
  opts: PartitionOptions = {},
): Partition {
  const window = opts.line_window ?? 5;
  const agreed: MatchedPair[] = [];
  const claimed_argus = new Set<number>();
  const claimed_external = new Set<number>();

  for (const [ei, e] of external.entries()) {
    for (const [ai, a] of argus.entries()) {
      if (claimed_argus.has(ai)) {
        continue;
      }
      const matched_on = match_reason(a, e, window);
      if (matched_on) {
        agreed.push({ argus: a, external: e, matched_on });
        claimed_argus.add(ai);
        claimed_external.add(ei);
        break;
      }
    }
  }

  return {
    agreed,
    missed: external.filter((_, i) => !claimed_external.has(i)),
    argus_only: argus.filter((_, i) => !claimed_argus.has(i)),
  };
}

/** The numbers worth persisting per ingestion, so precision stays measurable. */
export interface IngestScore {
  agreed: number;
  missed: number;
  argus_only: number;
  /** agreed / (agreed + missed) — of what the other reviewer found, how much Argus caught. */
  recall: number;
  /** agreed / (agreed + argus_only) — a floor, not the true rate, see below. */
  confirmed_rate: number;
}

/**
 * Score a partition.
 *
 * `confirmed_rate` is a *lower bound* on precision, not precision. An
 * Argus-only finding is unconfirmed, not wrong — the other reviewer may simply
 * not look for that class of defect. Treat a falling `confirmed_rate` as worth
 * investigating, never as a count of false positives.
 */
export function score_partition(p: Partition): IngestScore {
  const agreed = p.agreed.length;
  const denom_recall = agreed + p.missed.length;
  const denom_precision = agreed + p.argus_only.length;
  return {
    agreed,
    missed: p.missed.length,
    argus_only: p.argus_only.length,
    recall: denom_recall ? agreed / denom_recall : 1,
    confirmed_rate: denom_precision ? agreed / denom_precision : 1,
  };
}

export interface IngestOptions extends PartitionOptions {
  /** Cap on lessons written per ingestion. Defaults to the distillation cap. */
  max_lessons?: number;
  /** Names the other reviewer in the lesson text. */
  attribution?: string;
}

export interface IngestResult {
  partition: Partition;
  score: IngestScore;
  /** Written only from `missed` — never from agreed or argus_only. */
  lessons: DistilledLesson[];
}

/**
 * Compare, score, and distill — the whole ingestion, minus the adapter that
 * produced `external` and the store the lessons are written to.
 */
export function ingest_findings(
  argus: Finding[],
  external: Finding[],
  project: string,
  opts: IngestOptions = {},
): IngestResult {
  const partition = partition_findings(argus, external, opts);
  const source = external[0]?.source ?? "another reviewer";
  return {
    partition,
    score: score_partition(partition),
    lessons: lessons_from_findings(partition.missed, project, {
      max_lessons: opts.max_lessons,
      attribution: opts.attribution ?? `${source}`,
    }),
  };
}
