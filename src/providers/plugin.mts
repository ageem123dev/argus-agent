/**
 * Reasoning providers loaded at runtime, from outside this repository.
 *
 * Argus's reasoning layer is a seam, not a fixed list: anything with a
 * `review(diff)` method can answer. A provider that cannot ship here — because
 * it drives a vendor's own client in a way that vendor's terms do not clearly
 * permit, or because it is specific to one machine — can therefore live beside
 * the repo instead of inside it, and be named in configuration.
 *
 * Nothing about a plugin is trusted implicitly: it is code the user chose to
 * point at, loaded only when configured, and it is reported by path in the run
 * record so a review can always be traced to whatever actually answered it.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { ArgusReasoning } from "../reasoning.mjs";
import type { ProviderOptions } from "../provider_trace.mjs";

/** What a plugin module must export. */
export interface ReasoningPlugin {
  /** Shown in `--provider` errors and recorded in run records. */
  name: string;
  /** Build the reasoning instance. May be async; may throw with a real reason. */
  create(opts: ProviderOptions): ArgusReasoning | Promise<ArgusReasoning>;
}

export class PluginError extends Error {
  constructor(
    message: string,
    public spec: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

/** Where a plugin path came from, which decides whether it may be trusted. */
export type PluginSource =
  | "environment" // ARGUS_REASONING_PLUGIN — set by whoever runs Argus
  | "repository"; // config inside the repo under review — written by the reviewed code

export interface PluginSpec {
  path: string;
  source: PluginSource;
  /**
   * Whether `auto` may select this plugin without being asked.
   *
   * Only the environment is. A repository under review supplies its own
   * config, so honouring `reasoning.plugin` from it would let any checked-out
   * repo run code as whoever started the review — `.gitignore` is not a trust
   * boundary, and neither is a file happening to be machine-local in *your* repos.
   */
  trusted: boolean;
}

/**
 * Where a plugin may be named, most specific first.
 *
 * The environment variable exists so a plugin can be used without writing its
 * path into any file — and, more importantly, so `auto` has a source the
 * reviewed code cannot write to.
 */
export function plugin_spec(
  repo_root: string,
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): PluginSpec | undefined {
  if (env.ARGUS_REASONING_PLUGIN) {
    return { path: env.ARGUS_REASONING_PLUGIN, source: "environment", trusted: true };
  }
  if (configured) {
    return { path: configured, source: "repository", trusted: false };
  }
  return undefined;
}

/** Resolve a plugin path against the repo, so config can stay relative. */
export function resolve_plugin_path(spec: string, repo_root: string): string {
  return path.isAbsolute(spec) ? spec : path.resolve(repo_root, spec);
}

/**
 * Load and instantiate a plugin.
 *
 * Every failure names the path that was tried. A plugin is by definition not
 * in this repository, so "cannot find module" with no path is unactionable —
 * the user is the only one who knows where they put it.
 */
export async function load_plugin(
  spec: string,
  repo_root: string,
  opts: ProviderOptions = {},
): Promise<{ reasoning: ArgusReasoning; name: string; path: string }> {
  const resolved = resolve_plugin_path(spec, repo_root);

  let module: Record<string, unknown>;
  try {
    // A file URL, because a Windows absolute path is not a valid import
    // specifier: 'C:' parses as a protocol.
    module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (e) {
    throw new PluginError(
      `could not load reasoning plugin at ${resolved}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      spec,
    );
  }

  const plugin = (module.default ?? module) as Partial<ReasoningPlugin>;
  if (typeof plugin.create !== "function") {
    throw new PluginError(
      `reasoning plugin at ${resolved} exports no create(opts) function. ` +
        `A plugin must export { name, create } — as the default export or as named exports.`,
      spec,
    );
  }

  let reasoning: unknown;
  try {
    reasoning = await plugin.create(opts);
  } catch (e) {
    // Both synchronous throws and rejected promises: a plugin that fails to
    // build is as unusable as one that fails to load, and the path is the
    // only part of the message the user can act on.
    throw new PluginError(
      `reasoning plugin at ${resolved} failed to initialise: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      spec,
    );
  }
  if (!reasoning || typeof (reasoning as ArgusReasoning).review !== "function") {
    throw new PluginError(
      `reasoning plugin at ${resolved} returned something without a review(diff) method.`,
      spec,
    );
  }

  return {
    reasoning: reasoning as ArgusReasoning,
    name: typeof plugin.name === "string" && plugin.name ? plugin.name : "plugin",
    path: resolved,
  };
}
