/**
 * Surviving a provider that is only sometimes there.
 *
 * The retry this replaces sent the identical request a second time: same
 * prompt, same model, no pause. Against a failure that tracks how heavy a
 * request is, that is a coin flip repeated rather than a different strategy —
 * and the fallback beneath it was no lighter, since it routed to the deepest
 * model of all. Two layers of protection, neither of which changed the thing
 * that was failing.
 *
 * A ladder instead: ordered attempts, each a genuinely lighter request than the
 * last, first real review wins. Measured against one fixed review task during
 * the 2026-09 provider incident, empty responses fell away as the request got
 * lighter — 1/2 at ~50k thinking tokens, 1/3 at ~10-27k, 0/3 at ~0 — so
 * lightening is the move that actually changes the odds.
 *
 * Two rules this must not break. It never invents a review: if every rung
 * fails, so does the ladder, because a synthesised "no findings" is
 * indistinguishable from a clean diff and would be recorded as a real run. And
 * it never lies about provenance: a review from any rung but the first carries
 * `fallback`, naming what was tried and what answered.
 */
import { ArgusReasoning, Complexity, EmptyReviewError, ReviewResult, deepest } from "./reasoning.mjs";
import { tier_for_size } from "./review_schema.mjs";

/**
 * The heading argus.mts puts between the diff and the context it gathered.
 *
 * Cutting here is what makes a diff-only retry possible: the reasoning layer is
 * handed one already-augmented string, and this is the seam that gives the bare
 * diff back.
 */
export const CONTEXT_MARKER = "\n\n# Project context:\n";

/** Drop the gathered file bodies, keeping the change itself. */
export function diff_only(augmented: string): string {
  const cut = augmented.indexOf(CONTEXT_MARKER);
  return cut === -1 ? augmented : augmented.slice(0, cut);
}

export interface Rung {
  /** Recorded as `fallback.used` when this rung answers. */
  label: string;
  reasoning: ArgusReasoning;
  /**
   * Cut the request down before this attempt. Identity by default.
   *
   * This is the lever that matters. Reducing context keeps the model's
   * reasoning quality and removes more weight than dropping to a weaker model
   * does — the review gets narrower rather than worse.
   */
  lighten?: (diff: string) => string;
}

export interface LadderOptions {
  /**
   * Pause before each attempt after the first.
   *
   * An upstream incident needs time more than it needs another immediate
   * request; retrying instantly spends the attempt at the moment it is least
   * likely to work.
   */
  backoff_ms?: number;
  /** Injection seam for tests, so the suite does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called as each rung is tried, for logging. */
  on_attempt?: (label: string, index: number) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Try each rung in order; return the first real review.
 *
 * Every rung is attempted even when an earlier one failed for a reason that
 * looks permanent, because rungs may span providers and this layer cannot tell
 * whose failure it is holding. The cost of being wrong is one bounded extra
 * call; the cost of stopping early is losing a review a later rung would have
 * produced.
 */
export class ResilientReasoning extends ArgusReasoning {
  constructor(
    private rungs: Rung[],
    private opts: LadderOptions = {},
  ) {
    super();
    if (!rungs.length) {
      throw new Error("a resilience ladder needs at least one rung");
    }
  }

  override async review(diff: string, floor?: Complexity): Promise<ReviewResult> {
    const sleep = this.opts.sleep ?? wait;
    const backoff = this.opts.backoff_ms ?? 2000;
    const failures: string[] = [];
    let any_empty = false;

    for (let i = 0; i < this.rungs.length; i++) {
      const rung = this.rungs[i];
      if (i > 0) {
        await sleep(backoff);
      }
      this.opts.on_attempt?.(rung.label, i);

      try {
        const request = rung.lighten ? rung.lighten(diff) : diff;
        // A lightened request is smaller text, and anything that routes by size
        // reads smaller as simpler. Without a floor taken from the *original*
        // change, the diff-only rung would answer a complex review on the
        // cheapest setting — degrading it twice over, once for losing context
        // and again for dropping a tier.
        const rung_floor = rung.lighten ? deepest(tier_for_size(diff), floor) : floor;
        const result = await rung.reasoning.review(request, rung_floor);

        // A rung that returns an empty verdict has not answered, whatever it
        // reports. Treated as a failure here so the ladder continues rather
        // than handing back silence that reads as a clean review.
        if (!result?.verdict?.trim()) {
          throw new EmptyReviewError(`${rung.label} returned an empty verdict`);
        }

        if (i > 0) {
          // Provenance survives the recovery: the record must not claim the
          // first rung produced a review a later one did.
          result.fallback = {
            attempted: this.rungs[0].label,
            used: rung.label,
            reason: failures.join("; "),
            attempts: i + 1,
          };
        }
        return result;
      } catch (e) {
        if (e instanceof EmptyReviewError) {
          any_empty = true;
        }
        failures.push(`${rung.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const summary =
      `every reasoning rung failed, so no review was produced. ` +
      `This is a failed review, not a clean one. Tried — ${failures.join(" | ")}`;
    // Only an empty answer is an empty answer. A ladder whose every rung failed
    // because the binary is missing has not produced silence, it has failed to
    // run — and callers separate those by exit code, so relabelling one as the
    // other collapses the distinction the codes exist to make.
    throw any_empty ? new EmptyReviewError(summary, this.rungs.length) : new Error(summary);
  }
}

/**
 * The default ladder: the same provider twice, the second time on the diff
 * alone, then any other provider that is configured.
 *
 * Ordered by what it costs to be wrong. Rung 2 keeps the model and drops the
 * context, so a recovered review is narrower but not weaker. Rung 3 changes
 * provider entirely, which is the only rung that survives one vendor being
 * down, and comes last because it is the one most likely to be unconfigured.
 */
export function default_ladder(
  primary: { label: string; reasoning: ArgusReasoning },
  alternate?: { label: string; reasoning: ArgusReasoning },
): Rung[] {
  const rungs: Rung[] = [
    { label: primary.label, reasoning: primary.reasoning },
    { label: `${primary.label} (diff only)`, reasoning: primary.reasoning, lighten: diff_only },
  ];
  if (alternate) {
    rungs.push({ label: alternate.label, reasoning: alternate.reasoning });
  }
  return rungs;
}
