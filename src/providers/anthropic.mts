/**
 * The Anthropic SDK, metered like every other provider.
 *
 * `new ArgusReasoning()` builds an SDK client itself and reports nothing, so an
 * Anthropic review made real requests while the run record showed zero calls,
 * zero tokens and no model — a record that says a review cost nothing is worse
 * than one that says nothing at all, because it reads as a fact.
 *
 * This is the same duck type the other providers implement, wrapped around the
 * real client so every call is announced through `on_call`.
 */
import { ProviderCallTrace, ProviderOptions, ZERO_USAGE } from "../provider_trace.mjs";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicMessage {
  model?: string;
  content: Array<{ type?: string; text?: string }>;
  usage?: AnthropicUsage;
}

export interface AnthropicOptions extends ProviderOptions {
  /** Swappable for tests; defaults to a lazily imported SDK client. */
  client?: { messages: { create(req: unknown): Promise<AnthropicMessage> } };
}

/**
 * Wraps the SDK so calls are traced.
 *
 * The SDK import stays lazy — `@anthropic-ai/sdk` is optional, and a user on
 * another provider should not need it installed to construct anything.
 */
export class AnthropicClient {
  private _client: AnthropicOptions["client"] | null;

  constructor(private opts: AnthropicOptions = {}) {
    this._client = opts.client ?? null;
  }

  private async client() {
    if (!this._client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this._client = new Anthropic() as unknown as AnthropicOptions["client"];
    }
    return this._client!;
  }

  messages = {
    create: async (req: {
      model: string;
      max_tokens?: number;
      system?: string;
      messages: Array<{ role: string; content: string }>;
      thinking?: unknown;
    }): Promise<{ content: Array<{ type?: string; text: string }> }> => {
      const started = Date.now();
      const response = await (await this.client()).messages.create(req);
      const usage = response.usage ?? {};

      this.opts.on_call?.({
        // What answered, which may differ from what was asked for.
        model: response.model ?? req.model,
        // The Messages API is stateless: there is nothing to reopen later.
        conversation_id: "",
        duration_seconds: (Date.now() - started) / 1000,
        num_turns: 1,
        usage: {
          ...ZERO_USAGE,
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_tokens: usage.cache_read_input_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        },
      } satisfies ProviderCallTrace);

      // Type preserved: a thinking block must stay distinguishable from the
      // answer, or whatever reads the response cannot tell them apart.
      return {
        content: (response.content ?? []).map((c) => ({
          type: c.type,
          text: c.text ?? "",
        })),
      };
    },
  };
}
