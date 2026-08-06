/**
 * Argus — an autonomous code-review agent (consolidated single-agent build).
 *
 * Use:
 *     import { Argus } from "argus-agent";
 *
 *     const argus = new Argus(); // zero-config: in-memory store, default policy
 *     const outcome = await argus.review({ diff: diffText, project: "my-app" });
 *
 *     console.log(outcome.review?.verdict);
 *     console.log(outcome.perception_trace?.selectivity);
 *     console.log(outcome.reflection_meta);    // iterations, converged, final_score
 *     console.log(outcome.collaboration_meta); // parallel_calls, messages
 *     console.log(outcome.governance_meta);    // audit_entries, current_trust
 */
export { init, reference_path, dist_dir } from "./init.mjs";
export type { InitResult } from "./init.mjs";
export {
  build_run_record,
  append_run_record,
  default_record_path,
} from "./run_record.mjs";
export type { RunRecord, RunRecordContext } from "./run_record.mjs";
export { Argus, ReviewOutcome } from "./argus.mjs";
export type { ArgusModules, ReviewRequest } from "./argus.mjs";

export { gather_review_context, FileContext, PerceptionTrace } from "./perception.mjs";
export {
  ArgusMemory,
  HierarchicalMemory,
  InMemoryVectorDB,
  MemoryEntry,
  MemoryTier,
} from "./memory.mjs";
export type { VectorDB } from "./memory.mjs";
export {
  ArgusReasoning,
  OfflineReasoning,
  ReviewResult,
  Complexity,
  ROUTING_TABLE,
  ChainOfThought,
  ReasoningStep,
} from "./reasoning.mjs";
export {
  AntigravityReasoning,
  AntigravityClient,
  AgyError,
  agy_available,
  run_agy,
  resolve_agy_bin,
  AGY_ROUTING,
  CLAUDE_TO_AGY,
} from "./providers/antigravity.mjs";
export type { AgyEnvelope, AgyOptions } from "./providers/antigravity.mjs";
export {
  ArgusAction,
  ActionTrace,
  Tool,
  Toolbox,
  SafetyPolicy,
  GuardrailSandwich,
  default_policy,
} from "./action.mjs";
export type { HumanApprover } from "./action.mjs";
export {
  ArgusReflection,
  ReflectionTrace,
  GeneratorCriticLoop,
  Critique,
  SkillLibrary,
  Skill,
  ExperienceReplay,
  ExecutionTrace,
  Lesson,
} from "./reflection.mjs";
export type { RefineResult } from "./reflection.mjs";
export {
  ArgusCollaboration,
  CollaborationTrace,
  AgentMessage,
  SubAgent,
  fan_out_gather,
  synthesize,
  adversarial_review,
  AdversarialVerdict,
} from "./collaboration.mjs";
export {
  ArgusGovernance,
  GovernanceDecision,
  GovernanceTrace,
  GovernanceEvent,
  Capability,
  AgentIdentity,
  PermissionGate,
  TrustLevel,
  TrustState,
  TrustEngine,
  AuditLog,
  AuditEntry,
  PolicyEngine,
  PolicyRule,
} from "./governance.mjs";
