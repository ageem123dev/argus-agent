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
  read_run_records,
  find_run_for_commit,
  default_record_path,
  resolve_commit,
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
  distill_lessons,
  lesson_from_finding,
  lessons_from_findings,
  matches_filter,
  rank_by_overlap,
  rank_scoped,
  recall_filter,
  score_overlap,
  tokenize,
} from "./memory.mjs";
export type {
  DistilledLesson,
  LessonOptions,
  MemorySearchFilter,
  MemoryTrace,
  VectorDB,
} from "./memory.mjs";
export {
  classify_topic,
  language_of,
  language_name,
  languages_of,
  recall_scopes,
  scope_key,
  LANGUAGE_BY_EXTENSION,
  LANGUAGE_DISPLAY,
  locus_from_path,
  make_finding,
  normalize_path,
  normalize_severity,
  parse_findings,
  severity_weight,
  strip_markdown,
  SEVERITY_WEIGHT,
  TOPICS,
} from "./findings.mjs";
export type { Finding } from "./findings.mjs";
export {
  ingest_findings,
  partition_findings,
  score_partition,
} from "./ingest.mjs";
export {
  load_config,
  parse_severities,
  shared_config_path,
  local_config_path,
  DEFAULT_CONFIG,
  DEFAULT_SEVERITIES,
} from "./config.mjs";
export type { ArgusConfig, ConfigLoad, IngestSourceConfig, LoadOptions } from "./config.mjs";
export {
  parse_coderabbit_reviews,
  coderabbit_adapter,
  load_reviews,
  discover_coderabbit_dirs,
  resolve_coderabbit_paths,
  workspace_storage_roots,
  CODERABBIT_SEVERITY,
} from "./adapters/coderabbit.mjs";
export type {
  CodeRabbitReview,
  CodeRabbitParseOptions,
  LoadedReview,
} from "./adapters/coderabbit.mjs";
export { run_ingest, format_ingest_report } from "./ingest_run.mjs";
export type { IngestRunOptions, IngestRunResult, ReviewIngestResult } from "./ingest_run.mjs";
export type {
  FindingsAdapter,
  IngestOptions,
  IngestResult,
  IngestScore,
  MatchedPair,
  Partition,
  PartitionOptions,
} from "./ingest.mjs";
export { JsonlVectorDB, default_memory_path } from "./memory_store.mjs";
export type { MemoryRecord, JsonlVectorDBOptions } from "./memory_store.mjs";
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
  GeminiReasoning,
  GeminiClient,
  GeminiError,
  call_gemini,
  has_api_key,
  resolve_api_key,
  GEMINI_ROUTING,
  CLAUDE_TO_GEMINI,
} from "./providers/gemini.mjs";
export {
  load_plugin,
  plugin_spec,
  PluginError,
  type ReasoningPlugin,
} from "./providers/plugin.mjs";
export { PROVIDERS, resolve_route, route_note, type Provider } from "./routing.mjs";
export {
  REVIEW_PROMPT,
  REVIEW_SCHEMA,
  EmptyReviewError,
  interpret_review,
  render_verdict,
  tier_for_size,
} from "./review_schema.mjs";
export type {
  ProviderCallTrace,
  ProviderOptions,
  ProviderUsage,
} from "./provider_trace.mjs";
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
