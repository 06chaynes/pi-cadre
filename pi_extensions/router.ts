/**
 * Model routing for the "cadre" virtual model. LFM3 answers questions about local code and takes the first step of a
 * single-spot edit, which Spark finishes; Spark does everything else, including questions that may need web research. In Pi sessions LFM3 matched Spark on reading, small edits, and a contained bug fix, but lost track
 * of the working directory and damaged files on a multi-step feature, so anything multi-step goes to Spark.
 */

const MAX_LFM3_PROMPT = 300;
const QUESTION_START = /^\s*(what|where|which|who|when|why|how|does|do|is|are|can|could|explain|describe|show|list|find|summari[sz]e)\b/i;
const CHANGE = /\b(add|implement|create|build|write|refactor|rewrite|migrate|fix|change|update|remove|delete|plan|design|review|diagnose|debug|investigate|tests?)\b/i;
const SMALL_EDIT = /\b(docstring|comment|typo|rename|spelling|reword)\b/i;
const MULTI_STEP = /\b(tests?|then|every|all|each|across|refactor|implement)\b/i;
// A file name in any language (a name of two or more characters and an extension, not a web domain), a backticked or
// snake_case or camelCase identifier, or "this/the repo|code|function|...".
const WEB_DOMAINS = "com|org|net|edu|gov|io|co|uk|de|jp|fr|info|dev|ai|app";
const LOCAL_REFERENCE = new RegExp(
  [
    `\\b[\\w-]{2,}(\\.[\\w-]+)*\\.(?!(?:${WEB_DOMAINS})\\b)[a-z][a-z0-9]{0,5}\\b(?![./]\\w)`,
    "`[^`]+`",
    "\\b[a-z0-9]+_[a-z0-9_]+\\b",
    "\\b[a-z]+[A-Z]\\w*\\b",
    "\\b(this|the) (repo|repository|project|code|codebase|file|function|method|class|module|test)\\b",
  ].join("|"),
);

export type ModelChoice = "spark" | "lfm3";

/** Picks the model for a user prompt. */
export function chooseModel(prompt: string): ModelChoice {
  const text = prompt.trim();
  if (text.length > MAX_LFM3_PROMPT) return "spark";
  if (SMALL_EDIT.test(text) && !MULTI_STEP.test(text)) return "lfm3";
  // Questions without a local reference may need research; LFM3 wrote poor search queries for those.
  const question = QUESTION_START.test(text) || text.endsWith("?");
  return question && !CHANGE.test(text) && LOCAL_REFERENCE.test(text) ? "lfm3" : "spark";
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
  /** Undefined when LFM3 is offline, its slots are too small for Pi, or this request's conversation does not fit. */
  lfm3?: M;
}

/**
 * Physical model and thinking level for one request. A question stays on the model that started it unless LFM3 is not
 * passed (the caller leaves it out when the conversation outgrows it); a change continues on Spark; a failed request
 * retries on Spark; and requests outside the agent loop (compaction summaries) go to Spark.
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
      // A change continues on Spark: LFM3 is quick to read and locate, but placed edits wrong where Spark did not.
      const text = promptText(request.messages);
      const change = SMALL_EDIT.test(text) || CHANGE.test(text);
      return {
        model: isLfm3(previous?.model) && !change ? (lfm3 as M) : spark,
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
