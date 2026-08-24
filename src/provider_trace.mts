/**
 * What a reasoning provider reports about a call it made.
 *
 * Every provider is metered the same way, so the shape belongs to the core and
 * not to whichever backend happens to be loaded. Run records are written from
 * this, and they outlive the provider that produced them: the records already
 * on disk were written by the agy provider, which is no longer part of this
 * repository, and they still have to be readable.
 */

/** Tokens consumed by one call. Providers that cannot report a field send 0. */
export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

/** One call to a reasoning provider. */
export interface ProviderCallTrace {
  /** The model that actually answered, which routing may have chosen. */
  model: string;
  /**
   * Whatever the provider can be asked about this call afterwards — a
   * conversation id, a request id. Empty when the provider offers nothing.
   */
  conversation_id: string;
  duration_seconds: number;
  /** Turns taken, for providers that run an agent loop. 1 for a plain call. */
  num_turns: number;
  usage: ProviderUsage;
}

/** Options every provider accepts; each may ignore what does not apply. */
export interface ProviderOptions {
  /** Working directory, where that shapes what context a provider loads. */
  cwd?: string;
  /** Hard kill after this long. */
  timeout_ms?: number;
  /** Called after every successful call — wire to your own metering. */
  on_call?: (trace: ProviderCallTrace) => void;
  /** Provider-specific settings, passed through untouched. */
  [key: string]: unknown;
}

export const ZERO_USAGE: ProviderUsage = {
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
};
