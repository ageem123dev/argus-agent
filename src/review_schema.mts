/**
 * The review contract, independent of who answers it.
 *
 * A structured-output provider asks one question — "review this change" — and
 * gets back one object. The prompt, the schema, the size-routing and the
 * interpretation of the answer are all properties of *that contract*, not of
 * any particular backend, so they live here rather than inside a provider.
 *
 * They were written inside the agy provider originally. Moving them out is what
 * lets a second provider exist at all: an HTTP call and a CLI invocation differ
 * in how the bytes are fetched and in nothing else.
 *
 * The rendered shape matters beyond this file. `parse_findings` reads the
 * `- **[severity]** location — issue` lines back out of the verdict, and
 * ingestion scores Argus against CodeRabbit on what that parse returns. Change
 * the rendering here and findings stop being counted there.
 */
import { Complexity, ReviewResult } from "./reasoning.mjs";

const TIERS = new Set<string>(Object.values(Complexity));

/** The object a provider is asked to return. */
export interface StructuredReview {
  complexity: string;
  confidence: number;
  steps: Array<{ content: string; confidence: number }>;
  findings: Array<{
    severity: string;
    location: string;
    issue: string;
    suggestion?: string;
  }>;
  final_answer: string;
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    complexity: {
      type: "string",
      enum: ["simple", "moderate", "complex"],
      description: "Complexity of the review task itself.",
    },
    confidence: {
      type: "number",
      description: "Overall confidence in the review, 0.0 to 1.0.",
    },
    steps: {
      type: "array",
      description:
        "One element per discrete reasoning step. Do NOT narrate steps inside " +
        "final_answer — decompose them here, one object per step.",
      items: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "What this step established.",
          },
          confidence: {
            type: "number",
            description: "Confidence in this step, 0.0 to 1.0.",
          },
        },
        required: ["content", "confidence"],
      },
    },
    findings: {
      type: "array",
      description: "Concrete issues found. Empty array if the change is clean.",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
          },
          location: {
            type: "string",
            description:
              "Repository-relative path exactly as it appears in a '### <path>' heading " +
              "or diff header, optionally ':<line>' counted within that file's own section. " +
              "Never a temp path, absolute path, or file:// URL.",
          },
          issue: {
            type: "string",
            description: "One sentence: what is wrong.",
          },
          suggestion: {
            type: "string",
            description: "One sentence: how to fix it.",
          },
        },
        required: ["severity", "location", "issue"],
      },
    },
    final_answer: {
      type: "string",
      description: "Prose summary of the review. No step-by-step narration here.",
    },
  },
  required: ["complexity", "confidence", "steps", "findings", "final_answer"],
};

export const REVIEW_PROMPT =
  "You are a rigorous code reviewer. Review the change below for correctness bugs, " +
  "security vulnerabilities, and maintainability problems.\n\n" +
  "Reason step by step, and record each discrete step as its own element of the " +
  "`steps` array with an honest per-step confidence. Report every concrete problem " +
  "in `findings`, severity-tagged. Reserve `final_answer` for a prose summary.\n\n" +
  "Report only issues you can point at in the change or its provided context. " +
  "Do not speculate about code you were not shown.\n\n" +
  "Context files appear below under '### <repo-relative-path>' headings. Cite locations " +
  "using those repo-relative paths only — never the path of the file you are reading this " +
  "from, never an absolute or temp path, and never a file:// URL. Line numbers, if given, " +
  "must be counted within that file's own section.\n\n";

/**
 * Route on the size of the change rather than asking a model how hard it is.
 *
 * A classifier round-trip costs a full call to answer a question the line count
 * answers well enough, and the provider corrects the tier in its own output.
 */
export function tier_for_size(diff: string): Complexity {
  const lines = (diff.match(/\n/g) ?? []).length;
  return lines < 30
    ? Complexity.SIMPLE
    : lines < 100
      ? Complexity.MODERATE
      : Complexity.COMPLEX;
}

/** Render the structured result into the verdict text the CLI and critic loop read. */
export function render_verdict(r: StructuredReview): string {
  const parts = [r.final_answer.trim()];
  if (r.findings?.length) {
    parts.push(
      "\n## Findings\n" +
        r.findings
          .map(
            (f) =>
              `- **[${f.severity}]** ${f.location} — ${f.issue}` +
              (f.suggestion ? `\n  ↳ ${f.suggestion}` : ""),
          )
          .join("\n"),
    );
  }
  return parts.join("\n");
}

/**
 * A provider answered successfully and said nothing.
 *
 * Deliberately not swallowed. A provider can report success having produced
 * neither structured output nor prose, and returning that as a review is worse
 * than failing: an empty verdict is indistinguishable from a clean diff, gets
 * recorded as a real run, and then scores as a total miss against any second
 * reviewer.
 */
export class EmptyReviewError extends Error {
  constructor(
    message: string,
    /** Attempts made before giving up, filled in by whatever retries. */
    public attempts = 1,
  ) {
    super(message);
    this.name = "EmptyReviewError";
  }
}

/**
 * Turn a provider's answer into a review, or say precisely why it is not one.
 *
 * `prose` is the unstructured response a provider may return alongside — or
 * instead of — the structured object. It is a usable review when schema
 * enforcement failed, but not when it is empty.
 *
 * `context` names what to inspect when this throws: a conversation id, a
 * request id, whatever the provider can offer.
 */
export function interpret_review(
  structured: StructuredReview | undefined,
  prose: string | undefined,
  tier: Complexity,
  context: string,
): ReviewResult {
  if (!structured || typeof structured.final_answer !== "string") {
    if (!prose?.trim()) {
      throw new EmptyReviewError(
        `reported success but returned neither structured output nor prose (${context}).`,
      );
    }
    return new ReviewResult(prose, [], 0.6, tier, tier);
  }

  const verdict = render_verdict(structured);
  if (!verdict.trim()) {
    throw new EmptyReviewError(
      `returned structured output with an empty final_answer and no findings (${context}).`,
    );
  }

  const steps = Array.isArray(structured.steps) ? structured.steps : [];
  const reported =
    typeof structured.complexity === "string" ? structured.complexity.toLowerCase() : "";
  return new ReviewResult(
    verdict,
    steps,
    typeof structured.confidence === "number" ? structured.confidence : 0.8,
    // The model's own assessment, which may disagree with what we routed on.
    TIERS.has(reported) ? reported : tier,
    tier,
  );
}
