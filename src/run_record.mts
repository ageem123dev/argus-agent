/**
 * Durable run records.
 *
 * Argus builds a hash-chained audit log per review and then throws it away when
 * the process exits — governance.mts says as much ("in production: persist +
 * replicate"). This module is that persistence: one JSON object per review,
 * appended to a JSONL file, carrying the audit entries and their hashes so the
 * chain stays verifiable after the fact.
 *
 * It also records which model actually ran and the provider's replay handle,
 * which are otherwise unrecoverable — a provider's own log is overwritten on
 * invocation, so by the second review the first one's log is gone.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ReviewOutcome } from "./argus.mjs";
import type { ProviderCallTrace } from "./provider_trace.mjs";

export interface RunRecord {
  /** ISO-8601, UTC. */
  timestamp: string;
  project: string;
  repo_root: string;
  /**
   * HEAD at review time. The join key for anything that scores Argus after the
   * fact — a second reviewer's findings can only be matched to the run that
   * should have caught them if both name the same commit. Absent when the repo
   * has no commits or git is unavailable.
   */
  commit?: string;
  provider: string;
  /**
   * What was asked for, when it differs from `provider`. `auto` resolves at
   * startup and can degrade again at runtime, so the two are not the same
   * question.
   */
  provider_requested?: string;
  /**
   * Set when a fallback produced the verdict. `provider` already names the
   * path that answered; this records what was tried first and why it was
   * abandoned, so a degraded review is never mistaken for a clean one.
   */
  fallback?: { attempted: string; used: string; reason: string; attempts: number };
  /** Entry point that ran the review: "cli" or "mcp". */
  invoked_via: string;
  /** Distinct models actually used, in call order. */
  models: string[];
  /** Provider replay handles, where the provider offers them. */
  conversation_ids: string[];
  /** Tier that selected the model. Differs from `complexity` by design. */
  routing_tier?: string;
  /** The reasoner's own assessment of the change. */
  complexity: string;
  confidence: number;
  verdict: string;
  blocked_reason?: string;
  perception: { discovered: number; selected: number; selectivity: number };
  /** Which store was in use, and how many lessons moved in each direction. */
  memory: Record<string, unknown>;
  reflection: Record<string, unknown>;
  collaboration: Record<string, unknown>;
  governance: Record<string, unknown>;
  actions: Array<{ tool: string; duration_ms: number; blocked: boolean; error: boolean }>;
  /**
   * Per-review provider cost.
   *
   * Still spelled `agy` because 270 records were written under that key
   * before the provider moved out of this repository, and ingestion joins
   * against them. A record is an audit artefact: renaming the field would
   * silently orphan the history it exists to preserve.
   */
  agy: { calls: number; total_tokens: number; input_tokens: number; output_tokens: number };
  /** The hash chain itself, so the record can be re-verified independently. */
  audit: Array<{
    timestamp: number;
    actor: string;
    action: string;
    decision: string;
    prev_hash: string;
    self_hash: string;
    payload: Record<string, unknown>;
  }>;
}

export interface RunRecordContext {
  project: string;
  repo_root: string;
  /** Usually from resolve_commit(); injectable so build_run_record stays pure. */
  commit?: string;
  provider: string;
  /** What the caller asked for; `provider` is what actually answered. */
  provider_requested?: string;
  invoked_via: string;
  calls: ProviderCallTrace[];
  /** Present unless governance blocked before an agent was constructed. */
  audit_entries?: Array<Record<string, unknown>>;
  now?: () => Date;
}

/** Assemble a record from a completed review. Pure — does no I/O. */
export function build_run_record(outcome: ReviewOutcome, ctx: RunRecordContext): RunRecord {
  const review = outcome.review;
  const p = outcome.perception_trace;
  const sum = (pick: (t: ProviderCallTrace) => number) => ctx.calls.reduce((a, t) => a + pick(t), 0);

  return {
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    project: ctx.project,
    repo_root: path.resolve(ctx.repo_root),
    commit: ctx.commit,
    provider: ctx.provider,
    provider_requested: ctx.provider_requested,
    fallback: review?.fallback,
    invoked_via: ctx.invoked_via,
    models: [...new Set(ctx.calls.map((t) => t.model))],
    conversation_ids: ctx.calls.map((t) => t.conversation_id).filter(Boolean),
    routing_tier: review?.routing_tier,
    complexity: review?.complexity ?? "",
    confidence: review?.confidence ?? 0,
    verdict: review?.verdict ?? "",
    blocked_reason: outcome.blocked_reason ?? undefined,
    perception: {
      discovered: p?.files_discovered ?? 0,
      selected: p?.files_selected ?? 0,
      selectivity: p?.selectivity ?? 0,
    },
    memory: outcome.memory_meta,
    reflection: outcome.reflection_meta,
    collaboration: outcome.collaboration_meta,
    governance: outcome.governance_meta,
    actions: outcome.action_log.map((a) => ({
      tool: a.tool,
      duration_ms: a.duration_ms,
      blocked: Boolean(a.guardrail_blocked),
      error: Boolean(a.error),
    })),
    agy: {
      calls: ctx.calls.length,
      total_tokens: sum((t) => t.usage.total_tokens),
      input_tokens: sum((t) => t.usage.input_tokens),
      output_tokens: sum((t) => t.usage.output_tokens),
    },
    audit: (ctx.audit_entries ?? []) as RunRecord["audit"],
  };
}

/**
 * HEAD of the repo under review, or undefined if there isn't one.
 *
 * Not called from build_run_record, which stays pure: callers resolve this and
 * pass it in, so a record can be rebuilt from a trace without shelling out.
 */
export function resolve_commit(repo_root: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo_root,
      encoding: "utf-8",
      timeout: 10_000,
      // A repo with no commits writes to stderr and exits non-zero; both are
      // expected here, and neither should reach the caller's console.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Default sink: `<repo_root>/.argus/runs.jsonl`. */
export function default_record_path(repo_root: string): string {
  return path.join(path.resolve(repo_root), ".argus", "runs.jsonl");
}

/**
 * Read the log back. Tolerant of a half-written trailing line, for the same
 * reason the memory store is: a killed process must cost one record, not all
 * of them. A missing file reads as no history.
 */
export function read_run_records(file: string): RunRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as RunRecord);
    } catch {
      continue;
    }
  }
  return records;
}

/**
 * The review that should have caught a finding on `commit` — the most recent
 * one over that commit, since a repeat review supersedes its predecessor.
 *
 * Matching is by prefix so a short SHA from a CI log or an MR page joins
 * against the full one recorded here.
 */
export function find_run_for_commit(
  records: RunRecord[],
  commit: string,
  project?: string,
): RunRecord | undefined {
  const wanted = commit.trim().toLowerCase();
  if (!wanted) {
    return undefined;
  }
  return records
    .filter((r) => {
      const sha = r.commit?.toLowerCase();
      if (!sha) {
        return false;
      }
      const joins = sha.startsWith(wanted) || wanted.startsWith(sha);
      return joins && (!project || r.project === project);
    })
    .at(-1);
}

/**
 * Append one record. Never throws: a review that succeeded must not be reported
 * as failed because its log could not be written. Returns the failure instead.
 */
export function append_run_record(file: string, record: RunRecord): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
