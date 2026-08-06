/**
 * Findings — one normalized shape for a code-review finding, whoever produced it.
 *
 * Argus emits prose; another reviewer emits its own format. Comparing the two
 * requires both to reduce to the same record: a file, maybe a line, a severity,
 * and the issue class it falls into. That reduction lives here so the
 * comparison in ingest.mts never has to know which reviewer it is holding, and
 * so the pattern tables are stated once rather than per-adapter.
 */

/** One finding, from any reviewer. */
export interface Finding {
  /** Who produced it: "argus", "coderabbit", … */
  source: string;
  /** Repo-relative, forward slashes. Absent when the reviewer named no file. */
  path?: string;
  line?: number;
  /** Normalized to the SEVERITY_WEIGHT keys; "medium" when unstated. */
  severity: string;
  /** The claim, one line, markdown stripped. */
  title: string;
  /** The reviewer's own label, kept verbatim — not normalized into `topic`. */
  category?: string;
  /**
   * The reviewer's own identifier for this finding, when it has a stable one
   * (CodeRabbit calls it a fingerprint). Kept for auditing a lesson back to
   * the finding that produced it.
   */
  id?: string;
  /** The reviewer's own severity word, before normalization. */
  raw_severity?: string;
  /** Directory glob the finding sits in: the unit lessons generalize over. */
  locus?: string;
  /** Issue class from TOPICS, when one is recognizable. */
  topic?: string;
}

export const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 0.95,
  high: 0.9,
  medium: 0.7,
  moderate: 0.7,
  low: 0.55,
  minor: 0.5,
  info: 0.4,
  nit: 0.35,
};

const SEVERITY_RE = /\b(critical|high|medium|moderate|low|minor|info|nit)\b/i;

/**
 * Issue classes worth generalizing over. Deliberately coarse: the point is to
 * remember which *kind* of bug this codebase has had, not to re-litigate one.
 */
export const TOPICS: Array<[string, RegExp]> = [
  ["authentication and token handling", /\b(auth\w*|jwt|tokens?|oauth|sessions?|credentials?|passwords?|login)\b/i],
  ["injection and untrusted input", /\b(sql|injections?|sanitiz\w+|escap\w+|xss|eval)\b/i],
  ["secrets exposure", /\b(secrets?|hardcoded|api[_\s-]?keys?|dotenv)\b/i],
  ["null and undefined safety", /\b(null|undefined|nullable|nullish|npe)\b/i],
  ["error handling", /\b(unhandled|swallow\w*|rethrow|uncaught|silently)\b/i],
  ["concurrency", /\b(races?|concurren\w+|deadlocks?|locks?|atomic|await)\b/i],
  ["resource leaks", /\b(leaks?|leaking|unclosed|dispose|descriptors?)\b/i],
  ["input validation", /\b(validat\w+|bounds|overflows?|untrusted|unchecked)\b/i],
  ["type safety", /\b(casts?|coercion|assertions?|unsound)\b/i],
  ["performance", /\b(quadratic|slow\w*|bottlenecks?|perf)\b/i],
];

const PATH_RE =
  /\b((?:[\w.-]+[/\\])+[\w.-]+\.(?:m?[jt]sx?|py|go|rs|rb|java|cs|php|sql|ya?ml|json|sh|c|h|cpp|hpp))\b/;

/** `path:line` or `path:line:col`, as most reviewers cite a location. */
const PATH_LINE_RE = new RegExp(PATH_RE.source + "(?::(\\d+))?");

/** Strip markdown ornamentation so the heuristics see prose. */
export function strip_markdown(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalize_severity(raw: string | undefined): string {
  const m = raw ? SEVERITY_RE.exec(raw) : null;
  return (m?.[1] ?? "medium").toLowerCase();
}

export function severity_weight(severity: string): number {
  return SEVERITY_WEIGHT[severity.toLowerCase()] ?? 0.6;
}

/** Repo-relative, forward slashes, without a diff header's a/ or b/ prefix. */
export function normalize_path(raw: string): string {
  return raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^[ab]\//, "");
}

/** Generalize a concrete path to the directory that keeps having the problem. */
export function locus_from_path(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const file = normalize_path(raw);
  const cut = file.lastIndexOf("/");
  return cut > 0 ? `${file.slice(0, cut)}/**` : file;
}

/**
 * Best-matching issue class, by how many distinct terms hit.
 *
 * Ranked rather than first-match-wins: a finding that says "jwt", "token" and
 * "verify" is about auth even though it also says "await", and taking the
 * first table entry that matched would let table order decide. Ties still fall
 * to table order, so a genuinely ambiguous finding is classified arbitrarily —
 * see the caveat on partition_findings about what that costs.
 */
export function classify_topic(text: string): string | undefined {
  let best: string | undefined;
  let best_hits = 0;
  for (const [name, re] of TOPICS) {
    const hits = (text.match(new RegExp(re.source, "gi")) ?? []).length;
    if (hits > best_hits) {
      best = name;
      best_hits = hits;
    }
  }
  return best;
}

/** Fill in the derived fields an adapter should not have to compute itself. */
export function make_finding(
  partial: Omit<Finding, "severity" | "locus" | "topic"> & { severity?: string },
): Finding {
  const path = partial.path ? normalize_path(partial.path) : undefined;
  return {
    ...partial,
    path,
    severity: normalize_severity(partial.severity),
    locus: locus_from_path(path),
    // Category first: a reviewer's own label is a better signal than our
    // keyword scan over its prose, when it bothered to provide one.
    topic: classify_topic(`${partial.category ?? ""} ${partial.title}`),
  };
}

/**
 * Parse findings out of review prose — Argus's own verdict format.
 *
 * Line-based and severity-anchored, because that is the only structure the
 * verdict reliably has: the reasoning layer is prompted for severity-tagged
 * findings but not for a schema. Lines without a severity marker are prose,
 * not findings, and are skipped rather than guessed at.
 */
export function parse_findings(text: string, source = "argus"): Finding[] {
  const findings: Finding[] = [];
  for (const raw of String(text).split("\n")) {
    const line = strip_markdown(raw);
    if (!line || !/severity/i.test(line)) {
      continue;
    }
    const location = PATH_LINE_RE.exec(line);
    findings.push(
      make_finding({
        source,
        path: location?.[1],
        line: location?.[2] ? Number(location[2]) : undefined,
        severity: SEVERITY_RE.exec(line)?.[1],
        title: line,
      }),
    );
  }
  return findings;
}
