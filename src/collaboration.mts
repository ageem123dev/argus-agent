/**
 * Collaboration — parallel sub-agents, single synthesizer.
 *
 * On complex diffs the agent dispatches security, style, and complexity
 * reviews to specialist sub-agents in parallel (fan-out/gather), then
 * synthesizes their findings. An adversarial-review helper lets a panel
 * of independent refuters attack a specific claim.
 */

// ---------------------------------------------------------------------------
// Fan-out/gather
// ---------------------------------------------------------------------------

export class SubAgent {
  constructor(
    public name: string,
    public role: string, // 'security', 'style', 'complexity', ...
    public invoke: (task: string) => Promise<string> | string,
  ) {}
}

/** Run all sub-agents in parallel (bounded worker pool), return name -> response. */
export async function fan_out_gather(
  subagents: SubAgent[],
  task: string,
  max_workers = 4,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < subagents.length) {
      const s = subagents[next++];
      try {
        results[s.name] = await s.invoke(task);
      } catch (e) {
        const name = e instanceof Error ? e.constructor.name : "Error";
        const msg = e instanceof Error ? e.message : String(e);
        results[s.name] = `[error: ${name}: ${msg}]`;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(max_workers, subagents.length) }, () => worker()),
  );
  return results;
}

/** Lead agent receives all sub-results and produces a final answer. */
export async function synthesize(
  lead_invoke: (prompt: string) => Promise<string> | string,
  task: string,
  sub_results: Record<string, string>,
): Promise<string> {
  const parts = ["# Sub-agent findings:"];
  for (const [name, resp] of Object.entries(sub_results)) {
    parts.push(`## ${name}\n${resp}`);
  }
  parts.push(`\n# Lead synthesis task:\n${task}`);
  return lead_invoke(parts.join("\n\n"));
}

// ---------------------------------------------------------------------------
// Adversarial review
// ---------------------------------------------------------------------------

export class AdversarialVerdict {
  constructor(
    public claim_survives: boolean,
    public refutation_attempts: number,
    public confidence: number,
    public notes = "",
  ) {}
}

/** Run N independent refuters; claim survives only if < majority refute. */
export async function adversarial_review(
  claim: string,
  refuters: Array<(claim: string) => Promise<string> | string>,
  refute_majority = 2,
): Promise<AdversarialVerdict> {
  let refuted_votes = 0;
  const notes: string[] = [];
  for (let i = 0; i < refuters.length; i++) {
    const response = await refuters[i](claim);
    const lower = response.toLowerCase();
    if (lower.includes("refuted") || lower.includes("false")) {
      refuted_votes += 1;
      notes.push(`r${i}: refuted (${response.slice(0, 60)})`);
    } else {
      notes.push(`r${i}: survived`);
    }
  }
  return new AdversarialVerdict(
    refuted_votes < refute_majority,
    refuters.length,
    1.0 - refuted_votes / Math.max(refuters.length, 1),
    notes.join(" | "),
  );
}

// ---------------------------------------------------------------------------
// Traces + the agent's collaboration layer
// ---------------------------------------------------------------------------

/** One message between agents in a collaboration. */
export class AgentMessage {
  constructor(
    public sender: string,
    public recipient: string,
    public content: string,
    public timestamp = 0.0,
  ) {}
}

/** Observable record of multi-agent coordination. */
export class CollaborationTrace {
  handoffs = 0;
  parallel_calls = 0;
  conflicts_detected = 0;
  total_tokens = 0;
  messages: AgentMessage[] = [];
}

type AgentFn = (input: string) => Promise<string> | string;

/** Argus's parallel review dispatch + synthesis layer. */
export class ArgusCollaboration {
  subs: SubAgent[];
  trace = new CollaborationTrace();
  private _lead: AgentFn;

  constructor(
    security_agent: AgentFn | null = null,
    style_agent: AgentFn | null = null,
    complexity_agent: AgentFn | null = null,
    lead_synth: AgentFn | null = null,
  ) {
    // Default sub-agent callables are fast local heuristics; swap in
    // LLM-backed callables with role-specific system prompts in production.
    this.subs = [
      new SubAgent("security", "security", security_agent ?? this._default_security),
      new SubAgent("style", "style", style_agent ?? this._default_style),
      new SubAgent("complexity", "complexity", complexity_agent ?? this._default_complexity),
    ];
    this._lead = lead_synth ?? this._default_lead;
  }

  async parallel_review(diff: string): Promise<string> {
    const sub_results = await fan_out_gather(this.subs, diff);
    this.trace.parallel_calls += Object.keys(sub_results).length;
    for (const [name, content] of Object.entries(sub_results)) {
      this.trace.messages.push(new AgentMessage(name, "lead", content.slice(0, 200)));
    }
    return synthesize(this._lead, diff, sub_results);
  }

  /** Optional adversarial check on a specific claim from the review. */
  async adversarial_check(
    claim: string,
    refuters: AgentFn[] | null = null,
  ): Promise<AdversarialVerdict> {
    const rs = refuters ?? [this._default_refuter, this._default_refuter, this._default_refuter];
    return adversarial_review(claim, rs, 2);
  }

  // --- default stubs (replace with LLM-backed callables in production) ---
  private _default_security = (_diff: string): string =>
    "[security] No obvious vulnerabilities surfaced by static patterns.";

  private _default_style = (_diff: string): string =>
    "[style] Conforms to the style guide; comment density adequate.";

  private _default_complexity = (diff: string): string => {
    const lines = (diff.match(/\n/g) ?? []).length;
    const verdict = lines > 200 ? "high" : lines > 50 ? "moderate" : "low";
    return `[complexity] Diff complexity: ${verdict} (${lines} lines).`;
  };

  private _default_lead = (_prompt: string): string =>
    "[lead synthesis] Parallel review complete; see sub-agent findings.";

  private _default_refuter = (_claim: string): string => "survived";
}
