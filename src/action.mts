/**
 * Action — the agent's hands, wrapped in safety.
 *
 * Every side-effecting call goes through the Guardrail Sandwich:
 *   1. Pre-check:  validate inputs against a declarative SafetyPolicy
 *   2. Execute:    run the tool
 *   3. Post-check: validate outputs (size caps, no scope creep)
 * with an optional human-in-the-loop gate for irreversible tools, and an
 * ActionTrace emitted for every invocation.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Traces and tool registry
// ---------------------------------------------------------------------------

/** One action's auditable record. Designed for append-only audit storage. */
export class ActionTrace {
  action_name: string;
  tool = "";
  arguments: Record<string, unknown> = {};

  guardrail_blocked = false;
  guardrail_reason = "";

  awaiting_human_approval = false;
  human_decision: string | null = null;

  output: any = null;
  error: string | null = null;
  duration_ms = 0.0;

  trust_consumed = 0.0;

  constructor(action_name: string, init: Partial<ActionTrace> = {}) {
    this.action_name = action_name;
    Object.assign(this, init);
  }
}

/** A tool the agent can call. Atomic, side-effecting, observable. */
export class Tool {
  constructor(
    public name: string,
    public description: string,
    public fn: (args: Record<string, unknown>) => Promise<any> | any,
    public retry_count = 2,
  ) {}
}

/** A registry of tools. Keep it small — composition over enumeration. */
export class Toolbox {
  private _tools = new Map<string, Tool>();

  constructor(tools: Tool[] | null = null) {
    for (const t of tools ?? []) {
      this.register(t);
    }
  }

  register(tool: Tool): void {
    if (this._tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this._tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this._tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }
    return tool;
  }

  /** Render the toolbox as a prompt-friendly block. */
  describe(): string {
    return [...this._tools.values()].map((t) => `- ${t.name}: ${t.description}`).join("\n");
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  get size(): number {
    return this._tools.size;
  }
}

// ---------------------------------------------------------------------------
// Guardrail sandwich
// ---------------------------------------------------------------------------

/** Declarative constraints on what an action can do. */
export class SafetyPolicy {
  allowed_tools: Set<string> = new Set();
  forbidden_path_prefixes: string[] = [];
  require_human_for: Set<string> = new Set();
  max_output_bytes = 1_000_000;

  constructor(init: Partial<SafetyPolicy> = {}) {
    Object.assign(this, init);
  }

  /** Return [allowed, reason]. Empty reason on allow. */
  pre_check(_action_name: string, tool: string, args: Record<string, unknown>): [boolean, string] {
    if (this.allowed_tools.size && !this.allowed_tools.has(tool)) {
      return [false, `tool '${tool}' not in allowed_tools`];
    }
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string") {
        for (const pfx of this.forbidden_path_prefixes) {
          if (v.startsWith(pfx)) {
            return [false, `arg '${k}' starts with forbidden prefix '${pfx}'`];
          }
        }
      }
    }
    return [true, ""];
  }

  needs_human(action_name: string, tool: string): boolean {
    return this.require_human_for.has(action_name) || this.require_human_for.has(tool);
  }

  post_check(output: unknown): [boolean, string] {
    if (
      (typeof output === "string" && output.length > this.max_output_bytes) ||
      (Buffer.isBuffer(output) && output.length > this.max_output_bytes)
    ) {
      return [false, `output exceeds max_output_bytes (${this.max_output_bytes})`];
    }
    return [true, ""];
  }
}

export type HumanApprover = (action_name: string, args: Record<string, unknown>) => string;

/** Wrap any (async) callable with pre/post safety checks + audit trace. */
export class GuardrailSandwich {
  constructor(
    public policy: SafetyPolicy,
    public human_approver: HumanApprover | null = null,
  ) {}

  async execute_safely(
    action_name: string,
    tool: string,
    fn: (args: Record<string, unknown>) => Promise<any> | any,
    args: Record<string, unknown> = {},
  ): Promise<ActionTrace> {
    const trace = new ActionTrace(action_name, { tool, arguments: args });

    // --- pre-check ---
    const [ok, reason] = this.policy.pre_check(action_name, tool, args);
    if (!ok) {
      trace.guardrail_blocked = true;
      trace.guardrail_reason = reason;
      return trace;
    }

    // --- human-in-the-loop ---
    if (this.policy.needs_human(action_name, tool)) {
      trace.awaiting_human_approval = true;
      if (this.human_approver === null) {
        trace.guardrail_blocked = true;
        trace.guardrail_reason = "human approval required but no approver wired";
        return trace;
      }
      const verdict = this.human_approver(action_name, args);
      trace.human_decision = verdict;
      if (verdict !== "approve") {
        trace.guardrail_blocked = true;
        trace.guardrail_reason = `human declined: ${verdict}`;
        return trace;
      }
    }

    // --- execute ---
    const t0 = performance.now();
    try {
      trace.output = await fn(args);
    } catch (e) {
      trace.error = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    }
    trace.duration_ms = performance.now() - t0;

    // --- post-check ---
    if (trace.output !== null && trace.output !== undefined) {
      const [post_ok, post_reason] = this.policy.post_check(trace.output);
      if (!post_ok) {
        trace.guardrail_blocked = true;
        trace.guardrail_reason = `post-check: ${post_reason}`;
        trace.output = null;
      }
    }

    return trace;
  }
}

// ---------------------------------------------------------------------------
// The agent's action layer
// ---------------------------------------------------------------------------

function run_command(
  command: string,
  args: string[],
  timeout_ms: number,
  not_installed: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeout_ms, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ returncode: -1, stdout: "", stderr: not_installed });
        return;
      }
      // A lint/test failure is a non-zero exit code, not an exception.
      const returncode =
        error && typeof (error as any).code === "number" ? (error as any).code : error ? -1 : 0;
      resolve({ returncode, stdout, stderr });
    });
  });
}

/** Run the project's lint command. */
async function _run_lint(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repo_root = (args.repo_root as string) ?? ".";
  return run_command("ruff", ["check", repo_root], 60_000, "ruff not installed");
}

/** Run the project's test suite. */
async function _run_tests(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repo_root = (args.repo_root as string) ?? ".";
  return run_command("pytest", [repo_root, "-x", "--tb=short"], 300_000, "pytest not installed");
}

/** Apply a one-spot edit (irreversible — gated behind human approval). */
async function _apply_fix(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const file_path = args.file_path as string;
  const old = args.old as string;
  const fresh = args.new as string;
  if (!fs.existsSync(file_path)) {
    return { applied: false, reason: `file not found: ${file_path}` };
  }
  const text = fs.readFileSync(file_path, "utf-8");
  if (!text.includes(old)) {
    return { applied: false, reason: "old text not found" };
  }
  fs.writeFileSync(file_path, text.replace(old, fresh));
  return { applied: true, file: file_path };
}

/** The default policy: lint + test free; fix_apply needs a human. */
export function default_policy(): SafetyPolicy {
  return new SafetyPolicy({
    allowed_tools: new Set(["lint", "test", "fix_apply"]),
    forbidden_path_prefixes: ["/etc", "/usr", "~/.ssh"],
    require_human_for: new Set(["fix_apply"]),
    max_output_bytes: 100_000,
  });
}

/** Argus's hands: dispatch tools through the guardrail sandwich, trace every call. */
export class ArgusAction {
  policy: SafetyPolicy;
  sandwich: GuardrailSandwich;
  toolbox: Toolbox;
  action_log: ActionTrace[] = [];

  constructor(policy: SafetyPolicy | null = null, human_approver: HumanApprover | null = null) {
    this.policy = policy ?? default_policy();
    this.sandwich = new GuardrailSandwich(this.policy, human_approver);
    this.toolbox = new Toolbox([
      new Tool("lint", "Run project linter and return stdout/stderr.", _run_lint),
      new Tool("test", "Run project test suite and return result.", _run_tests),
      new Tool("fix_apply", "Apply a one-spot text replacement to a file. IRREVERSIBLE.", _apply_fix),
    ]);
  }

  /** Side-effecting tool invocation, guardrail-wrapped and traced. */
  async call_tool(tool_name: string, args: Record<string, unknown> = {}): Promise<ActionTrace> {
    const tool = this.toolbox.get(tool_name);
    const trace = await this.sandwich.execute_safely(tool_name, tool_name, tool.fn, args);
    this.action_log.push(trace);
    return trace;
  }

  async run_lint(repo_root = "."): Promise<ActionTrace> {
    return this.call_tool("lint", { repo_root });
  }

  async run_tests(repo_root = "."): Promise<ActionTrace> {
    return this.call_tool("test", { repo_root });
  }

  async apply_fix(file_path: string, old: string, fresh: string): Promise<ActionTrace> {
    return this.call_tool("fix_apply", { file_path, old, new: fresh });
  }
}
