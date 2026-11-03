import assert from "node:assert/strict";
import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadOriginal, pruneOriginals, saveOriginal } from "./originals.ts";

const root = () => join(mkdtempSync(join(tmpdir(), "cadre-orig-")), "results");

test("an original is saved privately per session and loaded back by tool call id", () => {
  const dir = root();
  saveOriginal(dir, "session/1", "call:7", "the full 2.3 MB result");
  assert.equal(loadOriginal(dir, "session/1", "call:7"), "the full 2.3 MB result");
  assert.equal(loadOriginal(dir, "session/1", "other"), undefined);
  assert.equal(loadOriginal(dir, "session/2", "call:7"), undefined);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("originals above the size cap are not saved", () => {
  const dir = root();
  saveOriginal(dir, "s", "c", "x".repeat(10 * 1024 * 1024 + 1));
  assert.equal(loadOriginal(dir, "s", "c"), undefined);
});

test("sessions untouched for over a week are pruned", () => {
  const dir = root();
  saveOriginal(dir, "old", "c", "a");
  saveOriginal(dir, "new", "c", "b");
  const week = 8 * 24 * 3600;
  const then = Date.now() / 1000 - week;
  utimesSync(join(dir, "old"), then, then);
  pruneOriginals(dir, Date.now());
  assert.equal(loadOriginal(dir, "old", "c"), undefined);
  assert.equal(loadOriginal(dir, "new", "c"), "b");
});
