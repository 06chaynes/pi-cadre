/**
 * Model routing for the "cadre" virtual model. LFM3 answers questions and makes single-spot edits; Spark does
 * everything else. In Pi sessions LFM3 matched Spark on reading, small edits, and a contained bug fix, but lost track
 * of the working directory and damaged files on a multi-step feature, so anything multi-step goes to Spark.
 */

const MAX_LFM3_PROMPT = 300;
const QUESTION_START = /^\s*(what|where|which|who|when|why|how|does|do|is|are|can|could|explain|describe|show|list|find|summari[sz]e)\b/i;
const CHANGE = /\b(add|implement|create|build|write|refactor|rewrite|migrate|fix|change|update|remove|delete|plan|design|review|diagnose|debug|investigate|tests?)\b/i;
const SMALL_EDIT = /\b(docstring|comment|typo|rename|spelling|reword)\b/i;
const MULTI_STEP = /\b(tests?|then|every|all|each|across|refactor|implement)\b/i;

export type ModelChoice = "spark" | "lfm3";

/** Picks the model for a user prompt. */
export function chooseModel(prompt: string): ModelChoice {
  const text = prompt.trim();
  if (text.length > MAX_LFM3_PROMPT) return "spark";
  if (SMALL_EDIT.test(text) && !MULTI_STEP.test(text)) return "lfm3";
  const question = QUESTION_START.test(text) || text.endsWith("?");
  return question && !CHANGE.test(text) ? "lfm3" : "spark";
}

/** Text of the last user message, with text blocks joined by newlines. */
export function promptText(messages: readonly any[]): string {
  const last = [...messages].reverse().find((m) => m?.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("\n");
}

interface RouteModels<M> {
  spark: M;
  /** Undefined when LFM3 is offline or its slots are too small for Pi. */
  lfm3?: M;
}

/**
 * Physical model and thinking level for one request. A turn stays on the model that started it, a failed LFM3
 * request retries on Spark, and requests outside the agent loop (compaction summaries) go to Spark.
 */
export function routeRequest<M extends { id: string }>(request: any, models: RouteModels<M>) {
  const { spark, lfm3 } = models;
  const isLfm3 = (model?: { id: string }) => lfm3 !== undefined && model?.id === lfm3.id;
  switch (request.reason) {
    case "retry": {
      const failed = request.failed;
      return { model: spark, thinkingLevel: failed?.thinkingLevel ?? request.thinkingLevel };
    }
    case "continuation": {
      const previous = request.previous;
      return {
        model: isLfm3(previous?.model) ? (lfm3 as M) : spark,
        thinkingLevel: previous?.thinkingLevel ?? request.thinkingLevel,
      };
    }
    case "direct":
      return { model: spark, thinkingLevel: request.thinkingLevel };
    default: {
      const useLfm3 = lfm3 !== undefined && chooseModel(promptText(request.messages)) === "lfm3";
      return { model: useLfm3 ? lfm3 : spark, thinkingLevel: request.thinkingLevel };
    }
  }
}
