/**
 * Durable memory.
 *
 * ArgusMemory is documented as "cross-session memory", but its default store
 * is InMemoryVectorDB — a plain array that dies with the process. Every review
 * therefore started with an empty `### Past lessons` section, no matter how
 * many reviews had come before. This module is the persistent implementation
 * of the same VectorDB seam, kept in a JSONL file beside runs.jsonl.
 *
 * The file is an append-only log, not a snapshot: each upsert appends one line
 * and later lines win on load. That keeps two concurrent reviews of the same
 * repo from clobbering each other, at the cost of a periodic compaction.
 *
 * Nothing here throws. A memory that cannot be read or written must degrade to
 * amnesia, not to a failed review — the same rule append_run_record follows.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  matches_filter,
  rank_by_overlap,
  type MemorySearchFilter,
  type VectorDB,
} from "./memory.mjs";

/** One durable lesson. */
export interface MemoryRecord {
  text: string;
  importance: number;
  source: string;
  project?: string;
  /** Absent on records written before languages were tracked. */
  language?: string;
  /** ISO-8601, UTC. */
  created_at: string;
  updated_at: string;
  /** How many reviews have arrived at this same lesson. */
  seen: number;
}

export interface JsonlVectorDBOptions {
  /** Lessons kept after compaction, lowest-importance dropped first. */
  max_records?: number;
  /** Compact once the log holds this many times more lines than records. */
  compaction_ratio?: number;
  now?: () => Date;
}

/** Default sink: `<repo_root>/.argus/memory.jsonl`. */
export function default_memory_path(repo_root: string): string {
  return path.join(path.resolve(repo_root), ".argus", "memory.jsonl");
}

/** Same lesson, restated — collapse to one record rather than accumulating. */
function dedupe_key(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export class JsonlVectorDB implements VectorDB {
  /** Set when the last read or write failed, so callers can surface amnesia. */
  last_error?: string;

  private _records = new Map<string, MemoryRecord>();
  private _lines_on_disk = 0;
  private readonly _max_records: number;
  private readonly _compaction_ratio: number;
  private readonly _now: () => Date;

  constructor(
    public readonly file: string,
    opts: JsonlVectorDBOptions = {},
  ) {
    this._max_records = opts.max_records ?? 2000;
    this._compaction_ratio = opts.compaction_ratio ?? 4;
    this._now = opts.now ?? (() => new Date());
    this._load();
  }

  /** Lessons currently held. */
  get size(): number {
    return this._records.size;
  }

  /** Every record, newest first. Exposed for inspection, not for the hot path. */
  records(): MemoryRecord[] {
    return [...this._records.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  upsert({ text, metadata }: { text: string; metadata?: Record<string, unknown> }): void {
    const trimmed = String(text).trim();
    if (!trimmed) {
      return;
    }
    const key = dedupe_key(trimmed);
    const stamp = this._now().toISOString();
    const prior = this._records.get(key);
    const importance = (metadata?.importance as number) ?? prior?.importance ?? 0.5;
    const source = (metadata?.source as string) ?? "reflection";

    // Consolidation re-writes whatever recall pulled into working memory, so a
    // lesson is upserted again on the very review that recalled it. That is a
    // read, not a re-learning: counting it would make one finding look like it
    // had been independently confirmed every run.
    const relearned = source !== "longterm_retrieval";

    const record: MemoryRecord = {
      text: trimmed,
      // A lesson re-learned is a lesson confirmed: keep the strongest reading.
      importance: prior ? Math.max(prior.importance, importance) : importance,
      source: relearned ? source : (prior?.source ?? source),
      project: (metadata?.project as string | undefined) ?? prior?.project,
      language: (metadata?.language as string | undefined) ?? prior?.language,
      created_at: prior?.created_at ?? stamp,
      updated_at: stamp,
      seen: (prior?.seen ?? 0) + (relearned ? 1 : 0),
    };
    this._records.set(key, record);
    this._append(record);
  }

  search(
    query: string,
    top_k = 5,
    filter?: MemorySearchFilter,
  ): Array<{ text: string; score: number }> {
    const pool = [...this._records.values()]
      .filter((r) => matches_filter(r, filter))
      .map((r) => ({ text: r.text, score: r.importance }));
    return rank_by_overlap(pool, query, top_k);
  }

  describe(): Record<string, unknown> {
    return {
      store: "jsonl",
      file: this.file,
      lessons: this.size,
      ...(this.last_error ? { error: this.last_error } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private _load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf-8");
    } catch (e) {
      // A missing file is the normal first run, not an error worth reporting.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.last_error = message(e);
      }
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      this._lines_on_disk += 1;
      // One corrupt line — a half-written record from a killed process — must
      // not cost us the rest of the memory.
      try {
        const record = JSON.parse(line) as MemoryRecord;
        if (typeof record?.text === "string" && record.text.trim()) {
          this._records.set(dedupe_key(record.text), record);
        }
      } catch {
        continue;
      }
    }
  }

  private _append(record: MemoryRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + "\n", "utf-8");
      this._lines_on_disk += 1;
    } catch (e) {
      this.last_error = message(e);
      return;
    }
    if (
      this._lines_on_disk > this._compaction_ratio * Math.max(this._records.size, 1) ||
      this._records.size > this._max_records
    ) {
      this.compact();
    }
  }

  /**
   * Rewrite the log as one line per lesson, dropping the weakest once over
   * budget. Written to a sibling temp file and renamed, so a crash mid-write
   * leaves the previous memory intact rather than a truncated one.
   */
  compact(): void {
    const kept = [...this._records.values()]
      .sort((a, b) => b.importance - a.importance || b.updated_at.localeCompare(a.updated_at))
      .slice(0, this._max_records);

    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.last_error = message(e);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Nothing more to do — the live file is still the pre-compaction one.
      }
      return;
    }
    this._records = new Map(kept.map((r) => [dedupe_key(r.text), r]));
    this._lines_on_disk = kept.length;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
