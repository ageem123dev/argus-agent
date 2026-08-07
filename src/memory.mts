/**
 * Memory — three-tier hierarchical memory plus the agent's review-specific
 * wrapper. Working memory is budget-bound with score-based eviction; the
 * long-term tier is any VectorDB implementation (an in-process keyword
 * store ships as the default so the agent works with zero setup).
 *
 * This module decides *what* is worth remembering; memory_store.mts decides
 * where it is kept, and findings.mts normalizes what a finding is. The three
 * are separable on purpose: `distill_lessons` is pure text-in/lessons-out and
 * testable without touching a disk.
 */
import {
  language_name,
  languages_of,
  parse_findings,
  recall_loci,
  recall_scopes,
  scope_key,
  severity_weight,
  type Finding,
} from "./findings.mjs";

export enum MemoryTier {
  WORKING = 1, // Context window
  SESSION = 2, // Current session buffer
  LONGTERM = 3, // Persistent storage
}

/** Narrows retrieval. Stores may ignore it. */
export interface MemorySearchFilter {
  project?: string;
  /**
   * Languages the change touches. A lesson in a language the change does not
   * contain is excluded outright rather than outranked: a Markdown lesson
   * competing for a slot in a Python review is not a weak match, it is a wrong
   * one. Lessons stored before languages were recorded carry none and stay
   * eligible — an unknown language must not silently drop the existing corpus.
   */
  languages?: string[];
  /**
   * The (language, place) pairs the change actually contains, from
   * `recall_scopes`. Lessons matching one are ranked ahead of the rest, which
   * is what keeps a Markdown lesson about a mixed folder from displacing the
   * TypeScript lesson about that same folder. Remaining slots still fall back
   * to same-language lessons elsewhere, so a general prior can still transfer.
   */
  scopes?: string[];
  /**
   * Every place the change touches, regardless of language. A lesson filed
   * against one of these in a language the change did not touch there is
   * excluded outright — the Markdown lesson about a folder is wrong for a
   * change that edited only that folder's TypeScript, even when the diff
   * happens to move Markdown elsewhere.
   */
  loci?: string[];
}

/** Build the filter for a change. One place so the two stores cannot diverge. */
export function recall_filter(project: string, changed_files: string[]): MemorySearchFilter {
  return {
    project,
    languages: languages_of(changed_files),
    scopes: recall_scopes(changed_files),
    loci: recall_loci(changed_files),
  };
}

/** The interface the long-term store must satisfy. */
export interface VectorDB {
  upsert(args: { text: string; metadata?: Record<string, unknown> }): void;
  search(
    query: string,
    top_k?: number,
    filter?: MemorySearchFilter,
  ): Array<{ text: string; score: number }>;
  /**
   * Optional self-report — where the store lives, how much it holds, whether
   * it is degraded. Surfaced as `memory_meta` so a caller can tell recall from
   * amnesia without knowing which implementation is attached.
   */
  describe?(): Record<string, unknown>;
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
  "issues", "severity", "defects", "found", "there",
  // File extensions. Every path in a TypeScript repo ends in one, so they match
  // everything and separate nothing — pure dilution once tokens this short are
  // admitted at all.
  "mts", "cts", "tsx", "jsx", "mjs", "cjs", "json", "yml", "yaml", "toml", "md",
  "mdx", "css", "scss", "html", "htm", "sql", "sh", "py", "rb", "rs", "go",
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
        // Three characters, not four: path segments carry most of the signal
        // here, and `app`, `api`, `db`, `src` and `lib` are exactly the ones a
        // longer minimum discards. Dropping them let `core/quarantine/**` beat
        // `app/quarantine/**` on every diff touching both, because only one of
        // the two had a second scorable token.
        .filter((t) => t.length > 2 && !STOP_TOKENS.has(t)),
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
/** A record as the filter and ranker need to see it. */
export interface ScopedRecord {
  text: string;
  score: number;
  project?: string;
  language?: string;
  locus?: string;
}

/** True when a record is eligible under a filter. Shared by both stores. */
export function matches_filter(
  record: { project?: string; language?: string },
  filter?: MemorySearchFilter,
): boolean {
  if (filter?.project && record.project && record.project !== filter.project) {
    return false;
  }
  // A record with no language predates language tracking; keep it eligible.
  if (filter?.languages?.length && record.language) {
    return filter.languages.includes(record.language);
  }
  return true;
}

/**
 * Rank eligible records, preferring those filed against a (language, place)
 * the change actually contains.
 *
 * Two tiers rather than one filter: an exact scope match is the lesson written
 * about this very code, and it should never lose a slot to a lesson that merely
 * shares a language. But excluding everything else would strand general priors
 * — "TypeScript here keeps getting concurrency wrong" is worth surfacing on a
 * TypeScript change in a directory that has no lessons of its own yet.
 */
export function rank_scoped<T extends ScopedRecord>(
  items: T[],
  query: string,
  top_k: number,
  filter?: MemorySearchFilter,
): T[] {
  const eligible = items.filter((r) => matches_filter(r, filter));
  const scopes = filter?.scopes;
  if (!scopes?.length) {
    return rank_by_overlap(eligible, query, top_k);
  }
  const scoped = (r: T) => r.language && r.locus && scopes.includes(scope_key(r.language, r.locus));
  // Wrong language for a place this change edits. Not merely unrelated — the
  // change went here and this is not what it wrote — so it is dropped rather
  // than left to backfill a spare slot.
  const wrong_language_here = (r: T) =>
    !scoped(r) && r.locus && filter?.loci?.includes(r.locus) === true;

  const in_scope = new Set(eligible.filter(scoped));
  // Inside the scope, keyword overlap is the wrong ranker: every one of these
  // is confirmed to be about code this change edits, so overlap only measures
  // how many path segments the lesson's directory happens to have. A lesson
  // about `.claude/skills/bmad-ship-story/**` outscored one about
  // `app/quarantine/**` five tokens to two and took every slot. Severity is
  // what should order lessons already known to apply.
  const ranked = [...in_scope]
    .sort((a, b) => b.score - a.score || score_overlap(query, b.text) - score_overlap(query, a.text))
    .slice(0, top_k);
  if (ranked.length >= top_k) {
    return ranked;
  }
  // Remaining slots go to lessons about places this change did not touch —
  // general priors in a language it does use.
  const rest = eligible.filter((r) => !in_scope.has(r) && !wrong_language_here(r));
  return [...ranked, ...rank_by_overlap(rest, query, top_k - ranked.length)];
}

export class InMemoryVectorDB implements VectorDB {
  private _items: ScopedRecord[] = [];

  upsert({ text, metadata }: { text: string; metadata?: Record<string, unknown> }): void {
    this._items.push({
      text,
      score: (metadata?.importance as number) ?? 0.5,
      project: metadata?.project as string | undefined,
      language: metadata?.language as string | undefined,
      locus: metadata?.locus as string | undefined,
    });
  }

  search(query: string, top_k = 5, filter?: MemorySearchFilter): Array<{ text: string; score: number }> {
    return rank_scoped(this._items, query, top_k, filter).map((r) => ({
      text: r.text,
      score: r.score,
    }));
  }

  describe(): Record<string, unknown> {
    return { store: "in-process", lessons: this._items.length };
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
  /** Scopes the entry so a Markdown lesson does not surface in a Python review. */
  language?: string;
  /** The place the lesson applies to. Paired with `language`, never alone. */
  locus?: string;
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
  add(
    content: string,
    source: string,
    importance = 0.5,
    scope: { project?: string; language?: string; locus?: string } = {},
  ): void {
    const entry = new MemoryEntry(content, MemoryTier.WORKING, source, {
      importance,
      project: scope.project,
      language: scope.language,
      locus: scope.locus,
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
      // No language: a retrieved entry's own language is not known here, and
      // guessing it from the query would relabel the record on re-consolidation.
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
          language: entry.language,
          locus: entry.locus,
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
  /** Who raised the underlying finding. Reported, not written into the text. */
  raised_by?: string;
  /** The language the lesson is about. Scopes recall. */
  language?: string;
}

/**
 * Turn one finding into a lesson.
 *
 * The phrasing is deliberately *where to look harder*, never what to report. A
 * lesson that says "this file has an unverified-JWT bug" is an instruction to
 * find one again; a lesson that says "token verification in src/auth/** has
 * been wrong before" is a reason to read carefully. The first manufactures
 * false positives on the next run, the second does not — which matters most
 * for lessons sourced from *another* reviewer's findings, where the temptation
 * to encode the answer is strongest.
 *
 * `attribution` names who raised it, so a lesson learned from a missed finding
 * reads as such rather than as Argus's own past work.
 */
export function lesson_from_finding(
  finding: Finding,
  project: string,
  attribution = "a past review",
): DistilledLesson {
  // The text carries only what identifies the lesson: the language, the place
  // and the issue class. Severity and attribution used to be in the sentence,
  // which made the *same* lesson a different record every time either changed —
  // one directory accumulated three variants that then competed for the same
  // three recall slots. Severity survives as `importance`, which ranking reads.
  const language = language_name(finding.language);
  const where = finding.locus
    ? language
      ? `${language} under ${finding.locus}`
      : finding.locus
    : (language ?? "this project");
  return {
    text: finding.topic
      ? `[${project}] Look harder in ${where} for ${finding.topic}.`
      : `[${project}] Look harder in ${where}; past reviews have found defects there.`,
    importance: severity_weight(finding.severity),
    locus: finding.locus,
    topic: finding.topic,
    language: finding.language,
    raised_by: attribution,
  };
}

/**
 * Reduce a verdict to lessons worth keeping.
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
  return lessons_from_findings(parse_findings(verdict, "argus"), project, {
    max_lessons,
  });
}

export interface LessonOptions {
  max_lessons?: number;
  /** Who raised these findings, for the lesson text. */
  attribution?: string;
}

/** Shared by verdict distillation and by ingestion of another reviewer's misses. */
export function lessons_from_findings(
  findings: Finding[],
  project: string,
  opts: LessonOptions = {},
): DistilledLesson[] {
  const max_lessons = opts.max_lessons ?? 5;
  const lessons: DistilledLesson[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!finding.locus && !finding.topic) {
      continue; // nothing generalizable — do not store the raw finding
    }
    // One lesson per language, place and class: five findings about the same
    // directory are one thing to remember, not five — but the Markdown and the
    // TypeScript in that directory are two.
    const key = `${finding.language ?? ""}|${finding.locus ?? ""}|${finding.topic ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lessons.push(lesson_from_finding(finding, project, opts.attribution));
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
      this.memory.add(lesson.text, "reflection", lesson.importance, {
        project,
        language: lesson.language,
        locus: lesson.locus,
      });
    }
    this.memory.consolidate();
    this.trace.stored = lessons.map((l) => l.text);
    return this.trace.stored;
  }

  /**
   * Retrieve relevant past findings before starting.
   *
   * `changed_files` is both the query and the scope: lessons are filed against
   * a language and a place, so the paths a change touches are what selects
   * them. Pass `summary` only when the changed paths are unknown — recall then
   * falls back to text overlap with no scoping, which is the older, blunter
   * behaviour.
   */
  before_review(project: string, changed_files: string[], summary?: string): string[] {
    const query = summary ?? changed_files.join(" ");
    const recalled = this.memory.retrieve(
      `Past reviews for ${project}: ${query}`,
      3,
      recall_filter(project, changed_files),
    );
    this.trace.recalled = recalled;
    return recalled;
  }
}
