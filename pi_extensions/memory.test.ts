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

test("passages join a short run such as a heading to the text after it", () => {
  const page = "# How long can whales hold their breath?\n\nA sperm whale can spend around 90 minutes hunting underwater.\n\nOther text about oceans and tides that is long enough to stand on its own as a passage here.";
  const parts = passages({ source: "s", text: page }, 500);
  assert.match(parts[0].text, /^# How long can whales hold their breath\?\nA sperm whale can spend around 90 minutes/);
});

test("lines the extension added to a result are not stored", () => {
  const text = [
    "The largest known prime has 41,024,320 digits.",
    "[Result shortened from 90000 to fit the context window. Lines 1-40 are above; below are the other lines that contain words from the request (prime, whale, everest, tokyo).]",
    "[Lines outside the part shown above that contain words from the request (prime, whale):]",
    "[This result can leave context after your next step. Record with the note tool any fact from it you will need later.]",
  ].join("\n");
  const stored = passages({ source: "s", text }, 1000).map((p) => p.text).join("\n");
  assert.equal(stored, "The largest known prime has 41,024,320 digits.");
});

test("recall needs a passage to share at least 40% of a query's terms, and returns where each passage came from", () => {
  const stored = [
    { source: "a", text: "The largest known prime number has 41,024,320 decimal digits and was found in 2024." },
    { source: "b", text: "A prime is a number with exactly two divisors, used throughout number theory and cryptography." },
  ];
  // Nine terms: a passage needs four. Stored item 0 shares seven; item 1 shares two.
  const found = recall(stored, ["The year the largest known prime number was found, and how many decimal digits it has."], 2000);
  assert.deepEqual(found.map((p) => p.from), [0]);
  assert.deepEqual(recall([stored[1]], ["The year the largest known prime number was found, and how many decimal digits it has."], 2000), []);
});
