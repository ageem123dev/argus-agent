/**
 * Gemini through the public API, keyed by GEMINI_API_KEY.
 *
 * This is the supported way to point a third-party agent at Gemini. Google's
 * own FAQ says so — "if you would like to use a third party coding agent with
 * Gemini, we recommend using a Vertex or AI Studio API key" — and it is the
 * only path with a written commitment about training: on the **paid** tier,
 * "Google doesn't use your prompts ... or responses to improve our products."
 * The free tier carries no such promise and says in as many words not to send
 * confidential material, so `argus` warns when the key looks unpaid and there
 * is no way for it to tell for certain: use a key from a billed project.
 *
 * One HTTP call per review. The whole ReviewResult comes back as structured
 * output, the same contract the CLI-based provider implemented — see
 * review_schema.mts, which both share.
 */
import {
  EmptyReviewError,
  REVIEW_PROMPT,
  REVIEW_SCHEMA,
  StructuredReview,
  interpret_review,
  tier_for_size,
} from "../review_schema.mjs";
import { ArgusReasoning, Complexity, ReviewResult } from "../reasoning.mjs";
import {
  ProviderCallTrace,
  ProviderOptions,
  ProviderUsage,
  ZERO_USAGE,
} from "../provider_trace.mjs";

/** Models by tier. Flash at two reasoning depths, as the CLI path routed. */
export const GEMINI_ROUTING: Record<Complexity, string> = {
  [Complexity.SIMPLE]: "gemini-3.7-flash",
  [Complexity.MODERATE]: "gemini-3.7-flash",
  [Complexity.COMPLEX]: "gemini-3.7-flash",
};

/** Thinking budget by tier: depth is bought with reasoning, not a bigger model. */
export const GEMINI_THINKING: Record<Complexity, number> = {
  [Complexity.SIMPLE]: 0,
  [Complexity.MODERATE]: 8192,
  [Complexity.COMPLEX]: 24576,
};

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** Why a Gemini call failed. The distinction decides what helps next. */
export type GeminiFailure =
  | "no_key" // nothing in the environment to authenticate with
  | "auth" // key rejected: wrong, revoked, or not enabled for this model
  | "rate_limit" // quota exhausted; the same request may work later
  | "http" // any other non-2xx
  | "empty" // 2xx that carried no review
  | "network"; // never reached the service

export class GeminiError extends Error {
  constructor(
    message: string,
    public kind: GeminiFailure,
    public attempts = 1,
    public status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export interface GeminiOptions extends ProviderOptions {
  /** Overrides the environment. Prefer the environment; never commit a key. */
  api_key?: string;
  /** Swappable for tests. Defaults to global fetch. */
  fetch_impl?: typeof fetch;
  /** Extra attempts when a call returns 2xx with nothing in it. */
  empty_retries?: number;
}

/**
 * The key, from the explicit option or the environment.
 *
 * Both spellings are accepted because Google's own tooling is split between
 * them, and a user who exported the other one is not misconfigured.
 */
export function resolve_api_key(opts: GeminiOptions = {}): string | undefined {
  return (
    opts.api_key ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    undefined
  );
}

/** True when a key is available, without revealing or validating it. */
export function has_api_key(opts: GeminiOptions = {}): boolean {
  return Boolean(resolve_api_key(opts));
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

function usage_of(r: GeminiResponse): ProviderUsage {
  const u = r.usageMetadata;
  if (!u) {
    return { ...ZERO_USAGE };
  }
  return {
    input_tokens: u.promptTokenCount ?? 0,
    output_tokens: u.candidatesTokenCount ?? 0,
    thinking_tokens: u.thoughtsTokenCount ?? 0,
    cache_read_tokens: u.cachedContentTokenCount ?? 0,
    total_tokens: u.totalTokenCount ?? 0,
  };
}

function text_of(r: GeminiResponse): string {
  return (r.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/**
 * One call. Returns the raw text and what it cost.
 *
 * Exported so the plugin seam and tests can drive it without the reasoning
 * class wrapped around it.
 */
export async function call_gemini(
  prompt: string,
  model: string,
  opts: GeminiOptions = {},
  extras: Record<string, unknown> = {},
): Promise<{ text: string; usage: ProviderUsage; duration_seconds: number }> {
  const key = resolve_api_key(opts);
  if (!key) {
    throw new GeminiError(
      "no Gemini API key: set GEMINI_API_KEY (a key from a billed project — the " +
        "free tier's terms permit training on your prompts).",
      "no_key",
    );
  }
  const do_fetch = opts.fetch_impl ?? fetch;
  const started = Date.now();

  let response: Response;
  try {
    response = await do_fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...extras,
      }),
      ...(opts.timeout_ms ? { signal: AbortSignal.timeout(opts.timeout_ms) } : {}),
    });
  } catch (e) {
    throw new GeminiError(
      `could not reach the Gemini API: ${e instanceof Error ? e.message : String(e)}`,
      "network",
    );
  }

  const duration_seconds = (Date.now() - started) / 1000;
  const raw = await response.text();
  let body: GeminiResponse = {};
  try {
    body = raw ? (JSON.parse(raw) as GeminiResponse) : {};
  } catch {
    // Fall through: a non-JSON body is reported by status below.
  }

  if (!response.ok) {
    const detail = body.error?.message ?? raw.slice(0, 300) ?? "";
    const kind: GeminiFailure =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 429
          ? "rate_limit"
          : "http";
    throw new GeminiError(
      `Gemini API returned ${response.status}: ${detail}`,
      kind,
      1,
      response.status,
    );
  }

  return { text: text_of(body), usage: usage_of(body), duration_seconds };
}

/**
 * Argus's reasoning layer, backed by one Gemini API call per review.
 *
 * Drop-in for ArgusReasoning: `new Argus({ reasoning: new GeminiReasoning() })`.
 */
export class GeminiReasoning extends ArgusReasoning {
  constructor(
    private opts: GeminiOptions = {},
    private routing: Record<Complexity, string> = GEMINI_ROUTING,
    /** Swappable so tests observe the real request without a network. */
    private call: typeof call_gemini = call_gemini,
  ) {
    super();
  }

  override async review(diff: string): Promise<ReviewResult> {
    const tier = tier_for_size(diff);
    const model = this.routing[tier];
    const attempts = Math.max(0, this.opts.empty_retries ?? 0) + 1;

    let last: GeminiError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await this.call(REVIEW_PROMPT + diff, model, this.opts, {
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: REVIEW_SCHEMA,
          ...(GEMINI_THINKING[tier]
            ? { thinkingConfig: { thinkingBudget: GEMINI_THINKING[tier] } }
            : {}),
        },
      });

      this.opts.on_call?.({
        model,
        // The API is stateless: there is no conversation to reopen later.
        conversation_id: "",
        duration_seconds: result.duration_seconds,
        num_turns: 1,
        usage: result.usage,
      } satisfies ProviderCallTrace);

      let structured: StructuredReview | undefined;
      try {
        structured = result.text ? (JSON.parse(result.text) as StructuredReview) : undefined;
      } catch {
        // Schema enforcement failed but prose may still be a usable review;
        // interpret_review decides, and refuses when there is nothing at all.
        structured = undefined;
      }

      try {
        return interpret_review(structured, result.text, tier, `model ${model}`);
      } catch (e) {
        if (!(e instanceof EmptyReviewError) || attempt === attempts) {
          if (e instanceof EmptyReviewError) {
            e.attempts = attempt;
          }
          throw e;
        }
        e.attempts = attempt;
        last = new GeminiError(e.message, "empty", attempt);
      }
    }
    /* c8 ignore next */
    throw last ?? new GeminiError("Gemini produced no review", "empty");
  }
}

/**
 * Gemini as a bare completion backend, for the classify -> CoT -> verify path.
 *
 * Shaped like the Anthropic SDK client ArgusReasoning expects, so
 * `new ArgusReasoning(new GeminiClient())` drives Argus's own multi-step
 * reasoning over Gemini instead of one structured call.
 */
export class GeminiClient {
  constructor(
    private opts: GeminiOptions = {},
    private deep_model: string = GEMINI_ROUTING[Complexity.COMPLEX],
    private call: typeof call_gemini = call_gemini,
  ) {}

  messages = {
    create: async (req: {
      model: string;
      max_tokens?: number;
      system?: string;
      messages: Array<{ role: string; content: string }>;
      thinking?: unknown;
    }): Promise<{ content: Array<{ text: string }> }> => {
      const prompt = [
        req.system ? `[System instructions]\n${req.system}` : "",
        ...req.messages.map((m) => m.content),
      ]
        .filter(Boolean)
        .join("\n\n");

      // `thinking` is what separates the complex tier from moderate: the
      // routing table distinguishes them by reasoning budget rather than by
      // model name, so both arrive here under the same slug.
      const model = req.thinking ? this.deep_model : map_model(req.model);
      const result = await this.call(prompt, model, this.opts, {
        ...(req.max_tokens ? { generationConfig: { maxOutputTokens: req.max_tokens } } : {}),
      });

      this.opts.on_call?.({
        model,
        conversation_id: "",
        duration_seconds: result.duration_seconds,
        num_turns: 1,
        usage: result.usage,
      } satisfies ProviderCallTrace);

      return { content: [{ text: result.text }] };
    },
  };
}

/** Claude slugs in the routing table to their Gemini equivalent. */
export function map_model(model: string): string {
  return CLAUDE_TO_GEMINI[model] ?? GEMINI_ROUTING[Complexity.SIMPLE];
}

export const CLAUDE_TO_GEMINI: Record<string, string> = {
  "claude-haiku-4-5-20251001": "gemini-3.7-flash",
  "claude-sonnet-4-6": "gemini-3.7-flash",
};
