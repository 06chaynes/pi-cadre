import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { syntaxError } from "./syntax.ts";

const file = (name: string, text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "cadre-syntax-")), name);
  writeFileSync(path, text);
  return path;
};

test("a Python file with an unterminated docstring reports the parser's error", async () => {
  // The real slip: Spark closed a docstring with two quotes instead of three.
  const broken = file("store.py", 'class A:\n    def release(self):\n        """Releases units.""\n        return 1\n');
  assert.match((await syntaxError(broken)) ?? "", /unterminated|EOF|SyntaxError/i);
  assert.equal(await syntaxError(file("ok.py", "def f():\n    return 1\n")), undefined);
});

test("TypeScript, JavaScript, and Rust syntax errors are reported; valid files pass", async () => {
  assert.match((await syntaxError(file("a.ts", "export function f(: number { return 1 }\n"))) ?? "", /\S/);
  assert.equal(await syntaxError(file("b.ts", "export function f(x: number): number { return x }\n")), undefined);
  assert.match((await syntaxError(file("c.js", "function f( { return 1 }\n"))) ?? "", /\S/);
  assert.match((await syntaxError(file("d.rs", "fn main( { }\n"))) ?? "", /\S/);
  assert.equal(await syntaxError(file("e.rs", "fn main() {}\n")), undefined);
});

test("files with no checker are not checked", async () => {
  assert.equal(await syntaxError(file("notes.md", "# not code {")), undefined);
});
