#!/usr/bin/env node
/**
 * Argus MCP server — exposes the agent's two operations as tools over stdio.
 *
 *     claude mcp add argus -- node /path/to/argus-agent-ts/dist/mcp.mjs
 *
 *   argus_review  run a governed review of a diff
 *   argus_ingest  score a past review against CodeRabbit and learn the misses
 *
 * They are separate tools because they run on different clocks: a review
 * happens while you are writing the change, ingestion happens after another
 * reviewer has been over the same commit. Bundling ingestion into review would
 * make every review wait on a second reviewer that has usually not run yet.
 *
 * Where the /argus-review slash command is something you invoke, this lets a
 * calling agent reach for a second-opinion review on its own mid-task.
 *
 * stdout is the MCP protocol channel: nothing here may print to it. Diagnostics
 * go to stderr, review output goes back as tool content.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Argus } from "./argus.mjs";
import { ArgusReasoning, OfflineReasoning } from "./reasoning.mjs";
import {
  AntigravityReasoning,
  AntigravityClient,
  AutoAntigravityReasoning,
  resolve_route,
  type AgyCallTrace,
  type AgyOptions,
} from "./providers/antigravity.mjs";
import {
  build_run_record,
  append_run_record,
  default_record_path,
  resolve_commit,
} from "./run_record.mjs";
import { format_ingest_report, run_ingest } from "./ingest_run.mjs";
import { collect_diff, describe_diff } from "./diff.mjs";

const PROVIDERS = ["auto", "antigravity", "antigravity-shim", "anthropic", "offline"] as const;

/** Collect a diff from git, without a shell. */
function git_diff(repo_root: string, range: string): Promise<string> {
  // "--staged"/"--cached" are flags, not revisions — they must not be passed as one.
  const args =
    range === "--staged" || range === "--cached" ? ["diff", "--cached"] : ["diff", range];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: repo_root, maxBuffer: 64 << 20, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end();
  });
}

const INPUT = {
  diff: z.string().optional().describe("Unified diff text to review, inline."),
  diff_file: z.string().optional().describe("Path to a file containing a unified diff."),
  git_range: z
    .string()
    .optional()
    .describe(
      'Git revision or range to diff, e.g. "HEAD" or "main...HEAD". Raw git output, so it ' +
        "does NOT include untracked files. Prefer leaving this unset: the default collects " +
        "the branch's own work, the working tree, and untracked files together.",
    ),
  base: z
    .string()
    .optional()
    .describe(
      "Branch the change is measured from when no diff, diff_file, or git_range is given. " +
        "Defaults to main, then master, then the working tree alone. The review then covers " +
        "committed branch work and uncommitted work in one diff, matching what a reviewer " +
        "running against the base branch sees. Pass an empty string for uncommitted work only.",
    ),
  repo_root: z
    .string()
    .default(".")
    .describe("Repository root; perception gathers context from here and git runs here."),
  project: z
    .string()
    .optional()
    .describe("Project name for memory and audit scoping. Defaults to the repo directory name."),
  provider: z
    .enum(PROVIDERS)
    .default("auto")
    .describe(
      "Reasoning backend. 'auto' (the default) picks by availability and degrades at " +
        "runtime: one agy call per review, retried once if agy returns nothing, then the " +
        "shim rather than losing the review. 'antigravity' is exactly one call and fails " +
        "hard. 'antigravity-shim' drives classify/CoT/verify itself at ~20x the calls. " +
        "'offline' does no network I/O.",
    ),
  refine: z.boolean().default(true).describe("Run the generator-critic refinement loop."),
  verify_with_tools: z.boolean().default(true).describe("Run deterministic verifiers (lint)."),
  record: z
    .boolean()
    .default(true)
    .describe("Append a durable run record to <repo_root>/.argus/runs.jsonl."),
  memory: z
    .boolean()
    .default(true)
    .describe(
      "On by default: recall lessons from past reviews of this repo, and retain new ones, " +
        "in <repo_root>/.argus/memory.jsonl. Set false for a review uninfluenced by prior runs.",
    ),
};

const OUTPUT = {
  verdict: z.string(),
  /** The reasoner's own assessment of the change. */
  complexity: z.string(),
  /** The tier that selected the model — routinely disagrees with `complexity`. */
  routing_tier: z.string().optional(),
  /** Models that actually produced this review. */
  models: z.array(z.string()),
  /** Replay handles: `agy --conversation <id> -p "..."`. */
  conversation_ids: z.array(z.string()),
  confidence: z.number(),
  blocked: z.boolean(),
  blocked_reason: z.string().optional(),
  files_discovered: z.number(),
  files_selected: z.number(),
  selectivity: z.number(),
  memory_recalled: z.number(),
  memory_stored: z.number(),
  reflection_iterations: z.number().optional(),
  reflection_converged: z.boolean().optional(),
  audit_entries: z.number(),
  audit_chain_ok: z.boolean(),
  agy_calls: z.number(),
  agy_tokens: z.number(),
  record_path: z.string().optional(),
};

const server = new McpServer({ name: "argus", version: "1.0.0" });

server.registerTool(
  "argus_review",
  {
    title: "Argus code review",
    description:
      "Run Argus, an autonomous code-review agent, over a diff. Argus gathers repo context " +
      "under a token budget, reasons about the change, critiques its own verdict, and returns " +
      "findings with an audit trail. By default it reasons via Google's agy CLI (Gemini), so " +
      "it is a genuine second opinion from a different model family — verify its findings " +
      "against the real files before acting on them.",
    inputSchema: INPUT,
    outputSchema: OUTPUT,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const repo_root = args.repo_root;
    const project = args.project || path.basename(path.resolve(repo_root));

    let diff: string;
    try {
      if (args.diff) {
        diff = args.diff;
      } else if (args.diff_file) {
        diff = fs.readFileSync(args.diff_file, "utf-8");
      } else if (args.git_range) {
        diff = await git_diff(repo_root, args.git_range);
      } else {
        // Not `git diff HEAD`: that omits untracked files, so every file the
        // change *adds* was invisible while the edits around it were not -- and
        // it goes empty the moment the branch is committed, which is exactly
        // when a second reviewer is run against it.
        const collected = collect_diff(repo_root, {
          base: args.base === "" ? null : args.base,
        });
        diff = collected.diff;
        console.error(`argus: ${describe_diff(collected)}`);
      }
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Could not obtain a diff: ${msg(e)}` }],
      };
    }

    if (!diff.trim()) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              "The diff is empty — nothing to review: no commits on this branch beyond its " +
              "base, nothing uncommitted, and no untracked files. Check base/git_range, or " +
              "pass diff/diff_file.",
          },
        ],
      };
    }

    const agy_calls: AgyCallTrace[] = [];
    const agy_opts: AgyOptions = { cwd: repo_root, on_call: (t) => agy_calls.push(t) };

    // One shared resolver, so the CLI and this path cannot disagree about what
    // `auto` means or about which provider a record names.
    const { route, auto } = await resolve_route(args.provider);
    if (args.provider === "auto" && route !== "antigravity") {
      console.error(`argus: no agy binary — using the ${route} provider.`);
    }

    const reasoning =
      route === "antigravity"
        ? auto
          ? new AutoAntigravityReasoning(agy_opts)
          : new AntigravityReasoning(agy_opts)
        : route === "antigravity-shim"
          ? new ArgusReasoning(new AntigravityClient(agy_opts))
          : route === "anthropic"
            ? new ArgusReasoning()
            : new OfflineReasoning();

    // Memory is on by default; Argus opens the repo's store itself.
    const argus = new Argus({ reasoning });
    let outcome;
    try {
      outcome = await argus.review({
        diff,
        project,
        repo_root,
        verify_with_tools: args.verify_with_tools,
        refine: args.refine,
        remember: args.memory,
      });
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Review failed via provider "${args.provider}": ${msg(e)}`,
          },
        ],
      };
    }

    if (outcome.blocked_reason) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Governance blocked the review: ${outcome.blocked_reason}` },
        ],
      };
    }

    const review = outcome.review!;
    const p = outcome.perception_trace!;
    const g = outcome.governance_meta as Record<string, unknown>;
    const r = outcome.reflection_meta as Record<string, unknown>;

    let record_path: string | undefined;
    if (args.record) {
      const file = default_record_path(repo_root);
      const written = append_run_record(
        file,
        build_run_record(outcome, {
          project,
          repo_root,
          commit: resolve_commit(repo_root),
          provider: review.fallback?.used ?? route,
          provider_requested: args.provider,
          invoked_via: "mcp",
          calls: agy_calls,
          audit_entries: argus.governance.audit.entries as unknown as Array<
            Record<string, unknown>
          >,
        }),
      );
      // A failed write must not fail a successful review — report and move on.
      if (written.ok) {
        record_path = file;
      } else {
        console.error(`argus: could not write run record: ${written.error}`);
      }
    }

    const agy_tokens = agy_calls.reduce((a, t) => a + t.usage.total_tokens, 0);
    const structured = {
      verdict: review.verdict,
      complexity: review.complexity,
      routing_tier: review.routing_tier,
      models: [...new Set(agy_calls.map((t) => t.model))],
      conversation_ids: agy_calls.map((t) => t.conversation_id).filter(Boolean),
      confidence: review.confidence,
      blocked: false,
      files_discovered: p.files_discovered,
      files_selected: p.files_selected,
      selectivity: p.selectivity,
      memory_recalled: (outcome.memory_meta.recalled as number) ?? 0,
      memory_stored: (outcome.memory_meta.stored as number) ?? 0,
      reflection_iterations: r.iterations as number | undefined,
      reflection_converged: r.converged as boolean | undefined,
      audit_entries: (g.audit_entries as number) ?? 0,
      audit_chain_ok: (g.audit_chain_ok as boolean) ?? false,
      agy_calls: agy_calls.length,
      agy_tokens,
      record_path,
    };

    // Built by push, not filter(Boolean) — blank lines here are deliberate spacing.
    const lines = [
      `# Argus review — ${project}`,
      `provider: ${args.provider} · complexity: ${review.complexity}` +
        (review.routing_tier ? ` · routed as: ${review.routing_tier}` : "") +
        ` · confidence: ${review.confidence.toFixed(2)}`,
      "",
      review.verdict,
      "",
      "---",
      `perception: ${p.files_selected}/${p.files_discovered} files selected (${(p.selectivity * 100).toFixed(1)}%)`,
      `memory: ${JSON.stringify(outcome.memory_meta)}`,
      `reflection: ${JSON.stringify(outcome.reflection_meta)}`,
      `governance: audit_entries=${structured.audit_entries}, chain_ok=${structured.audit_chain_ok}`,
    ];
    if (agy_calls.length) {
      lines.push(
        `model: ${structured.models.join(", ")}`,
        `agy: ${agy_calls.length} call(s), ${agy_tokens.toLocaleString()} tokens`,
        `replay: agy --conversation ${agy_calls[0].conversation_id} -p "..."`,
      );
    }
    if (record_path) {
      lines.push(`record: ${record_path}`);
    }
    lines.push(
      "",
      "Argus reasons from a token-budgeted context slice, so confirm each finding against " +
        "the actual file before acting on it.",
    );
    const text = lines.join("\n");

    return { content: [{ type: "text" as const, text }], structuredContent: structured };
  },
);

// ---------------------------------------------------------------------------
// argus_ingest
// ---------------------------------------------------------------------------

const INGEST_INPUT = {
  repo_root: z
    .string()
    .default(".")
    .describe("Repository root. Run records, the memory store, and config are read from here."),
  project: z
    .string()
    .optional()
    .describe("Project name for memory and run-record scoping. Defaults to the repo directory name."),
  from: z
    .string()
    .optional()
    .describe(
      "Override the configured CodeRabbit path — a directory to scan, or one review file. " +
        "Normally left unset: the path comes from .argus/config.json or ARGUS_CODERABBIT_PATH, " +
        "and is discovered from VS Code's workspaceStorage when neither is set.",
    ),
  severities: z
    .array(z.string())
    .optional()
    .describe(
      "Override which CodeRabbit severities to record, in CodeRabbit's own vocabulary: " +
        'critical, major, minor, trivial. Defaults to ["critical","major"].',
    ),
  commit: z
    .string()
    .optional()
    .describe(
      "Join every review to this commit instead of its own headCommitId. For re-scoring a " +
        "review against a run it would not otherwise match; leave unset in normal use.",
    ),
  dry_run: z
    .boolean()
    .default(false)
    .describe("Compare and report without writing anything to memory."),
  reingest: z
    .boolean()
    .default(false)
    .describe(
      "Re-learn from reviews already ingested. Off by default: ingestion is idempotent, so " +
        "calling this tool repeatedly over an unchanged review reports it as skipped rather " +
        "than re-writing its lessons. Set true only to rebuild after the distillation changes.",
    ),
};

const INGEST_OUTPUT = {
  /** Directories or files reviews were read from. */
  paths: z.array(z.string()),
  /** True when `paths` came from scanning workspaceStorage rather than config. */
  discovered: z.boolean(),
  severities: z.array(z.string()),
  reviews_found: z.number(),
  reviews_compared: z.number(),
  reviews_skipped: z.number(),
  /** Totals across every compared review. */
  agreed: z.number(),
  missed: z.number(),
  argus_only: z.number(),
  /** agreed / (agreed + missed): of what CodeRabbit found, how much Argus caught. */
  recall: z.number().optional(),
  /** A floor on precision, not precision — see the tool description. */
  confirmed_rate: z.number().optional(),
  /** Findings below the recorded severities. */
  filtered_out: z.number(),
  /** Configured paths that do not exist — a misconfiguration, not an empty store. */
  missing_paths: z.array(z.string()),
  lessons_written: z.number(),
  lessons: z.array(z.string()),
  memory_file: z.string().optional(),
  config_sources: z.array(z.string()),
  config_problems: z.array(z.string()),
  /**
   * Why a capture yielded no reviews -- an unfinished review, an interrupted
   * stream, a file that is not a capture. Distinct from config_problems, and
   * the difference between "no findings" and "no result" lives here.
   */
  source_problems: z.array(z.string()),
  /** Why each unusable review was skipped, so a null result is explainable. */
  skipped: z.array(z.object({ review: z.string(), reason: z.string() })),
};

server.registerTool(
  "argus_ingest",
  {
    title: "Argus ingest (learn from CodeRabbit)",
    description:
      "Compare a past Argus review against CodeRabbit's review of the same commit, and record " +
      "what Argus missed as lessons for future reviews. Findings partition three ways: both " +
      "found it, only CodeRabbit found it (the supervised signal), and only Argus found it " +
      "(unconfirmed — either a false positive or a catch CodeRabbit does not do). Only the " +
      "misses are written to memory; reinforcing a reviewer's own unconfirmed findings is how " +
      "it talks itself into its false positives. Reviews are joined on commit SHA, and a " +
      "review with no matching Argus run is skipped rather than counted as all-misses. Note " +
      "that confirmed_rate is a floor on precision, not precision.",
    inputSchema: INGEST_INPUT,
    // Not read-only: it writes lessons to the memory store unless dry_run.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    outputSchema: INGEST_OUTPUT,
  },
  async (args) => {
    const repo_root = args.repo_root;
    const project = args.project || path.basename(path.resolve(repo_root));

    let result;
    try {
      result = run_ingest({
        repo_root,
        project,
        from: args.from,
        severities: args.severities,
        commit: args.commit,
        dry_run: args.dry_run,
        reingest: args.reingest,
      });
    } catch (e) {
      // run_ingest is written not to throw; if it ever does, report it as a
      // tool error rather than taking the server down.
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Ingestion failed: ${msg(e)}` }],
      };
    }

    const compared = result.reviews.filter((r) => r.score);
    const total = (pick: (s: NonNullable<(typeof compared)[number]["score"]>) => number) =>
      compared.reduce((a, r) => a + pick(r.score!), 0);
    const agreed = total((s) => s.agreed);
    const missed = total((s) => s.missed);
    const argus_only = total((s) => s.argus_only);

    const structured = {
      paths: result.paths,
      discovered: result.discovered,
      severities: result.config.ingest?.coderabbit?.severities ?? [],
      reviews_found: result.reviews.length,
      reviews_compared: compared.length,
      reviews_skipped: result.reviews.length - compared.length,
      agreed,
      missed,
      argus_only,
      // Undefined rather than a fabricated 1.0 when nothing was compared.
      recall: compared.length ? agreed / (agreed + missed || 1) : undefined,
      confirmed_rate: compared.length ? agreed / (agreed + argus_only || 1) : undefined,
      filtered_out: result.filtered_out,
      missing_paths: result.missing_paths,
      lessons_written: result.written,
      lessons: result.reviews.flatMap((r) => r.lessons.map((l) => l.text)),
      memory_file: result.memory_file,
      config_sources: result.config_sources,
      config_problems: result.config_problems,
      source_problems: result.source_problems,
      skipped: result.reviews
        .filter((r) => r.skipped_reason)
        .map((r) => ({ review: r.review.id ?? "?", reason: r.skipped_reason! })),
    };

    // No store, or a configured path that is not there, is a configuration
    // problem rather than a null result — reported as an error so the caller
    // fixes it instead of reading "0 misses" as "Argus missed nothing". A store
    // that exists and is simply empty is *not* an error: CodeRabbit may not
    // have reviewed yet.
    const unusable =
      !result.paths.length || result.missing_paths.length === result.paths.length;
    if (unusable) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: format_ingest_report(result) }],
        structuredContent: structured,
      };
    }

    return {
      content: [{ type: "text" as const, text: format_ingest_report(result) }],
      structuredContent: structured,
    };
  },
);

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("argus mcp server ready (stdio): argus_review, argus_ingest");
