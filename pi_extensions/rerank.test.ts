import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { itemFor, keepBest, rerankScores } from "./rerank.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fake /v1/rerank that scores each document by `score` and records the requests. */
function fakeReranker(score: (doc: string) => number) {
  const requests: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const results = body.documents.map((doc: string, index: number) => ({ index, relevance_score: score(doc) }));
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as typeof fetch;
  return requests;
}

test("rerankScores returns one score per document, in document order, asking in batches", async () => {
  const docs = Array.from({ length: 70 }, (_, i) => `passage ${i}`);
  const requests = fakeReranker((doc) => Number(doc.split(" ")[1]));
  const scores = await rerankScores("http://127.0.0.1:8082", "question", docs);
  assert.deepEqual(scores, docs.map((_, i) => i));
  assert.equal(requests.length, 2, "64 documents per request");
  assert.equal(requests[0].query, "question");
});

test("rerankScores gives undefined when the reranker is unreachable or answers late", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  assert.equal(await rerankScores("http://127.0.0.1:8082", "q", ["a"]), undefined);
  globalThis.fetch = ((_url: string, init: any) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  assert.equal(await rerankScores("http://127.0.0.1:8082", "q", ["a"], 50), undefined);
});

test("keepBest keeps the highest-scoring passages that fit, in their original order", () => {
  const passages = ["aaaa", "bbbb", "cccc", "dddd"];
  assert.deepEqual(keepBest(passages, [0.1, 0.9, 0.2, 0.8], 10), ["bbbb", "dddd"]);
  assert.deepEqual(keepBest(passages, [0.1, 0.9, 0.2, 0.8], 3), [], "nothing fits");
});

test("itemFor picks the listed request item that a call serves, or the whole request when it lists none", () => {
  const request = "Research each of these:\n1. The year the first iPhone was released.\n2. The melting point of tungsten in degrees Celsius.";
  assert.equal(itemFor('{"queries":["melting point tungsten Celsius"]}', request), "The melting point of tungsten in degrees Celsius.");
  assert.equal(itemFor('{"queries":["first iPhone release year"]}', request), "The year the first iPhone was released.");
  assert.equal(itemFor('{"query":"anything"}', "How long can a sperm whale hold its breath?"), "How long can a sperm whale hold its breath?");
});
