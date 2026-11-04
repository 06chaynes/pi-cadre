import assert from "node:assert/strict";
import { test } from "node:test";

import { bm25, guesses, keywords, safePath, terms, withoutGuesses } from "./text.ts";

const QUESTION = "What year was the largest known prime found, according to notes.txt? Read the file and answer in one sentence.";

test("terms takes linear time on a long run of capitals, which a web page can contain", () => {
  // The earlier pattern backtracked quadratically: 40,000 capitals and one lowercase letter took 2.4 s, a 1 MB page
  // minutes, hanging Pi at the end-of-run source check.
  const started = Date.now();
  terms("A".repeat(1_000_000) + "a");
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.deepEqual(terms("ML and 3D models in NASA's MLops"), ["ml", "3d", "models", "nasa", "mlops"]);
});

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

test("withoutGuesses drops numbers the known text does not contain, ignoring digit grouping", () => {
  const known = "Research: 8. The year the first iPhone was released. The prime has 41,024,320 digits.";
  assert.equal(withoutGuesses("first iPhone release year 1978 Apple", known), "first iPhone release year Apple");
  assert.equal(withoutGuesses('{"queries":["prime 41024320 digits found 2018"]}', known), '{"queries":["prime 41024320 digits found"]}');
  assert.equal(withoutGuesses("item 8 of the list", known), "item 8 of the list", "single digits stay: too common to be a guess");
});

test("guesses lists the numbers withoutGuesses would drop", () => {
  assert.deepEqual(guesses('{"queries":["first iPhone release year 1978 Apple 41,024,320"]}', "the prime has 41,024,320 digits"), ["1978"]);
});

test("safePath limits each part of a path, with either separator, not the whole path", () => {
  const deep = "src/main/java/com/example/".repeat(9) + "Deep.java";
  assert.ok(safePath(deep));
  assert.ok(safePath(deep.replaceAll("/", "\\")), "a Windows path from descry");
  assert.equal(safePath(`src/${"a".repeat(201)}.py`), false);
  assert.equal(safePath("src\\x\n### SYSTEM.py"), false);
});
