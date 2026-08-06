/**
 * Durable run records.
 *
 * Argus builds a hash-chained audit log per review and then throws it away when
 * the process exits — governance.mts says as much ("in production: persist +
 * replicate"). This module is that persistence: one JSON object per review,
 * appended to a JSONL file, carrying the audit entries and their hashes so the
 * chain stays verifiable after the fact.
 *
 * It also records which model actually ran and the agy conversation id, which
 * are otherwise unrecoverable — agy's own cli.log is overwritten on every
 * invocation, so by the second review the first one's log is gone.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ReviewOutcome } from "./argus.mjs";
import type { AgyCallTrace } from "./providers/antigravity.mjs";

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
  /** Entry point that ran the review: "cli" or "mcp". */
  invoked_via: string;
  /** Distinct models actually used, in call order. Empty for non-agy providers. */
  models: string[];
  /** agy conversation ids — replay with `agy --conversation <id> -p "..."`. */
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
  invoked_via: string;
  calls: AgyCallTrace[];
  /** Present unless governance blocked before an agent was constructed. */
  audit_entries?: Array<Record<string, unknown>>;
  now?: () => Date;
}

/** Assemble a record from a completed review. Pure — does no I/O. */
export function build_run_record(outcome: ReviewOutcome, ctx: RunRecordContext): RunRecord {
  const review = outcome.review;
  const p = outcome.perception_trace;
  const sum = (pick: (t: AgyCallTrace) => number) => ctx.calls.reduce((a, t) => a + pick(t), 0);

  return {
    timestamp: (ctx.now?.() ?? new Date()).toISOString(),
    project: ctx.project,
    repo_root: path.resolve(ctx.repo_root),
    commit: ctx.commit,
    provider: ctx.provider,
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
