/**
 * Memory — three-tier hierarchical memory plus the agent's review-specific
 * wrapper. Working memory is budget-bound with score-based eviction; the
 * long-term tier is any VectorDB implementation (an in-process keyword
 * store ships as the default so the agent works with zero setup).
 */

export enum MemoryTier {
  WORKING = 1, // Context window
  SESSION = 2, // Current session buffer
  LONGTERM = 3, // Persistent storage
}

/** The interface the long-term store must satisfy. */
export interface VectorDB {
  upsert(args: { text: string; metadata?: Record<string, unknown> }): void;
  search(query: string, top_k?: number): Array<{ text: string; score: number }>;
}

/**
 * Default zero-dependency store: keyword-overlap scoring, in-process.
 * Swap for a real vector database in production.
 */
export class InMemoryVectorDB implements VectorDB {
  private _items: Array<{ text: string; score: number }> = [];

  upsert({ text, metadata }: { text: string; metadata?: Record<string, unknown> }): void {
    this._items.push({ text, score: (metadata?.importance as number) ?? 0.5 });
  }

  search(query: string, top_k = 5): Array<{ text: string; score: number }> {
    const terms = String(query)
      .split(/\s+/)
      .filter((t) => t.length > 3)
      .map((t) => t.toLowerCase());
    const scored = this._items
      .map((r) => ({ score: terms.filter((t) => r.text.toLowerCase().includes(t)).length, r }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, top_k).filter((s) => s.score > 0).map((s) => s.r);
  }
}

export class MemoryEntry {
  created_at: number = Date.now() / 1000;
  last_accessed: number = Date.now() / 1000;
  access_count = 0;
  importance = 0.5; // 0.0 (trivial) to 1.0 (critical)
  token_count = 0;
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
  add(content: string, source: string, importance = 0.5): void {
    const entry = new MemoryEntry(content, MemoryTier.WORKING, source, {
      importance,
      token_count: Math.floor(content.length / 4),
    });
    this.working.push(entry);
    this._enforce_budget();
  }

  /** Promote relevant long-term memories to working. */
  retrieve(query: string, k = 5): string[] {
    const results = this.vector_db.search(query, k);
    for (const result of results) {
      const entry = new MemoryEntry(result.text, MemoryTier.WORKING, "longterm_retrieval", {
        importance: result.score,
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
        metadata: { source: entry.source, importance: entry.importance },
      });
    }
  }
}

/** Cross-session memory for the Argus code reviewer. */
export class ArgusMemory {
  constructor(public memory: HierarchicalMemory = new HierarchicalMemory(new InMemoryVectorDB())) {}

  /** Persist review findings for future sessions. */
  after_review(review_summary: string, project: string): void {
    this.memory.add(`[${project}] ${review_summary}`, "reflection", 0.8);
    this.memory.consolidate();
  }

  /** Retrieve relevant past findings before starting. */
  before_review(project: string, diff_summary: string): string[] {
    return this.memory.retrieve(`Past reviews for ${project}: ${diff_summary}`, 3);
  }
}
