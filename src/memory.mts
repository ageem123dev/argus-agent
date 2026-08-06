/**
 * Memory — three-tier hierarchical memory plus the agent's review-specific
 * wrapper. Working memory is budget-bound with score-based eviction; the
 * long-term tier is any VectorDB implementation (an in-process keyword
 * store ships as the default so the agent works with zero setup).
 *
 * This module decides *what* is worth remembering; memory_store.mts decides
 * where it is kept. The two are separable on purpose: `distill_lessons` is
 * pure text-in/lessons-out and testable without touching a disk.
 */

export enum MemoryTier {
  WORKING = 1, // Context window
  SESSION = 2, // Current session buffer
  LONGTERM = 3, // Persistent storage
}

/** Narrows retrieval to one project's lessons. Stores may ignore it. */
export interface MemorySearchFilter {
  project?: string;
}

/** The interface the long-term store must satisfy. */
export interface VectorDB {
  upsert(args: { text: string; metadata?: Record<string, unknown> }): void;
  search(
    query: string,
    top_k?: number,
    filter?: MemorySearchFilter,
  ): Array<{ text: string; score: number }>;
}

// ---------------------------------------------------------------------------
// Retrieval scoring
// ---------------------------------------------------------------------------

/**
 * Tokens that carry no signal in a code-review corpus. Without this the diff
 * header ("diff --git a/src/... b/src/...") dominates every query.
 */
const STOP_TOKENS = new Set([
  "diff", "git", "index", "null", "true", "false", "this", "that", "with", "from",
  "have", "been", "were", "which", "would", "should", "code", "file", "files",
  "line", "lines", "review", "reviews", "reviewed", "past", "change", "changes",
  "changed", "project", "lesson", "lessons", "harder", "flagged", "look", "issue",
  "issues", "severity",
]);

/**
 * Split text into comparable terms. Splitting on non-alphanumerics (not just
 * whitespace) is what makes path recall work: a diff header contributes the
 * token `auth` from `a/src/auth/token.mts`, so it can match a lesson about
 * `src/auth/**` that shares no whole-string substring with it.
 */
export function tokenize(text: string): string[] {
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3 && !STOP_TOKENS.has(t)),
    ),
  ];
}

/** Fraction of the query's distinct terms present in `text`. Range 0..1. */
export function score_overlap(query: string, text: string): number {
  const terms = tokenize(query);
  if (!terms.length) {
    return 0;
  }
  const haystack = new Set(tokenize(text));
  return terms.filter((t) => haystack.has(t)).length / terms.length;
}

/**
 * Rank candidates by overlap and take the best `top_k`.
 *
 * Filtering before slicing matters: the reverse order (slice, then drop
 * non-matches) silently returns fewer than `top_k` results whenever a
 * non-matching record happens to sort into the window.
 */
export function rank_by_overlap<T extends { text: string; score: number }>(
  items: T[],
  query: string,
  top_k: number,
): T[] {
  return items
    .map((item) => ({ item, overlap: score_overlap(query, item.text) }))
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.item.score - a.item.score)
    .slice(0, top_k)
    .map((s) => s.item);
}

/**
 * Default zero-dependency store: keyword-overlap scoring, in-process.
 *
 * Nothing here survives the process. Use JsonlVectorDB from memory_store.mts
 * for memory that actually spans sessions.
 */
export class InMemoryVectorDB implements VectorDB {
  private _items: Array<{ text: string; score: number; project?: string }> = [];

  upsert({ text, metadata }: { text: string; metadata?: Record<string, unknown> }): void {
    this._items.push({
      text,
      score: (metadata?.importance as number) ?? 0.5,
      project: metadata?.project as string | undefined,
    });
  }

  search(query: string, top_k = 5, filter?: MemorySearchFilter): Array<{ text: string; score: number }> {
    const pool = filter?.project
      ? this._items.filter((r) => !r.project || r.project === filter.project)
      : this._items;
    return rank_by_overlap(pool, query, top_k).map((r) => ({ text: r.text, score: r.score }));
  }
}

export class MemoryEntry {
  created_at: number = Date.now() / 1000;
  last_accessed: number = Date.now() / 1000;
  access_count = 0;
  importance = 0.5; // 0.0 (trivial) to 1.0 (critical)
  token_count = 0;
  /** Scopes the entry so one repo's lessons do not leak into another's review. */
  project?: string;
  _score?: number;

  constructor(
    public content: string,
    public tier: MemoryTier,
    public source: string, // "user", "tool", "reflection", "file"
    init: Partial<MemoryEntry> = {},
  ) {
    Object.assign(this, init);
  }
}

/** Three-tier memory with promotion and eviction. */
export class HierarchicalMemory {
  working: MemoryEntry[] = [];
  session: MemoryEntry[] = [];

  constructor(
    public vector_db: VectorDB,
    public working_budget: number = 150_000,
  ) {}

  /** Add new information to working memory. */
  add(content: string, source: string, importance = 0.5, project?: string): void {
    const entry = new MemoryEntry(content, MemoryTier.WORKING, source, {
      importance,
      project,
      token_count: Math.floor(content.length / 4),
    });
    this.working.push(entry);
    this._enforce_budget();
  }

  /** Promote relevant long-term memories to working. */
  retrieve(query: string, k = 5, filter?: MemorySearchFilter): string[] {
    const results = this.vector_db.search(query, k, filter);
    for (const result of results) {
      const entry = new MemoryEntry(result.text, MemoryTier.WORKING, "longterm_retrieval", {
        importance: result.score,
        project: filter?.project,
        token_count: Math.floor(result.text.length / 4),
      });
      this.working.push(entry);
    }
    this._enforce_budget();
    return results.map((r) => r.text);
  }

  /** Evict lowest-priority items when over budget. */
  private _enforce_budget(): void {
    let total = this.working.reduce((sum, e) => sum + e.token_count, 0);
    if (total <= this.working_budget) {
      return;
    }

    const now = Date.now() / 1000;
    for (const entry of this.working) {
      const recency = 1.0 / (1.0 + (now - entry.last_accessed) / 3600);
      entry._score =
        entry.importance * 0.5 + recency * 0.3 + Math.min(entry.access_count / 10, 1.0) * 0.2;
    }
    this.working.sort((a, b) => (a._score ?? 0) - (b._score ?? 0));

    while (total > this.working_budget && this.working.length) {
      const evicted = this.working.shift()!;
      evicted.tier = MemoryTier.SESSION;
      this.session.push(evicted);
      total -= evicted.token_count;
    }
  }

  /** End-of-session: persist important memories. */
  consolidate(): void {
    const important = [...this.session, ...this.working].filter(
      (e) => e.importance > 0.6 || e.source === "reflection",
    );
    for (const entry of important) {
      this.vector_db.upsert({
        text: entry.content,
        metadata: {
          source: entry.source,
          importance: entry.importance,
          project: entry.project,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Lesson distillation
// ---------------------------------------------------------------------------

/**
 * A generalization worth carrying to the next review, with the weight the
 * finding's severity earns it.
 */
export interface DistilledLesson {
  text: string;
  importance: number;
  /** Directory glob the finding pointed at, when the verdict named a file. */
  locus?: string;
  /** Issue class the finding fell into, when one was recognizable. */
  topic?: string;
}

const SEVERITY_WEIGHT: Record<string, number> = {
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
const TOPICS: Array<[string, RegExp]> = [
  ["authentication and token handling", /\b(auth\w*|jwt|tokens?|oauth|sessions?|credentials?|passwords?|login)\b/i],
  ["injection and untrusted input", /\b(sql|injections?|sanitiz\w+|escap\w+|xss|eval)\b/i],
  ["secrets exposure", /\b(secrets?|hardcoded|api[_\s-]?keys?|dotenv)\b/i],
  ["null and undefined safety", /\b(null|undefined|nullable|nullish|npe)\b/i],
  ["error handling", /\b(unhandled|swallow\w*|rethrow|uncaught|silently)\b/i],
  ["concurrency", /\b(races?|concurren\w+|deadlocks?|locks?|atomic|await)\b/i],
  ["resource leaks", /\b(leaks?|leaking|unclosed|dispose|descriptors?)\b/i],
  ["input validation", /\b(validat\w+|bounds|overflows?|untrusted|unchecked)\b/i],
  ["type safety", /\b(casts?|coercion|assertions?|unsound)\b/i],
  ["performance", /\b(quadratic|slowdowns?|bottlenecks?|perf)\b/i],
];

const PATH_RE =
  /\b((?:[\w.-]+[/\\])+[\w.-]+\.(?:m?[jt]sx?|py|go|rs|rb|java|cs|php|sql|ya?ml|json|sh|c|h|cpp|hpp))\b/;

/** Strip markdown ornamentation so the heuristics see prose. */
function strip_markdown(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Generalize a concrete path to the directory that keeps having the problem. */
function locus_of(line: string): string | undefined {
  const m = PATH_RE.exec(line);
  if (!m) {
    return undefined;
  }
  const file = m[1].replaceAll("\\", "/");
  // Drop a leading a/ or b/ contributed by diff headers.
  const cleaned = file.replace(/^[ab]\//, "");
  const dir = cleaned.slice(0, cleaned.lastIndexOf("/"));
  return dir ? `${dir}/**` : cleaned;
}

function topic_of(line: string): string | undefined {
  for (const [name, re] of TOPICS) {
    if (re.test(line)) {
      return name;
    }
  }
  return undefined;
}

/**
 * Reduce a verdict to lessons worth keeping.
 *
 * The output is deliberately phrased as *where to look harder*, never as what
 * to report. A lesson that says "this file has an unverified-JWT bug" is an
 * instruction to find one again; a lesson that says "token verification in
 * src/auth/** has been wrong before" is a reason to read carefully. The first
 * manufactures false positives on the next run, the second does not.
 *
 * Findings that generalize to neither a locus nor a topic are dropped rather
 * than stored verbatim — a truncated verdict is noise, and noise in memory is
 * worse than an empty memory because it crowds out real recall.
 */
export function distill_lessons(
  verdict: string,
  project: string,
  max_lessons = 5,
): DistilledLesson[] {
  const lessons: DistilledLesson[] = [];
  const seen = new Set<string>();

  for (const raw of String(verdict).split("\n")) {
    const line = strip_markdown(raw);
    if (!line || !/severity/i.test(line)) {
      continue;
    }
    const locus = locus_of(line);
    const topic = topic_of(line);
    if (!locus && !topic) {
      continue; // nothing generalizable — do not store the raw finding
    }
    const key = `${locus ?? ""}|${topic ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const severity = (SEVERITY_RE.exec(line)?.[1] ?? "medium").toLowerCase();
    const where = locus ? `in ${locus}` : "in this project";
    const what = topic ?? "this class of defect";
    lessons.push({
      text: `[${project}] Look harder ${where} for ${what}; a past review raised a ${severity}-severity finding there.`,
      importance: SEVERITY_WEIGHT[severity] ?? 0.6,
      locus,
      topic,
    });
    if (lessons.length >= max_lessons) {
      break;
    }
  }
  return lessons;
}

// ---------------------------------------------------------------------------
// The agent's memory layer
// ---------------------------------------------------------------------------

/** What one review did with memory — surfaced in ReviewOutcome and run records. */
export interface MemoryTrace {
  recalled: string[];
  stored: string[];
  /** Store class actually in use — the difference between learning and amnesia. */
  store: string;
}

/** Cross-session memory for the Argus code reviewer. */
export class ArgusMemory {
  trace: MemoryTrace;

  constructor(public memory: HierarchicalMemory = new HierarchicalMemory(new InMemoryVectorDB())) {
    this.trace = { recalled: [], stored: [], store: memory.vector_db.constructor.name };
  }

  /** Distill the verdict into generalizations and persist them. */
  after_review(verdict: string, project: string): string[] {
    const lessons = distill_lessons(verdict, project);
    for (const lesson of lessons) {
      this.memory.add(lesson.text, "reflection", lesson.importance, project);
    }
    this.memory.consolidate();
    this.trace.stored = lessons.map((l) => l.text);
    return this.trace.stored;
  }

  /** Retrieve relevant past findings before starting. */
  before_review(project: string, diff_summary: string): string[] {
    const recalled = this.memory.retrieve(
      `Past reviews for ${project}: ${diff_summary}`,
      3,
      { project },
    );
    this.trace.recalled = recalled;
    return recalled;
  }
}
