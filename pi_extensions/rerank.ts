/**
 * Relevance of passages to a question from a reranker model on llama-server (/v1/rerank, started with --reranking).
 * Cadre uses it to decide which passages of a cleared result stay: measured on the scored sessions, keeping passages
 * in reranker order kept the answer in 238 of 254 answer-bearing results at the clearing budget, against 153 for line
 * matching, because the reranker reads the question and the passage together instead of counting shared words.
 */

import { bm25 } from "./text.ts";
import { taskQueries } from "./memory.ts";

// Documents per request; llama-server scores each one as its own sequence.
const BATCH = 64;
// A reranker that is busy or gone must not hold up clearing: the caller falls back to line matching.
const RERANK_TIMEOUT_MS = 20_000;

/** One relevance score per document, in document order; undefined when the reranker is unreachable or late. */
export async function rerankScores(url: string, query: string, docs: readonly string[], timeoutMs = RERANK_TIMEOUT_MS): Promise<number[] | undefined> {
  const scores: number[] = new Array(docs.length).fill(-Infinity);
  try {
    for (let start = 0; start < docs.length; start += BATCH) {
      const batch = docs.slice(start, start + BATCH);
      const res = await fetch(`${url}/v1/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, documents: batch, top_n: batch.length }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const body: any = await res.json();
      for (const r of body.results ?? []) if (typeof r.index === "number") scores[start + r.index] = r.relevance_score;
    }
  } catch {
    return undefined;
  }
  return scores;
}

/** The highest-scoring passages that fit in `maxChars` together (one newline between each), in their original order. */
export function keepBest(passages: readonly string[], scores: readonly number[], maxChars: number): string[] {
  const chosen = new Set<number>();
  let used = 0;
  for (const i of passages.map((_, i) => i).sort((a, b) => scores[b] - scores[a])) {
    if (used + passages[i].length + 1 > maxChars + 1) continue;
    chosen.add(i);
    used += passages[i].length + 1;
  }
  return passages.filter((_, i) => chosen.has(i));
}

/**
 * The request item a tool call serves: the listed item (see taskQueries) that shares the most with the call, or the
 * whole request when it lists fewer than two items or no item shares a word with the call.
 */
export function itemFor(call: string, request: string): string {
  const items = taskQueries(request);
  if (items.length < 2) return request.trim();
  const scores = bm25(items).score(call);
  let best = -1;
  scores.forEach(({ score }, i) => {
    if (score > 0 && (best < 0 || score > scores[best].score)) best = i;
  });
  return best < 0 ? request.trim() : items[best];
}
