/**
 * What `--provider auto` resolves to.
 *
 * One resolver, shared by the CLI and the MCP server, so the two cannot
 * disagree about what `auto` means or about which provider a run record names.
 *
 * The order is deliberate. A configured plugin wins because naming one is an
 * explicit act — nobody configures a plugin and then wants it ignored. Gemini
 * comes next because it is the supported, paid, no-training path. Anthropic
 * follows if a key is present, and offline is the floor: a review that runs
 * with no model at all is still better than a command that refuses to start.
 */
export const PROVIDERS = ["auto", "gemini", "anthropic", "plugin", "offline"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface RouteDecision {
  route: Exclude<Provider, "auto">;
  /** True when `auto` chose this rather than the user naming it. */
  auto: boolean;
}

export interface RouteProbe {
  /** A reasoning plugin is configured (config or ARGUS_REASONING_PLUGIN). */
  plugin?: boolean;
  /** A Gemini API key is present. */
  gemini_key?: boolean;
  /** An Anthropic API key is present. */
  anthropic_key?: boolean;
}

export function resolve_route(requested: Provider, probe: RouteProbe = {}): RouteDecision {
  if (requested !== "auto") {
    return { route: requested, auto: false };
  }
  if (probe.plugin) {
    return { route: "plugin", auto: true };
  }
  if (probe.gemini_key ?? Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return { route: "gemini", auto: true };
  }
  if (probe.anthropic_key ?? Boolean(process.env.ANTHROPIC_API_KEY)) {
    return { route: "anthropic", auto: true };
  }
  return { route: "offline", auto: true };
}

/** One line explaining a resolution, for stderr. Empty when nothing to say. */
export function route_note(requested: Provider, decision: RouteDecision): string {
  if (requested !== "auto") {
    return "";
  }
  if (decision.route === "offline") {
    return (
      "note: no reasoning plugin, no GEMINI_API_KEY or GOOGLE_API_KEY, and no " +
      "ANTHROPIC_API_KEY — using offline reasoning, which finds nothing a model would find."
    );
  }
  return `note: auto selected the ${decision.route} provider.`;
}
