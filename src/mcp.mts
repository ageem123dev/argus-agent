#!/usr/bin/env node
/**
 * Argus MCP server — exposes the governed review as a tool over stdio.
 *
 *     claude mcp add argus -- node /path/to/argus-agent-ts/dist/mcp.mjs
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
  type AgyCallTrace,
  type AgyOptions,
} from "./providers/antigravity.mjs";
import {
  build_run_record,
  append_run_record,
  default_record_path,
  resolve_commit,
} from "./run_record.mjs";

const PROVIDERS = ["antigravity", "antigravity-shim", "anthropic", "offline"] as const;

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
      'Git revision or range to diff, e.g. "HEAD", "main...HEAD", or "--staged". ' +
        'Defaults to "HEAD" when no diff, diff_file, or git_range is given.',
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
    .default("antigravity")
    .describe(
      "Reasoning backend. 'antigravity' is one agy call per review; 'antigravity-shim' " +
        "makes Argus drive classify/CoT/verify itself at ~20x the calls; 'offline' does no network I/O.",
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
      } else {
        diff = await git_diff(repo_root, args.git_range ?? "HEAD");
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
            text: "The diff is empty — nothing to review. Check git_range, or pass diff/diff_file.",
          },
        ],
      };
    }

    const agy_calls: AgyCallTrace[] = [];
    const agy_opts: AgyOptions = { cwd: repo_root, on_call: (t) => agy_calls.push(t) };

    const reasoning =
      args.provider === "antigravity"
        ? new AntigravityReasoning(agy_opts)
        : args.provider === "antigravity-shim"
          ? new ArgusReasoning(new AntigravityClient(agy_opts))
          : args.provider === "anthropic"
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
          provider: args.provider,
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

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("argus mcp server ready (stdio)");
