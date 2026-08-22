/**
 * Argus — the whole agent, wired together. One class per cognitive function,
 * composed (not inherited) into a single review() flow:
 *
 *   1. governance authorizes the review
 *   2. perception gathers the relevant files
 *   3. memory retrieves prior lessons for this project
 *   4. collaboration optionally fans out to sub-agents on complex diffs
 *   5. action runs deterministic verifiers (lint/tests) for evidence
 *   6. reasoning produces the verdict, routed by complexity
 *   7. reflection critiques the verdict, drops likely false positives
 *   8. memory persists the new lesson
 *   9. governance closes the audit chain
 *
 * Each step is observable via its own trace class; ReviewOutcome gathers
 * them all.
 */
import { extract_modified_files, gather_review_context, PerceptionTrace } from "./perception.mjs";
import { ArgusMemory, HierarchicalMemory } from "./memory.mjs";
import { JsonlVectorDB, default_memory_path } from "./memory_store.mjs";
import { load_config } from "./config.mjs";
import { ArgusReasoning, ReviewResult } from "./reasoning.mjs";
import { ArgusAction, ActionTrace } from "./action.mjs";
import { ArgusReflection } from "./reflection.mjs";
import { ArgusCollaboration } from "./collaboration.mjs";
import { ArgusGovernance, Capability, TrustLevel } from "./governance.mjs";

/** One per review — gathers every cognitive trace. */
export class ReviewOutcome {
  action_log: ActionTrace[] = [];
  memory_meta: Record<string, unknown> = {};
  reflection_meta: Record<string, unknown> = {};
  collaboration_meta: Record<string, unknown> = {};
  governance_meta: Record<string, unknown> = {};
  blocked_reason: string | null = null;

  constructor(
    public review: ReviewResult | null,
    public perception_trace: PerceptionTrace | null,
    init: Partial<ReviewOutcome> = {},
  ) {
    Object.assign(this, init);
  }
}

export interface ArgusModules {
  /**
   * Overrides the durable store Argus would otherwise open under the repo —
   * pass one to relocate memory, or `new ArgusMemory()` for a process-local
   * one. To switch memory off for a review, use `remember: false` instead.
   */
  memory?: ArgusMemory | null;
  reasoning?: ArgusReasoning | null;
  action?: ArgusAction | null;
  reflection?: ArgusReflection | null;
  collaboration?: ArgusCollaboration | null;
  governance?: ArgusGovernance | null;
}

export interface ReviewRequest {
  diff: string;
  project: string;
  repo_root?: string;
  budget?: number;
  delegate_complex?: boolean;
  verify_with_tools?: boolean;
  refine?: boolean;
  /**
   * Recall lessons from past reviews of this repo, and retain new ones.
   * On unless explicitly switched off — this is the only off switch, and it
   * suppresses both directions, whatever store happens to be attached.
   */
  remember?: boolean;
}

/** The consolidated agent. `new Argus()` works with zero configuration. */
export class Argus {
  memory: ArgusMemory;
  reasoning: ArgusReasoning;
  action: ArgusAction;
  reflection: ArgusReflection;
  collaboration: ArgusCollaboration;
  governance: ArgusGovernance;

  private _injected_memory: ArgusMemory | null;
  private _memory_by_root = new Map<string, ArgusMemory>();

  constructor(modules: ArgusModules = {}) {
    // Each module is its own injectable class — composition, not inheritance.
    this._injected_memory = modules.memory ?? null;
    // Stands in until review() resolves the durable store; a caller reading
    // .memory before the first review still gets a usable object.
    this.memory = modules.memory ?? new ArgusMemory();
    this.reasoning = modules.reasoning ?? new ArgusReasoning();
    this.action = modules.action ?? new ArgusAction();
    this.reflection = modules.reflection ?? new ArgusReflection();
    this.collaboration = modules.collaboration ?? new ArgusCollaboration();
    this.governance = modules.governance ?? new ArgusGovernance(TrustLevel.ACT_THEN_REVIEW);
  }

  /**
   * The memory for a given repo. Resolved here rather than in the constructor
   * because the store lives in the repo under review, and `repo_root` arrives
   * with the request — which is why memory could not simply default to durable
   * at construction time.
   *
   * Stores are cached per resolved path, so an instance reviewing the same repo
   * repeatedly reads the file once, and one reviewing several repos keeps their
   * lessons apart.
   */
  private _memory_for(repo_root: string, remember: boolean): ArgusMemory {
    if (this._injected_memory) {
      return this._injected_memory;
    }
    if (!remember) {
      // Fresh and process-local: nothing to recall, and nothing it retains
      // outlives this call — including across reviews on the same instance.
      return new ArgusMemory();
    }
    const file = default_memory_path(repo_root);
    let memory = this._memory_by_root.get(file);
    if (!memory) {
      // The pool is opened per repo because its path is configured per repo,
      // even though the file itself is shared between them.
      const shared = load_config(repo_root).config.memory?.shared;
      memory = new ArgusMemory(
        new HierarchicalMemory(new JsonlVectorDB(file)),
        shared ? new JsonlVectorDB(shared) : undefined,
      );
      this._memory_by_root.set(file, memory);
    }
    return memory;
  }

  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    const { diff, project } = request;
    const repo_root = request.repo_root ?? ".";
    const budget = request.budget ?? 50_000;
    const delegate_complex = request.delegate_complex ?? true;
    const verify_with_tools = request.verify_with_tools ?? true;
    const refine = request.refine ?? true;
    const remember = request.remember ?? true;
    this.memory = this._memory_for(repo_root, remember);

    // 1. governance — is this review allowed at all?
    const auth = this.governance.authorize("perceive", Capability.READ_FILES, { repo: repo_root });
    if (!auth.allowed) {
      return new ReviewOutcome(null, null, {
        blocked_reason: auth.reason,
        governance_meta: { allowed: false, reason: auth.reason },
      });
    }

    // 2. perception — gather files
    const [selected, p_trace] = gather_review_context(diff, repo_root, budget);

    // 3. memory (before) — recall prior lessons
    //
    // The query is every path the diff touches, not a prefix of the diff text.
    // Slicing the first 300 characters saw one file header, so recall was
    // decided by whichever lesson happened to share a token with the
    // alphabetically-first changed file: measured over 18 real reviews, 61% of
    // recalled lessons pointed at directories the diff never touched. Lessons
    // are keyed by locus, so the set of changed paths is the natural query.
    //
    // The paths also scope recall by language and place together. A directory
    // does not imply a language — .tsx, .css and .md sit side by side — so a
    // lesson about the Markdown in a folder must not surface for a change that
    // touched only the TypeScript there.
    const changed = extract_modified_files(diff);
    const past_lessons = remember
      ? this.memory.before_review(
          project,
          changed,
          // Only when the diff named no files at all.
          changed.length ? undefined : diff.slice(0, 300),
        )
      : [];

    // 4. collaboration — fan out to sub-agents on complex diffs
    let collab_meta: Record<string, unknown> = { delegated: false };
    let sub_synthesis = "";
    if (delegate_complex && (diff.match(/\n/g) ?? []).length > 100) {
      sub_synthesis = await this.collaboration.parallel_review(diff);
      collab_meta = {
        delegated: true,
        parallel_calls: this.collaboration.trace.parallel_calls,
        messages: this.collaboration.trace.messages.length,
      };
    }

    // 5. action — gather deterministic verifier evidence (gated by governance)
    const action_evidence: string[] = [];
    if (verify_with_tools) {
      const lint_auth = this.governance.authorize("run_lint", Capability.RUN_LINT, {
        repo: repo_root,
      });
      if (lint_auth.allowed) {
        const lint_trace = await this.action.run_lint(repo_root);
        this.governance.report_outcome(
          !lint_trace.guardrail_blocked && !lint_trace.error,
          lint_trace.guardrail_blocked,
        );
        if (lint_trace.output) {
          action_evidence.push(`lint: rc=${lint_trace.output.returncode}`);
        }
      } else {
        action_evidence.push(`lint: blocked by governance (${lint_auth.reason})`);
      }
    }

    // 6. reasoning — produce the verdict
    const sections: string[] = [];
    if (past_lessons.length) {
      sections.push("### Past lessons\n" + past_lessons.map((l) => `- ${l}`).join("\n"));
    }
    if (sub_synthesis) {
      sections.push("### Sub-agent synthesis\n" + sub_synthesis);
    }
    if (action_evidence.length) {
      sections.push("### Verification evidence\n" + action_evidence.join("\n"));
    }
    for (const c of selected) {
      sections.push(`### ${c.path}  [${c.relevance}, ${c.tokens} tokens]\n\`\`\`\n${c.content}\n\`\`\``);
    }
    const augmented = sections.length
      ? `${diff}\n\n# Project context:\n` + sections.join("\n\n")
      : diff;
    const result = await this.reasoning.review(augmented);

    // 7. reflection — critic over the verdict
    let reflection_meta: Record<string, unknown> = {};
    if (refine) {
      const refined = await this.reflection.refine(
        result.verdict,
        async (_task, ctx) =>
          (await this.reasoning.review(`${augmented}\n\n# Critic feedback:\n${ctx}`)).verdict,
        (_text) => action_evidence.join(" "),
      );
      reflection_meta = {
        iterations: refined.iterations,
        converged: refined.converged,
        final_score: refined.final_score,
      };
      result.verdict = refined.output;
      result.confidence = Math.min(result.confidence, refined.final_score);
    }

    // 8. memory (after) + outcome bookkeeping
    this.governance.report_outcome((reflection_meta.converged as boolean) ?? true);
    this.reflection.record_outcome(
      `review:${project}`,
      (reflection_meta.converged as boolean) ?? true,
    );
    // The full verdict, not a truncation: ArgusMemory distills it into
    // generalizations, and a verdict cut at 200 chars usually loses the
    // finding that was worth generalizing from.
    const stored = remember ? this.memory.after_review(result.verdict, project) : [];
    const store = this.memory.memory.vector_db;
    const memory_meta = remember
      ? {
          ...(store.describe?.() ?? { store: this.memory.trace.store }),
          recalled: past_lessons.length,
          stored: stored.length,
        }
      : { store: "disabled", recalled: 0, stored: 0 };

    // 9. governance — close audit chain
    const [chain_ok, chain_len] = this.governance.audit.verify_chain();
    const governance_meta = {
      allowed: true,
      audit_entries: chain_len,
      audit_chain_ok: chain_ok,
      current_trust: this.governance.current_trust().level,
      promotions: this.governance.trace.promotions,
      demotions: this.governance.trace.demotions,
    };

    return new ReviewOutcome(result, p_trace, {
      action_log: this.action.action_log,
      memory_meta,
      reflection_meta,
      collaboration_meta: collab_meta,
      governance_meta,
    });
  }
}
