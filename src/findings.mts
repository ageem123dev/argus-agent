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
  /**
   * The language the finding is in, from the file's extension.
   *
   * A defect class does not carry across languages: SQL injection in a
   * migration says nothing about a Markdown file, and "null and undefined
   * safety" means something different in Python than in TypeScript. Without
   * this, one repo's prose, schema and application code all pooled into a
   * single body of lessons that recall drew from indiscriminately.
   */
  language?: string;
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

/**
 * Extensions recognizable without a directory to corroborate them. Needed
 * because a bare filename is otherwise indistinguishable from prose that has
 * lost a space after a full stop — "…in workspaceStorage.The next step…" reads
 * as a path unless the extension is one we know.
 */
const KNOWN_EXTENSIONS =
  "m?[jt]sx?|c[jt]s|py|go|rs|rb|java|kt|cs|php|swift|scala|dart|lua|sql|ya?ml|" +
  "json|toml|ini|cfg|xml|css|s[ac]ss|html?|vue|svelte|sh|bash|ps1|c|h|cpp|hpp|" +
  "md|mdx|txt|lock";

/**
 * A cited file path.
 *
 * Two alternatives. With a directory component, any plausible extension is
 * accepted — the slash is corroboration enough, and an explicit extension list
 * silently dropped every finding in a `.md`, `.yml` or `.toml` file. Without
 * one, only known extensions count.
 *
 * Deliberately not `\b`-anchored at the start: a word boundary cannot precede
 * a leading dot, so anchoring made `.claude/skills/x.md` parse as
 * `claude/skills/x.md`. Argus's own findings then never matched another
 * reviewer's, which cite the path in full — every dotfile-directory finding
 * counted as a miss.
 */
const PATH_RE = new RegExp(
  "((?:[\\w.-]+[/\\\\])+[\\w.-]+\\.[A-Za-z][A-Za-z0-9]{0,9}" +
    `|[\\w.-]+\\.(?:${KNOWN_EXTENSIONS}))\\b`,
);

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
/**
 * Language by file extension.
 *
 * Dialects that share a defect surface collapse to one entry — .ts/.mts/.tsx
 * are all "typescript" — because a lesson about one is a lesson about the
 * others. Prose and configuration are included deliberately: reviews do find
 * real problems in Markdown and YAML, and those lessons are worth keeping,
 * just not worth recalling when reviewing code.
 */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  py: "python", pyi: "python",
  sql: "sql",
  md: "markdown", mdx: "markdown", markdown: "markdown", txt: "markdown",
  yml: "yaml", yaml: "yaml",
  json: "json", jsonc: "json",
  toml: "toml", ini: "toml", cfg: "toml",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell",
  go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin",
  cs: "csharp", php: "php", swift: "swift", scala: "scala", dart: "dart",
  lua: "lua", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  css: "css", scss: "css", sass: "css",
  html: "html", htm: "html", vue: "vue", svelte: "svelte", xml: "xml",
};

/** How a language is written in a lesson sentence. */
export const LANGUAGE_DISPLAY: Record<string, string> = {
  typescript: "TypeScript", javascript: "JavaScript", python: "Python",
  sql: "SQL", markdown: "Markdown", yaml: "YAML", json: "JSON", toml: "TOML",
  shell: "shell", powershell: "PowerShell", go: "Go", rust: "Rust",
  ruby: "Ruby", java: "Java", kotlin: "Kotlin", csharp: "C#", php: "PHP",
  swift: "Swift", scala: "Scala", dart: "Dart", lua: "Lua", c: "C",
  cpp: "C++", css: "CSS", html: "HTML", vue: "Vue", svelte: "Svelte", xml: "XML",
};

/** The language a path is written in, or undefined if the extension is unknown. */
export function language_of(file: string | undefined): string | undefined {
  if (!file) {
    return undefined;
  }
  const base = normalize_path(file).split("/").pop() ?? "";
  const cut = base.lastIndexOf(".");
  if (cut <= 0) {
    return undefined; // no extension, or a dotfile with no suffix
  }
  return LANGUAGE_BY_EXTENSION[base.slice(cut + 1).toLowerCase()];
}

export function language_name(language: string | undefined): string | undefined {
  return language ? (LANGUAGE_DISPLAY[language] ?? language) : undefined;
}

/** The distinct languages a set of paths covers, in first-seen order. */
export function languages_of(files: string[]): string[] {
  const seen: string[] = [];
  for (const f of files) {
    const lang = language_of(f);
    if (lang && !seen.includes(lang)) {
      seen.push(lang);
    }
  }
  return seen;
}

/** The key a lesson is filed under: its language and the place it applies to. */
export function scope_key(language: string | undefined, locus: string | undefined): string {
  return `${language ?? ""}|${locus ?? ""}`;
}

/**
 * The (language, place) pairs a change actually contains.
 *
 * A directory does not imply a language — `components/feature/` routinely holds
 * .tsx, .css and .md together — so the two cannot be filtered independently.
 * Taking the union of languages and the union of directories would make a
 * Markdown lesson about `components/feature/**` eligible for a change that
 * touched only the TypeScript there, as long as the diff edited some Markdown
 * anywhere. Pairing them is what makes the distinction hold.
 *
 * Each file contributes its own directory and every ancestor, so a lesson filed
 * against a coarser directory still matches a change deeper inside it.
 */
/**
 * Every place a change touches, ignoring language.
 *
 * Paired with `recall_scopes` this separates two different silences: a place
 * the change never went (a lesson there is simply unrelated, and may still be
 * worth surfacing as a general prior) from a place it went in another language
 * (a lesson there is actively wrong for this change, and must not backfill).
 */
export function recall_loci(files: string[]): string[] {
  const loci = new Set<string>();
  for (const file of files) {
    const p = normalize_path(file);
    loci.add(p);
    const parts = p.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      loci.add(`${parts.slice(0, i).join("/")}/**`);
    }
  }
  return [...loci];
}

export function recall_scopes(files: string[]): string[] {
  const scopes = new Set<string>();
  for (const file of files) {
    const p = normalize_path(file);
    const language = language_of(p);
    if (!language) {
      continue;
    }
    scopes.add(scope_key(language, p)); // a lesson filed against the file itself
    const parts = p.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      scopes.add(scope_key(language, `${parts.slice(0, i).join("/")}/**`));
    }
  }
  return [...scopes];
}

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
  // `language` may be supplied by an adapter that knows better than the
  // extension does; otherwise it is derived below.
  const path = partial.path ? normalize_path(partial.path) : undefined;
  return {
    ...partial,
    path,
    severity: normalize_severity(partial.severity),
    language: partial.language ?? language_of(path),
    locus: locus_from_path(path),
    // Category first: a reviewer's own label is a better signal than our
    // keyword scan over its prose, when it bothered to provide one.
    topic: classify_topic(`${partial.category ?? ""} ${partial.title}`),
  };
}

/**
 * How a finding line announces its severity.
 *
 * Two forms, because the providers genuinely differ and neither is prompted
 * into a schema. The Anthropic path tends to write "severity: high"; the agy
 * path writes a bracketed tag, "- **[high]** path:line — claim". Matching only
 * the first silently found zero findings in every agy review, which at
 * ingestion time made everything the other reviewer found look like a miss —
 * including the findings Argus had itself reported.
 */
const FINDING_LINE_RE = new RegExp(
  `(severity)|(\\[\\s*(?:${Object.keys(SEVERITY_WEIGHT).join("|")})\\s*\\])`,
  "i",
);

/**
 * Parse findings out of review prose — Argus's own verdict format.
 *
 * Line-based and severity-anchored, because that is the only structure the
 * verdict reliably has: the reasoning layer is prompted for severity-tagged
 * findings but not for a schema. Lines with no severity marker are prose, not
 * findings, and are skipped rather than guessed at.
 */
export function parse_findings(text: string, source = "argus"): Finding[] {
  const findings: Finding[] = [];
  const by_location = new Map<string, Finding>();

  for (const raw of String(text).split("\n")) {
    const line = strip_markdown(raw);
    if (!line || !FINDING_LINE_RE.test(line)) {
      continue;
    }
    const location = PATH_LINE_RE.exec(line);
    const finding = make_finding({
      source,
      path: location?.[1],
      line: location?.[2] ? Number(location[2]) : undefined,
      severity: SEVERITY_RE.exec(line)?.[1],
      title: line,
    });

    // A verdict routinely states each finding twice: once in the model's prose
    // summary ("High Severity Queue Starvation (path:221)") and again in the
    // structured list ("**[high]** path:221 — …"). Same file and line is one
    // finding restated, and counting both inflates how much the agent appears
    // to have found — which then skews every ingestion ratio built on it.
    // Findings with no location cannot be told apart, so they are all kept.
    const key = finding.path && finding.line != null ? `${finding.path}:${finding.line}` : null;
    if (key) {
      const prior = by_location.get(key);
      if (prior) {
        // The two statements can disagree on severity; keep the graver reading.
        if (severity_weight(finding.severity) > severity_weight(prior.severity)) {
          prior.severity = finding.severity;
        }
        continue;
      }
      by_location.set(key, finding);
    }
    findings.push(finding);
  }
  return findings;
}
