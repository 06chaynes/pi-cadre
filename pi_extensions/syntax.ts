/**
 * Parses a file the model just edited or wrote and returns the parser's error, so a broken edit is reported in the
 * same step. In testing, Spark closed a Python docstring with two quotes instead of three, re-read the file, and
 * reported success; the tests could no longer import it. Checkers are standard parsers chosen by extension, used only
 * when installed; nothing is formatted or written.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { extname } from "node:path";

const TIMEOUT_MS = 5000;
const MAX_ERROR_CHARS = 400;

// Parser command per extension; the file path is appended. Each exits non-zero only when the file does not parse.
const CHECKERS: Record<string, string[]> = {
  ".py": [
    "python3",
    "-c",
    "import ast, sys\ntry: ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])\nexcept SyntaxError as e: sys.exit(f'SyntaxError: {e.msg} (line {e.lineno})')",
  ],
  ".js": ["node", "--check"],
  ".mjs": ["node", "--check"],
  ".cjs": ["node", "--check"],
  ".rs": ["rustfmt", "--edition", "2021", "--emit", "stdout"],
  ".go": ["gofmt", "-e"],
};

// TypeScript is parsed in-process by Node's own type stripper, which rejects invalid syntax.
const TYPESCRIPT = new Set([".ts", ".mts", ".cts"]);

/** The parser's error for the file at `path`, or undefined when it parses, has no checker, or the checker is missing. */
export function syntaxError(path: string): Promise<string | undefined> {
  const ext = extname(path).toLowerCase();
  if (TYPESCRIPT.has(ext)) {
    try {
      stripTypeScriptTypes(readFileSync(path, "utf8"));
      return Promise.resolve(undefined);
    } catch (e) {
      return Promise.resolve(e instanceof Error ? e.message.split("\n")[0].slice(0, MAX_ERROR_CHARS) : String(e));
    }
  }
  const checker = CHECKERS[ext];
  if (!checker) return Promise.resolve(undefined);
  const [command, ...args] = checker;
  return new Promise((resolve) => {
    execFile(command, [...args, path], { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ENOENT" || error.killed) return resolve(undefined);
      const lines = stderr.split("\n").filter((line) => line.trim() && !line.includes("node:internal"));
      resolve(lines.join("\n").slice(0, MAX_ERROR_CHARS) || `${command} could not parse the file`);
    });
  });
}
