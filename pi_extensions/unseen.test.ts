import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { keywords, readLinesCapped, shortenText, unseenNote } from "./unseen.ts";

const QUESTION = "What year was the largest known prime found, according to notes.txt? Read the file and answer in one sentence.";

/** 1,401 log lines with the answer on line 901, as in the session where Spark missed it. */
function notesFile() {
  const dir = mkdtempSync(join(tmpdir(), "cadre-unseen-"));
  const lines = Array.from({ length: 1400 }, (_, i) => `Record ${i}: the Mersenne prime search logged candidate ${i * 7919} with no new result.`);
  lines.splice(900, 0, "Record 900: the largest known prime, 2^136279841 - 1, was found on October 12, 2024 by Luke Durant.");
  writeFileSync(join(dir, "notes.txt"), lines.join("\n"));
  return dir;
}

const truncated = (outputLines: number, totalLines = 1401) => ({ truncation: { truncated: true, outputLines, totalLines } });

test("keywords keeps the distinctive words of a request", () => {
  assert.deepEqual(keywords(QUESTION), ["year", "largest", "known", "prime", "found", "notes", "txt"]);
});

test("a truncated read gets the unseen lines that match the request", () => {
  const cwd = notesFile();
  const note = unseenNote("read", { path: "notes.txt" }, truncated(619), cwd, QUESTION);
  assert.ok(note);
  assert.match(note, /^901: Record 900: the largest known prime/m);
  assert.doesNotMatch(note, /^\d+: Record 5:/m);
});

test("lines inside the shown range are not repeated", () => {
  const cwd = notesFile();
  assert.equal(unseenNote("read", { path: "notes.txt", offset: 850 }, truncated(100), cwd, QUESTION), undefined);
});

test("complete reads, unrelated tools, and requests without keywords get nothing", () => {
  const cwd = notesFile();
  assert.equal(unseenNote("read", { path: "notes.txt" }, {}, cwd, QUESTION), undefined);
  assert.equal(unseenNote("write", { path: "notes.txt" }, truncated(619), cwd, QUESTION), undefined);
  assert.equal(unseenNote("read", { path: "notes.txt" }, truncated(619), cwd, "ok?"), undefined);
});

test("truncated bash output is searched in its saved full output, outside the shown tail", () => {
  const cwd = notesFile();
  const details = { ...truncated(200), fullOutputPath: join(cwd, "notes.txt") };
  const note = unseenNote("bash", { command: "cat notes.txt" }, details, cwd, QUESTION);
  assert.match(note ?? "", /^901: Record 900: the largest known prime/m);
});

test("a keyword matches at the start of a word, not inside one", () => {
  const cwd = notesFile();
  // Every log line has "prime" at a word start and "date" only inside "candidate", so none reaches two matches.
  assert.equal(unseenNote("read", { path: "notes.txt" }, truncated(10), cwd, "date prime?"), undefined);
  assert.ok(unseenNote("read", { path: "notes.txt" }, truncated(10), cwd, "candidate prime?"));
});

test("matches are capped in number and length", () => {
  const cwd = notesFile();
  const note = unseenNote("read", { path: "notes.txt" }, truncated(10), cwd, "Which prime search record logged a candidate?") ?? "";
  const lines = note.split("\n").filter((l) => /^\d+: /.test(l));
  assert.equal(lines.length, 20);
});

test("readLinesCapped refuses files above the size cap", () => {
  const cwd = notesFile();
  assert.equal(readLinesCapped(join(cwd, "notes.txt"), 1000), undefined);
  assert.equal(readLinesCapped(join(cwd, "notes.txt"), 10_000_000)?.length, 1401);
  assert.equal(readLinesCapped(join(cwd, "missing.txt"), 10_000_000), undefined);
});

/** A search result shaped like the Wikipedia table that overflowed Spark: about 150,000 characters of rows. */
function searchResult() {
  const rows = Array.from({ length: 1800 }, (_, i) => `| ${i + 1} | 2^${(i * 104729) % 9999991} - 1 | ${2_000_000 + i} digits | Mersenne candidate row |`);
  rows.splice(1200, 0, "The largest known prime, 2^136279841 - 1, was found in October 2024 by Luke Durant (GIMPS).");
  return ["List of largest known primes", "", ...rows].join("\n");
}

test("shortenText keeps the start and the lines that match the request, within the limit", () => {
  const text = searchResult();
  const short = shortenText(text, "What year was the largest prime number found (so far)?", 30_000);
  assert.ok(short.length <= 30_000, String(short.length));
  assert.ok(short.startsWith("List of largest known primes"));
  assert.match(short, /\d+: The largest known prime, 2\^136279841 - 1, was found in October 2024/);
  assert.match(short, /shortened from \d+ to fit/);
});

test("shortenText leaves text within the limit unchanged and cuts one long line by characters", () => {
  assert.equal(shortenText("short", "anything", 100), "short");
  const long = shortenText("x".repeat(10_000), "anything", 1_000);
  assert.ok(long.length <= 1_000 && long.startsWith("xxx"));
});
