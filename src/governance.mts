/**
 * Governance — the agent's control plane.
 *
 * Every action that touches the world goes through:
 *   1. permission check (capability-based ACL)
 *   2. policy evaluation (declarative rules, first match wins)
 *   3. audit log entry (append-only, hash-chained)
 * Trust updates after each action — promotions earn new capabilities,
 * blocked or failed actions cost capability.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

export enum Capability {
  READ_FILES = "read_files",
  RUN_LINT = "run_lint",
  RUN_TESTS = "run_tests",
  WRITE_FILES = "write_files",
  NETWORK_FETCH = "network_fetch",
  SHELL_EXEC = "shell_exec",
}

export class AgentIdentity {
  constructor(
    public name: string,
    public capabilities: Set<Capability> = new Set(),
  ) {}
}

/** Capability check before any side-effect action. */
export class PermissionGate {
  agents = new Map<string, AgentIdentity>();

  register(identity: AgentIdentity): void {
    this.agents.set(identity.name, identity);
  }

  grant(agent_name: string, cap: Capability): void {
    this.agents.get(agent_name)!.capabilities.add(cap);
  }

  revoke(agent_name: string, cap: Capability): void {
    this.agents.get(agent_name)!.capabilities.delete(cap);
  }

  check(agent_name: string, cap: Capability): [boolean, string] {
    const identity = this.agents.get(agent_name);
    if (!identity) {
      return [false, `unknown agent: ${agent_name}`];
    }
    if (!identity.capabilities.has(cap)) {
      return [false, `agent '${agent_name}' lacks capability '${cap}'`];
    }
    return [true, ""];
  }
}

// ---------------------------------------------------------------------------
// Trust levels
// ---------------------------------------------------------------------------

export enum TrustLevel {
  SUGGEST = 0,
  ACT_THEN_REVIEW = 1,
  ACT_WITHIN_BOUNDS = 2,
  FULL_AUTONOMY = 3,
}

export class TrustState {
  constructor(
    public agent: string,
    public level: TrustLevel = TrustLevel.SUGGEST,
    public successful_actions = 0,
    public blocked_actions = 0,
    public failed_actions = 0,
  ) {}

  credit(n = 1): void {
    this.successful_actions += n;
  }

  debit_block(n = 1): void {
    this.blocked_actions += n;
  }

  debit_fail(n = 1): void {
    this.failed_actions += n;
  }
}

/** Decides promotion/demotion based on action history. */
export class TrustEngine {
  static PROMOTE_THRESHOLD = 20; // clean actions to earn one level
  static DEMOTE_THRESHOLD = 3; // blocked/failed to lose a level

  states = new Map<string, TrustState>();

  register(agent: string, initial: TrustLevel = TrustLevel.SUGGEST): void {
    this.states.set(agent, new TrustState(agent, initial));
  }

  update(
    agent: string,
    { success = 0, blocked = 0, failed = 0 }: { success?: number; blocked?: number; failed?: number } = {},
  ): [TrustLevel, string] {
    let state = this.states.get(agent);
    if (!state) {
      state = new TrustState(agent);
      this.states.set(agent, state);
    }
    state.credit(success);
    state.debit_block(blocked);
    state.debit_fail(failed);
    // Demote first (incidents matter more than streaks)
    if (state.blocked_actions + state.failed_actions >= TrustEngine.DEMOTE_THRESHOLD) {
      if (state.level > TrustLevel.SUGGEST) {
        state.level = state.level - 1;
        state.blocked_actions = state.failed_actions = 0;
        state.successful_actions = 0;
        return [state.level, "demoted"];
      }
    }
    // Promote on clean streak
    if (state.successful_actions >= TrustEngine.PROMOTE_THRESHOLD) {
      if (state.level < TrustLevel.FULL_AUTONOMY) {
        state.level = state.level + 1;
        state.successful_actions = 0;
        return [state.level, "promoted"];
      }
    }
    return [state.level, "unchanged"];
  }
}

// ---------------------------------------------------------------------------
// Audit log (hash-chained)
// ---------------------------------------------------------------------------

/** Recursively key-sorted JSON so hashes are deterministic. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

export class AuditEntry {
  payload: Record<string, unknown> = {};
  prev_hash = "";
  self_hash = "";

  constructor(
    public timestamp: number,
    public actor: string,
    public action: string,
    public decision: string,
    init: Partial<AuditEntry> = {},
  ) {
    Object.assign(this, init);
  }

  compute_hash(): string {
    const material = stableStringify({
      timestamp: this.timestamp,
      actor: this.actor,
      action: this.action,
      decision: this.decision,
      payload: this.payload,
      prev_hash: this.prev_hash,
    });
    return createHash("sha256").update(material).digest("hex").slice(0, 16);
  }
}

/** Append-only audit log with hash chain. In production: persist + replicate. */
export class AuditLog {
  entries: AuditEntry[] = [];

  record(
    actor: string,
    action: string,
    decision: string,
    payload: Record<string, unknown> = {},
  ): AuditEntry {
    const prev_hash = this.entries.length
      ? this.entries[this.entries.length - 1].self_hash
      : "GENESIS";
    const entry = new AuditEntry(Date.now() / 1000, actor, action, decision, {
      payload,
      prev_hash,
    });
    entry.self_hash = entry.compute_hash();
    this.entries.push(entry);
    return entry;
  }

  /** Walk the log, re-compute hashes, detect tampering. */
  verify_chain(): [boolean, number] {
    let prev = "GENESIS";
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.prev_hash !== prev) {
        return [false, i];
      }
      if (entry.compute_hash() !== entry.self_hash) {
        return [false, i];
      }
      prev = entry.self_hash;
    }
    return [true, this.entries.length];
  }
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

export class PolicyRule {
  constructor(
    public name: string,
    public matcher: (agent: string, action: string, args: Record<string, unknown>) => boolean,
    public decision: string, // "allow" | "deny" | "escalate"
    public reason = "",
  ) {}
}

/** Evaluates rules in declaration order; first match wins. */
export class PolicyEngine {
  rules: PolicyRule[] = [];

  add(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  /** Return [decision, reason, matched_rule_name]. */
  evaluate(
    agent: string,
    action: string,
    args: Record<string, unknown> | null = null,
  ): [string, string, string | null] {
    const a = args ?? {};
    for (const rule of this.rules) {
      if (rule.matcher(agent, action, a)) {
        return [rule.decision, rule.reason, rule.name];
      }
    }
    return ["allow", "no rule matched (default allow)", null];
  }
}

// ---------------------------------------------------------------------------
// Traces + the agent's governance layer
// ---------------------------------------------------------------------------

export class GovernanceEvent {
  reason = "";
  trust_before = 0.0;
  trust_after = 0.0;

  constructor(
    public timestamp: number,
    public actor: string,
    public action: string,
    public decision: string, // "allow" | "deny" | "escalate"
    init: Partial<GovernanceEvent> = {},
  ) {
    Object.assign(this, init);
  }
}

export class GovernanceTrace {
  events: GovernanceEvent[] = [];
  promotions = 0;
  demotions = 0;
}

export class GovernanceDecision {
  constructor(
    public allowed: boolean,
    public decision: string, // "allow" | "deny" | "escalate"
    public reason: string,
    public audit_entry: AuditEntry | null = null,
  ) {}
}

/** Argus's control plane: permission gates + trust + audit + policy. */
export class ArgusGovernance {
  static AGENT = "argus";

  permissions = new PermissionGate();
  trust = new TrustEngine();
  audit = new AuditLog();
  policy = new PolicyEngine();
  trace = new GovernanceTrace();

  constructor(initial_trust: TrustLevel = TrustLevel.ACT_THEN_REVIEW) {
    this.permissions.register(
      new AgentIdentity(
        ArgusGovernance.AGENT,
        new Set([Capability.READ_FILES, Capability.RUN_LINT, Capability.RUN_TESTS]),
      ),
    );
    // By default, Argus may NOT write files / fetch network without trust gain.
    this.trust.register(ArgusGovernance.AGENT, initial_trust);
    this._register_default_policy();
  }

  private _register_default_policy(): void {
    // Reject obvious destructive shell patterns at policy level.
    this.policy.add(
      new PolicyRule(
        "block_rm_rf",
        (_agent, action, args) =>
          action === "shell_exec" && Object.values(args).some((v) => String(v).includes("rm -rf")),
        "deny",
        "rm -rf disallowed by default policy",
      ),
    );
    // Writes always need human approval at trust < FULL_AUTONOMY.
    this.policy.add(
      new PolicyRule(
        "writes_need_approval",
        (_agent, action, _args) => action === "write_files",
        "escalate",
        "file writes require human approval below FULL_AUTONOMY",
      ),
    );
  }

  /** One-shot authorization: permission + policy + audit. */
  authorize(
    action: string,
    cap: Capability,
    args: Record<string, unknown> | null = null,
  ): GovernanceDecision {
    const a = args ?? {};
    // 1. Permission check
    const [ok, reason] = this.permissions.check(ArgusGovernance.AGENT, cap);
    if (!ok) {
      const entry = this.audit.record(ArgusGovernance.AGENT, action, "deny", { reason, ...a });
      this.trace.events.push(
        new GovernanceEvent(entry.timestamp, ArgusGovernance.AGENT, action, "deny", { reason }),
      );
      return new GovernanceDecision(false, "deny", reason, entry);
    }
    // 2. Policy evaluation
    const [p_decision, p_reason, p_rule] = this.policy.evaluate(ArgusGovernance.AGENT, action, a);
    if (p_decision !== "allow") {
      const entry = this.audit.record(ArgusGovernance.AGENT, action, p_decision, {
        reason: `${p_rule}: ${p_reason}`,
        ...a,
      });
      this.trace.events.push(
        new GovernanceEvent(entry.timestamp, ArgusGovernance.AGENT, action, p_decision, {
          reason: `${p_rule}: ${p_reason}`,
        }),
      );
      return new GovernanceDecision(false, p_decision, p_reason, entry);
    }
    // 3. Allow + audit
    const entry = this.audit.record(ArgusGovernance.AGENT, action, "allow", {
      reason: "permission ok, policy allow",
      ...a,
    });
    return new GovernanceDecision(true, "allow", "ok", entry);
  }

  /** Update trust based on action result. */
  report_outcome(success: boolean, blocked = false): [TrustLevel, string] {
    const [level, change] = this.trust.update(ArgusGovernance.AGENT, {
      success: success ? 1 : 0,
      blocked: blocked ? 1 : 0,
      failed: success || blocked ? 0 : 1,
    });
    if (change === "promoted") {
      this.trace.promotions += 1;
      // On promotion, grant a new capability.
      this.permissions.grant(ArgusGovernance.AGENT, Capability.WRITE_FILES);
    } else if (change === "demoted") {
      this.trace.demotions += 1;
      this.permissions.revoke(ArgusGovernance.AGENT, Capability.WRITE_FILES);
    }
    return [level, change];
  }

  current_trust(): TrustState {
    return this.trust.states.get(ArgusGovernance.AGENT)!;
  }
}
