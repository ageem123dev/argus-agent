/**
 * Reflection — the agent's self-improvement loop.
 *
 * Three integrated mechanisms:
 *   * generator-critic loop — every returned review has been critiqued
 *   * skill library         — reusable review playbooks, verified before reuse
 *   * experience replay     — L0 traces / L1 lessons / L2 heuristics with an
 *                             adaptive failure-rate extraction trigger
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Generator-critic loop
// ---------------------------------------------------------------------------

export class Critique {
  constructor(
    public score: number,
    public approved: boolean,
    public feedback_text = "",
    public issues: string[] = [],
  ) {}
}

export interface RefineResult {
  output: string;
  iterations: number;
  final_score: number;
  converged: boolean;
}

/** Generator-Critic with bounded iteration + final-output guarantee. */
export class GeneratorCriticLoop {
  history: Array<Record<string, unknown>> = [];

  constructor(
    private _generate: (task: string, ctx: string) => Promise<string> | string,
    private _critique: (
      task: string,
      output: string,
      tool_feedback: string,
    ) => Promise<Critique> | Critique,
    public max_iterations = 3,
    public quality_threshold = 0.9,
  ) {}

  /** Run generator-critic; final output is always paired with its critique. */
  async refine(
    task: string,
    tool_fn: ((output: string) => Promise<string> | string) | null = null,
  ): Promise<RefineResult> {
    let output = await this._generate(task, "");
    let critique: Critique | null = null;
    for (let i = 0; i < this.max_iterations; i++) {
      const tool_feedback = tool_fn ? await tool_fn(output) : "";
      critique = await this._critique(task, output, tool_feedback);
      this.history.push({ iteration: i, score: critique.score, approved: critique.approved });
      if (critique.approved) {
        return { output, iterations: i + 1, final_score: critique.score, converged: true };
      }
      // Refine only when iterations remain (loop invariant: output paired with critique)
      if (i < this.max_iterations - 1) {
        let ctx = `Issues:\n${critique.feedback_text}`;
        if (tool_feedback) {
          ctx += `\nTool: ${tool_feedback}`;
        }
        output = await this._generate(task, ctx);
      }
    }
    return {
      output,
      iterations: this.max_iterations,
      final_score: critique ? critique.score : 0.0,
      converged: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Skill library
// ---------------------------------------------------------------------------

export class Skill {
  verified = false;
  usage_count = 0;
  success_rate = 0.0;

  constructor(
    public id: string,
    public name: string,
    public description: string,
    public body: string,
  ) {}
}

/** Stores skills indexed by content hash; production retrieves by embedding. */
export class SkillLibrary {
  skills = new Map<string, Skill>();

  /** Distill an execution trace into a reusable skill. */
  extract_skill(name: string, description: string, body: string): Skill {
    const sid = createHash("md5").update(body, "utf-8").digest("hex").slice(0, 12);
    return new Skill(sid, name, description, body);
  }

  verify_skill(skill: Skill, verifier: (skill: Skill) => boolean): boolean {
    const verified = verifier(skill);
    skill.verified = verified;
    return verified;
  }

  add_skill(skill: Skill): boolean {
    if (!skill.verified) {
      return false;
    }
    this.skills.set(skill.id, skill);
    return true;
  }

  /** Keyword scan over descriptions; production retrieves top-k by embedding. */
  retrieve(task: string, max_skills = 5): Skill[] {
    const terms = task
      .split(/\s+/)
      .filter((t) => t.length > 3)
      .map((t) => t.toLowerCase());
    const scored: Array<[number, Skill]> = [...this.skills.values()].map((s) => [
      terms.filter((t) => s.description.toLowerCase().includes(t)).length,
      s,
    ]);
    scored.sort((a, b) => b[0] - a[0]);
    return scored
      .slice(0, max_skills)
      .filter(([score]) => score > 0)
      .map(([, s]) => s);
  }

  update_lesson_effectiveness(skill_id: string, helped: boolean): void {
    const s = this.skills.get(skill_id);
    if (!s) {
      return;
    }
    s.usage_count += 1;
    const prior = s.success_rate * (s.usage_count - 1);
    s.success_rate = (prior + (helped ? 1.0 : 0.0)) / s.usage_count;
  }
}

// ---------------------------------------------------------------------------
// Experience replay
// ---------------------------------------------------------------------------

export class ExecutionTrace {
  steps: Array<Record<string, unknown>> = [];
  outcome: string = "success"; // success | failure
  error: string | null = null;

  constructor(public task: string, init: Partial<ExecutionTrace> = {}) {
    Object.assign(this, init);
  }
}

export class Lesson {
  constructor(
    public insight: string,
    public source_tasks: string[] = [],
    public effectiveness = 0.5,
  ) {}
}

/** Manages L0 traces, L1 reflections, L2 lessons. Adaptive trigger. */
export class ExperienceReplay {
  traces: ExecutionTrace[] = [];
  reflections: Array<Record<string, unknown>> = [];
  lessons: Lesson[] = [];
  private _last_extraction_at = 0;

  /** Stores trace; L1 on failure, L2 via adaptive spike detection. */
  record_trace(trace: ExecutionTrace): void {
    this.traces.push(trace);
    if (trace.outcome === "failure") {
      this.reflections.push({
        task: trace.task,
        reflection: this._reflect_on_failure(trace),
        error: trace.error,
      });
    }
    if (this._should_extract_lessons()) {
      this.lessons.push(...this._extract_cross_task_insights());
      this._last_extraction_at = this.traces.length;
    }
  }

  /** Rolling-window failure-rate spike detection (not a naive counter). */
  private _should_extract_lessons(): boolean {
    const BATCH = 10,
      WINDOW = 30,
      SPIKE = 1.5;
    const fresh = this.traces.length - this._last_extraction_at;
    if (fresh < BATCH || this.traces.length < 2 * WINDOW) {
      return false;
    }
    const recent = this.traces.slice(-WINDOW);
    const prior = this.traces.slice(-2 * WINDOW, -WINDOW);
    const rate_recent = recent.filter((t) => t.outcome === "failure").length / WINDOW;
    const rate_prior = prior.filter((t) => t.outcome === "failure").length / WINDOW;
    return rate_recent > rate_prior * SPIKE;
  }

  private _reflect_on_failure(_trace: ExecutionTrace): Record<string, string> {
    return { root_cause: "TBD", lesson: "TBD", prevention: "TBD" };
  }

  /** L2 insights extracted when the adaptive trigger fires. */
  private _extract_cross_task_insights(): Lesson[] {
    const recent = this.traces.slice(-20);
    const failures = recent.filter((t) => t.outcome === "failure");
    if (failures.length < 2) {
      return [];
    }
    // Placeholder: production would call the LLM to identify cross-task patterns.
    return [
      new Lesson(
        `recurring failure mode across ${failures.length} tasks`,
        failures.slice(0, 10).map((t) => t.task),
      ),
    ];
  }

  get_relevant_experience(_task: string, k = 3): Lesson[] {
    if (!this.lessons.length) {
      return [];
    }
    return [...this.lessons].sort((a, b) => b.effectiveness - a.effectiveness).slice(0, k);
  }
}

// ---------------------------------------------------------------------------
// The agent's reflection layer
// ---------------------------------------------------------------------------

/** Observable record of one reflection cycle. */
export class ReflectionTrace {
  iterations = 0;
  converged = false;
  final_score = 0.0;
  issue_history: unknown[] = [];
  notes: string[] = [];
}

/** The severities render_verdict emits, lower-cased. */
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

/**
 * Findings in a rendered verdict.
 *
 * Counted from the shapes verdicts are actually written in, not from the word
 * "severity": structured providers render `- **[high]** path — issue`, and over
 * 103 real runs only 2 verdicts contained that word while 22 used the marker.
 * Counting the word scored every review as findingless, which made the critic
 * approve everything at 1.0 — including reviews with no text at all.
 */
export function count_findings(review_text: string): number {
  // Whole list items only. Counting `**[` anywhere also counted prose that
  // merely mentions the format — and a clean review saying so would then be
  // scored as having findings, and rejected when tool evidence said "passes".
  let marker = 0;
  for (const line of review_text.split("\n")) {
    const rest = line.trimStart().toLowerCase();
    if (!rest.startsWith("- **[")) {
      continue;
    }
    const after = rest.slice("- **[".length);
    if (SEVERITIES.some((s) => after.startsWith(s + "]**"))) {
      marker += 1;
    }
  }
  // The prose spelling the Anthropic path produces. `severity:` rather than
  // the bare word, which also appears in the prompt’s own "severity-tagged".
  return marker || review_text.toLowerCase().split("severity:").length - 1;
}

/** Argus's self-improvement loop: critic loop + skills + experience. */
export class ArgusReflection {
  skills = new SkillLibrary();
  experience = new ExperienceReplay();
  last_trace: ReflectionTrace | null = null;

  /**
   * Cheap heuristic critic — production would call an LLM here. Compares
   * review claims against deterministic tool evidence and suspects findings
   * that cannot be reproduced.
   */
  critique_review(review_text: string, tool_evidence = ""): Critique {
    // Silence is not quality. The score below is the fraction of findings that
    // survive scrutiny, and with no findings there is nothing to disbelieve — so
    // an empty verdict scored a perfect 1.0 and was approved. A review with no
    // text is the one thing the critic must never bless.
    if (!review_text.trim()) {
      return new Critique(0.0, false, "The review is empty — no verdict was produced.");
    }
    const findings = count_findings(review_text);
    const false_positive_signal =
      tool_evidence.toLowerCase().includes("passes") &&
      !tool_evidence.toLowerCase().includes("fails") &&
      findings > 0;
    const likely_fp = false_positive_signal ? Math.floor(findings / 2) : 0;
    const score = Math.max(0.0, 1.0 - likely_fp / Math.max(findings, 1));
    return new Critique(
      score,
      score >= 0.8,
      likely_fp
        ? `Suspect ${likely_fp}/${findings} findings as false positives based on tool evidence.`
        : "Findings consistent with evidence.",
    );
  }

  /** Run generator-critic over a draft review until converged. */
  async refine(
    review_text: string,
    regenerate: (task: string, ctx: string) => Promise<string> | string,
    tool_check: ((output: string) => Promise<string> | string) | null = null,
  ): Promise<RefineResult> {
    const loop = new GeneratorCriticLoop(
      async (task, ctx) => (ctx ? regenerate(task, ctx) : review_text),
      (_task, output, tool_fb) => this.critique_review(output, tool_fb),
      3,
      0.8,
    );
    const result = await loop.refine("argus_review", tool_check);
    const trace = new ReflectionTrace();
    trace.iterations = result.iterations;
    trace.converged = result.converged;
    trace.final_score = result.final_score;
    trace.issue_history = loop.history.map((h) => h.score);
    this.last_trace = trace;
    return result;
  }

  /** Feed an execution into experience replay for future L2 lessons. */
  record_outcome(task: string, succeeded: boolean, error: string | null = null): void {
    this.experience.record_trace(
      new ExecutionTrace(task, { outcome: succeeded ? "success" : "failure", error }),
    );
  }

  extract_skill(
    name: string,
    description: string,
    body: string,
    verifier: (skill: Skill) => boolean,
  ): Skill | null {
    const skill = this.skills.extract_skill(name, description, body);
    if (this.skills.verify_skill(skill, verifier)) {
      this.skills.add_skill(skill);
      return skill;
    }
    return null;
  }
}
