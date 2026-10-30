import assert from "node:assert/strict";
import { test } from "node:test";

import { bm25, keywords } from "./text.ts";

const QUESTION = "What year was the largest known prime found, according to notes.txt? Read the file and answer in one sentence.";

test("keywords keeps the distinctive words of a request", () => {
  assert.deepEqual(keywords(QUESTION), ["year", "largest", "known", "prime", "found", "notes", "txt"]);
});

test("keywords keep two-character acronyms written in capitals, not short lowercase words", () => {
  assert.deepEqual(keywords("What are the latest research results in the field of ML?"), ["latest", "research", "results", "field", "ml"]);
  assert.deepEqual(keywords("Is AI or 3D printing in it?"), ["ai", "3d", "printing"]);
});

test("bm25 ranks the passage that answers above one that only shares a common word", () => {
  const index = bm25([
    "Research results are published in many journals every year.",
    "The largest known prime number has 41,024,320 digits; it was found in 2024.",
  ]);
  const [general, answer] = index.score("year the largest known prime number was found, and its digits");
  assert.ok(answer.score > general.score);
  assert.equal(answer.matched, 6);
  assert.deepEqual(index.queryTerms("Prime numbers and primes"), ["prime", "number"]);
});
