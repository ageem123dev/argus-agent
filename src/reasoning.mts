/**
 * Reasoning — complexity-routed review generation.
 *
 * Three integrated mechanisms:
 *   * complexity routing — pick model + token budget by task complexity
 *   * chain of thought   — generate a CoT with confidence-tagged steps
 *   * verify_chain       — re-check the weakest step
 *
 * The Anthropic client is created lazily, so the module is importable and
 * the OfflineReasoning shim usable without the SDK configured.
 */

// ---------------------------------------------------------------------------
// Complexity routing
// ---------------------------------------------------------------------------

export enum Complexity {
  SIMPLE = "simple",
  MODERATE = "moderate",
  COMPLEX = "complex",
}

export interface RouteConfig {
  model: string;
  max_tokens: number;
  thinking: { type: string; budget_tokens?: number } | null;
}

export const ROUTING_TABLE: Record<Complexity, RouteConfig> = {
  [Complexity.SIMPLE]: {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    thinking: null,
  },
  [Complexity.MODERATE]: {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    thinking: null,
  },
  [Complexity.COMPLEX]: {
    model: "claude-sonnet-4-6",
    max_tokens: 16384,
    thinking: { type: "adaptive" },
  },
};

const CLASSIFY_PROMPT =
  "Classify the complexity of the following task. " +
  "Answer with exactly one word: simple, moderate, or complex.";

export async function classify_complexity(client: any, query: string): Promise<Complexity> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{ role: "user", content: `${CLASSIFY_PROMPT}\nQuery: ${query}` }],
  });
  const first_word = response.content[0].text.split(/\s+/)[0];
  const candidate = first_word.toLowerCase().replace(/[.:,]+$/, "");
  if ((Object.values(Complexity) as string[]).includes(candidate)) {
    return candidate as Complexity;
  }
  return Complexity.MODERATE;
}

// ---------------------------------------------------------------------------
// Chain of thought
// ---------------------------------------------------------------------------

export class ReasoningStep {
  constructor(
    public step_number: number,
    public content: string,
    public confidence: number,
  ) {}
}

export class ChainOfThought {
  steps: ReasoningStep[] = [];
  final_answer = "";

  add_step(content: string, confidence = 1.0): void {
    this.steps.push(new ReasoningStep(this.steps.length + 1, content, confidence));
  }

  get weakest_step(): ReasoningStep | null {
    if (!this.steps.length) {
      return null;
    }
    return this.steps.reduce((min, s) => (s.confidence < min.confidence ? s : min));
  }
}

const COT_SYSTEM_PROMPT =
  "Reason step by step. Number each step as 'Step N [confidence: 0.X]: ...' " +
  "and end with 'Final answer: ...'.";

const VERIFY_PROMPT =
  "Given the prior reasoning:\n{prior}\n\nIs this step valid?\n{step}\n" +
  "Answer VALID or INVALID with a one-line justification.";

export function parse_chain(text: string): ChainOfThought {
  const chain = new ChainOfThought();
  const step_re = /^Step\s+\d+\s*\[confidence:\s*([\d.]+)\]:\s*(.*)$/;
  for (const line of text.split("\n")) {
    const m = step_re.exec(line.trim());
    if (m) {
      chain.add_step(m[2], parseFloat(m[1]));
    } else if (line.trim().toLowerCase().startsWith("final answer:")) {
      chain.final_answer = line.trim().slice("final answer:".length).trim();
    }
  }
  if (!chain.final_answer) {
    chain.final_answer = text;
  }
  return chain;
}

export async function reason_with_cot(client: any, question: string): Promise<ChainOfThought> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: COT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: question }],
  });
  return parse_chain(response.content[0].text);
}

export async function verify_chain(
  client: any,
  chain: ChainOfThought,
): Promise<Array<Record<string, unknown>>> {
  const issues: Array<Record<string, unknown>> = [];
  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    const prior = chain.steps
      .slice(0, i)
      .map((s) => `Step ${s.step_number}: ${s.content}`)
      .join("\n");
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: VERIFY_PROMPT.replace("{prior}", prior).replace(
            "{step}",
            `Step ${step.step_number}: ${step.content}`,
          ),
        },
      ],
    });
    if (response.content[0].text.toUpperCase().includes("INVALID")) {
      issues.push({ step: step.step_number, issue: response.content[0].text });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// The agent's reasoning layer
// ---------------------------------------------------------------------------

/**
 * The output of a reasoned review — carries the chain, not just the verdict.
 *
 * `complexity` is the reasoner's own assessment of the task. `routing_tier` is
 * the tier that actually selected the model, which is a different thing: a
 * provider can route to its deepest tier on a change the model then judges
 * simple. Reporting only the former makes the run look cheaper than it was.
 */
/** Tier ordering, shallowest first. */
const TIER_DEPTH: Record<Complexity, number> = {
  [Complexity.SIMPLE]: 0,
  [Complexity.MODERATE]: 1,
  [Complexity.COMPLEX]: 2,
};

/** The deeper of two tiers; a missing floor leaves the classification alone. */
export function deepest(tier: Complexity, floor?: Complexity): Complexity {
  return floor && TIER_DEPTH[floor] > TIER_DEPTH[tier] ? floor : tier;
}

export class ReviewResult {
  constructor(
    public verdict: string,
    public reasoning_steps: unknown[] = [],
    public confidence = 1.0,
    public complexity = "simple",
    public routing_tier?: string,
  ) {}

  /**
   * Set when a fallback produced this review rather than the requested path.
   * Carried on the result so the run record can name what actually answered:
   * a verdict attributed to the wrong provider misreports provenance in the
   * records ingestion later scores.
   */
  fallback?: {
    attempted: string;
    used: string;
    reason: string;
    attempts: number;
  };
}

/** Argus's reasoning layer: complexity-routed + CoT + verify. */
export class ArgusReasoning {
  private _client: any;

  constructor(client: any = null) {
    // client is lazy so the class is constructible without @anthropic-ai/sdk configured.
    this._client = client;
  }

  async client(): Promise<any> {
    if (this._client === null) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this._client = new Anthropic();
    }
    return this._client;
  }

  /**
   * Route the review by complexity, then reason at the right depth.
   *
   * `floor` refuses to route below a tier the caller already established.
   * The classifier reads only the first 500 characters, which on a large
   * change is one file header — so a diff another path had already judged
   * complex could be classified simple here and answered on the cheapest
   * model. That is a silent downgrade of exactly the change least able to
   * afford one.
   */
  async review(diff: string, floor?: Complexity): Promise<ReviewResult> {
    const client = await this.client();
    const classified = await classify_complexity(
      client,
      `Code review task:
${diff.slice(0, 500)}`,
    );
    const complexity = deepest(classified, floor);
    if (complexity === Complexity.SIMPLE) {
      return this._quick_review(diff);
    }
    if (complexity === Complexity.MODERATE) {
      return this._review_with_reasoning(diff, complexity);
    }
    return this._deep_review(diff);
  }

  /** One pass, cheap model, structured output. Used when classifier says SIMPLE. */
  private async _quick_review(diff: string): Promise<ReviewResult> {
    const cfg = ROUTING_TABLE[Complexity.SIMPLE];
    const response = await (await this.client()).messages.create({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      messages: [
        {
          role: "user",
          content: `Quick code review:\n${diff}\n\nList up to 3 issues, severity-tagged.`,
        },
      ],
    });
    return new ReviewResult(response.content[0].text, [], 0.8, "simple");
  }

  /** CoT review with weak-step verification. */
  private async _review_with_reasoning(diff: string, complexity: Complexity): Promise<ReviewResult> {
    const client = await this.client();
    const chain = await reason_with_cot(
      client,
      `Review this code diff for bugs, security issues, and style problems:\n${diff}`,
    );
    if (chain.weakest_step) {
      const issues = await verify_chain(client, chain);
      if (issues.length) {
        chain.final_answer += `\n\n[Verifier flagged: ${issues.length} issue(s)]`;
      }
    }
    const confidence = chain.steps.length
      ? Math.min(...chain.steps.map((s) => s.confidence))
      : 0.5;
    return new ReviewResult(chain.final_answer, chain.steps, confidence, complexity);
  }

  /** COMPLEX path: use the highest reasoning tier from ROUTING_TABLE. */
  private async _deep_review(diff: string): Promise<ReviewResult> {
    const cfg = ROUTING_TABLE[Complexity.COMPLEX];
    const kwargs: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      messages: [
        {
          role: "user",
          content: `Deep code review. Walk through reasoning step by step.\n\n${diff}`,
        },
      ],
    };
    if (cfg.thinking) {
      kwargs.thinking = cfg.thinking;
    }
    const response = await (await this.client()).messages.create(kwargs);
    return new ReviewResult(response.content[0].text, [], 0.9, "complex");
  }
}

/**
 * No-network reasoning: classifies by diff size and emits a canned verdict.
 * Used by the CLI's --offline mode and whenever no API key is configured.
 */
export class OfflineReasoning extends ArgusReasoning {
  constructor() {
    super(null);
  }

  override async review(diff: string): Promise<ReviewResult> {
    const lines = (diff.match(/\n/g) ?? []).length;
    const tier = lines < 30 ? "simple" : lines < 100 ? "moderate" : "complex";
    return new ReviewResult(
      "[offline] Review summary:\n" +
        ` - ${lines} changed lines, complexity=${tier}\n` +
        " - severity=info  Offline mode; set ANTHROPIC_API_KEY for live reasoning.\n",
      [],
      0.7,
      tier,
    );
  }
}
