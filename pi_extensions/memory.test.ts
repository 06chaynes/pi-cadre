import assert from "node:assert/strict";
import { test } from "node:test";

import { passages, recall, taskQueries } from "./memory.ts";

const primePage = [
  "1. Largest known prime number - Wikipedia",
  "   URL: https://en.wikipedia.org/wiki/Largest_known_prime_number",
  "The largest known prime number is 2^136,279,841 - 1, a number which has 41,024,320 digits.",
  "It was found in October 2024 by the Great Internet Mersenne Prime Search (GIMPS).",
  "",
  "2. Mersenne prime - Wikipedia",
  "Mersenne primes are primes of the form 2^n - 1.",
].join("\n");
const whalePage = [
  "1. How long can whales hold their breath? | Natural History Museum",
  "A sperm whale can spend around 90 minutes hunting underwater before it has to come back to the surface.",
  "",
  "Whales are marine mammals found in every ocean.",
].join("\n");

test("passages split at blank lines and stay within the size limit, keeping their source", () => {
  const parts = passages({ source: 'web_search {"query":"largest prime"}', text: primePage }, 200);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.text.length <= 200));
  assert.ok(parts.every((p) => p.source === 'web_search {"query":"largest prime"}'));
  assert.match(parts.map((p) => p.text).join("\n"), /41,024,320 digits/);
});

test("taskQueries makes one query per listed item, or one for the whole task", () => {
  const listed = "Research each of these:\n1. The year the largest known prime was found.\n2. How long a sperm whale holds its breath.";
  assert.deepEqual(taskQueries(listed, ""), ["The year the largest known prime was found.", "How long a sperm whale holds its breath."]);
  assert.deepEqual(taskQueries("What year was the largest prime found?", "web_search largest prime"), ["What year was the largest prime found? web_search largest prime"]);
});

test("recall brings back the best passage for each query, within the budget", () => {
  const stored = [
    { source: 'web_search {"query":"largest prime"}', text: primePage },
    { source: 'web_search {"query":"sperm whale"}', text: whalePage },
  ];
  const found = recall(stored, ["The year the largest known prime number was found, and how many digits it has.", "How long a sperm whale typically holds its breath."], 1200);
  const text = found.map((p) => p.text).join("\n");
  assert.match(text, /41,024,320 digits/);
  assert.match(text, /90 minutes hunting underwater/);
  assert.ok(text.length <= 1200);
});

test("recall leaves out passages that match fewer than two query terms", () => {
  const stored = [{ source: "web_search", text: "Whales are marine mammals found in every ocean." }];
  assert.deepEqual(recall(stored, ["How long a sperm whale typically holds its breath."], 1000), []);
});
