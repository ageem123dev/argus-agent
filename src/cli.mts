#!/usr/bin/env node
// Argus CLI — run a full governed review on a diff.
//
//     argus <diff-file> --project myapp [--repo /path/to/repo]
//           [--provider auto|antigravity|antigravity-shim|anthropic|offline]
//           [--offline] [--no-tools] [--no-refine]
//           [--record <file>] [--no-record]
//           [--memory <file>] [--no-memory]
//
// Outputs the review with every trace visible: perception selectivity,
// action log, reflection convergence, collaboration meta, governance
// audit + trust.
import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

import { Argus } from "./argus.mjs";
import { ArgusMemory, HierarchicalMemory } from "./memory.mjs";
import { JsonlVectorDB, default_memory_path } from "./memory_store.mjs";
import { ArgusReasoning, OfflineReasoning } from "./reasoning.mjs";
import {
  AntigravityReasoning,
  AntigravityClient,
  agy_available,
  type AgyCallTrace,
  type AgyOptions,
} from "./providers/antigravity.mjs";
import {
  build_run_record,
  append_run_record,
  default_record_path,
  resolve_commit,
} from "./run_record.mjs";
import { init } from "./init.mjs";

const PROVIDERS = ["auto", "antigravity", "antigravity-shim", "anthropic", "offline"] as const;
type Provider = (typeof PROVIDERS)[number];

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      repo: { type: "string", default: "." },
      provider: { type: "string", default: "auto" },
      offline: { type: "boolean", default: false },
      "no-tools": { type: "boolean", default: false },
      "no-refine": { type: "boolean", default: false },
      record: { type: "string" },
      "no-record": { type: "boolean", default: false },
      memory: { type: "string" },
      "no-memory": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });

  // `argus init [repo]` — scaffold the Claude Code integration into a repo.
  if (positionals[0] === "init") {
    const target = positionals[1] ?? (values.repo as string);
    const r = init(target, { force: values.force as boolean });
    for (const f of r.written) {
      console.log(`  wrote   ${f}`);
    }
    for (const f of r.skipped) {
      console.log(`  exists  ${f}`);
    }
    for (const n of r.notes) {
      console.log(`  note: ${n}`);
    }
    return 0;
  }

  const diff_file = positionals[0];
  if (!diff_file) {
    console.error(
      "usage: argus <diff-file> [--project <name>] [--repo <path>]\n" +
        `                 [--provider ${PROVIDERS.join("|")}]\n` +
        "                 [--offline] [--no-tools] [--no-refine]\n" +
        "                 [--record <file>] [--no-record]\n" +
        "                 [--memory <file>] [--no-memory]\n" +
        "       argus init [repo] [--force]   scaffold Claude Code integration",
    );
    return 2;
  }
  // Defaulted, not required: callers that shell out (the /argus-review slash
  // command) would otherwise have to synthesize a name for an empty argument.
  const project = values.project || path.basename(path.resolve(values.repo as string));

  let provider = (values.offline ? "offline" : values.provider) as Provider;
  if (!PROVIDERS.includes(provider)) {
    console.error(`error: unknown --provider "${provider}" (want: ${PROVIDERS.join(", ")})`);
    return 2;
  }

  // Track every agy call: cost, and the model/conversation that produced the
  // verdict. agy's own cli.log is overwritten per invocation, so if we don't
  // capture this here it is unrecoverable after the next review.
  const agy_calls: AgyCallTrace[] = [];
  const agy_opts: AgyOptions = {
    cwd: values.repo as string,
    on_call: (t) => agy_calls.push(t),
  };

  if (provider === "auto") {
    if (await agy_available()) {
      provider = "antigravity";
    } else if (process.env.ANTHROPIC_API_KEY) {
      provider = "anthropic";
    } else {
      console.error("note: no agy binary and no ANTHROPIC_API_KEY — using offline reasoning.");
      provider = "offline";
    }
  }

  const reasoning =
    provider === "antigravity"
      ? new AntigravityReasoning(agy_opts)
      : provider === "antigravity-shim"
        ? new ArgusReasoning(new AntigravityClient(agy_opts))
        : provider === "anthropic"
          ? new ArgusReasoning()
          : new OfflineReasoning();

  const diff = fs.readFileSync(diff_file, "utf-8");
  const repo_root = values.repo as string;

  // Memory is persistent by default. Without this the agent recalls nothing:
  // ArgusMemory's built-in store is process-local, so `### Past lessons` is
  // empty on every run no matter how many reviews preceded it.
  const memory_file = (values.memory as string | undefined) ?? default_memory_path(repo_root);
  const store = values["no-memory"] ? null : new JsonlVectorDB(memory_file);
  const memory = store ? new ArgusMemory(new HierarchicalMemory(store)) : new ArgusMemory();

  const argus = new Argus({ reasoning, memory });

  let outcome;
  try {
    outcome = await argus.review({
      diff,
      project,
      repo_root,
      verify_with_tools: !values["no-tools"],
      refine: !values["no-refine"],
    });
  } catch (e) {
    console.error(`error: reasoning failed via provider "${provider}": ${
      e instanceof Error ? e.message : String(e)
    }`);
    return 1;
  }

  if (outcome.blocked_reason) {
    console.error(`BLOCKED: ${outcome.blocked_reason}`);
    return 1;
  }

  const review = outcome.review!;
  const p_trace = outcome.perception_trace!;
  // routing_tier (what picked the model) is reported separately from complexity
  // (what the model thought of the change) — they routinely disagree.
  const tier = review.routing_tier ? `, tier=${review.routing_tier}` : "";
  console.log(
    `=== Reasoning (${provider}, ${review.complexity}${tier}, conf=${review.confidence.toFixed(2)}) ===`,
  );
  // Printed in full, not truncated: this stdout is what a calling agent reads.
  console.log(review.verdict);
  console.log(`\n=== Perception ===`);
  console.log(`  discovered/selected: ${p_trace.files_discovered}/${p_trace.files_selected}`);
  console.log(`  selectivity: ${(p_trace.selectivity * 100).toFixed(1)}%`);
  console.log(`\n=== Memory ===`);
  if (store) {
    console.log(
      `  ${store.size} lesson(s) in ${memory_file}` +
        (store.last_error ? `  (degraded: ${store.last_error})` : ""),
    );
  } else {
    console.log("  disabled (--no-memory): nothing recalled, nothing retained");
  }
  console.log(`  ${JSON.stringify(outcome.memory_meta)}`);
  for (const lesson of argus.memory.trace.recalled) {
    console.log(`  recalled: ${lesson}`);
  }
  for (const lesson of argus.memory.trace.stored) {
    console.log(`  stored:   ${lesson}`);
  }
  console.log(`\n=== Reflection ===`);
  console.log(`  ${JSON.stringify(outcome.reflection_meta)}`);
  console.log(`\n=== Collaboration ===`);
  console.log(`  ${JSON.stringify(outcome.collaboration_meta)}`);
  console.log(`\n=== Governance ===`);
  console.log(`  ${JSON.stringify(outcome.governance_meta)}`);
  console.log(`\n=== Action log (${outcome.action_log.length} action(s)) ===`);
  for (const a of outcome.action_log) {
    const flag = a.guardrail_blocked ? "BLOCKED" : a.error ? "ERROR" : "OK";
    console.log(`  [${flag.padEnd(7)}] ${a.tool} ${a.duration_ms.toFixed(0)}ms`);
  }
  if (agy_calls.length) {
    const tokens = agy_calls.reduce((a, t) => a + t.usage.total_tokens, 0);
    console.log(`\n=== agy ===`);
    console.log(`  ${agy_calls.length} call(s), ${tokens.toLocaleString()} total tokens`);
    for (const t of agy_calls) {
      console.log(`  ${t.model}  ${t.duration_seconds.toFixed(1)}s  conv=${t.conversation_id}`);
    }
    console.log(`  replay: agy --conversation ${agy_calls[0].conversation_id} -p "..."`);
  }

  if (!values["no-record"]) {
    const file = (values.record as string | undefined) ?? default_record_path(repo_root);
    const record = build_run_record(outcome, {
      project,
      repo_root,
      commit: resolve_commit(repo_root),
      provider,
      invoked_via: "cli",
      calls: agy_calls,
      audit_entries: argus.governance.audit.entries as unknown as Array<Record<string, unknown>>,
    });
    const written = append_run_record(file, record);
    console.log(
      written.ok
        ? `\n=== record ===\n  appended to ${file}`
        : `\nnote: could not write run record (${written.error})`,
    );
  }
  return 0;
}

// Run when invoked directly (`node dist/cli.mjs ...` or via the `argus` bin).
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
