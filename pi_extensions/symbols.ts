/**
 * Where the names a request mentions are defined, found by code and stated in the system message. In testing, LFM3
 * asked to document `release` put the comment on the class every time (10/10); told "the `release` method", it was
 * right every time. Resolving the name in code removes the guess for any model.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { projectFiles } from "./projectmap.ts";

const CODE = new Set([".py", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".java", ".kt", ".scala", ".rb", ".php", ".cs", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".lua", ".dart", ".sh"]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PER_NAME = 3;
const LINE_CHARS = 120;
const HEADING = "Names in the request, where they are defined:";

/** Identifiers written in backticks in the request, dotted ones split into parts; commands and phrases are skipped. */
export function requestNames(prompt: string): string[] {
  const names: string[] = [];
  for (const [, inner] of prompt.matchAll(/`([^`\s]+)`/g)) {
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(inner)) continue;
    for (const part of inner.split(".")) if (!names.includes(part)) names.push(part);
  }
  return names;
}

/** A definition of `name` on one line: a keyword form (def, fn, class, ...), a method declaration, or a binding. */
function definition(name: string): RegExp {
  const n = name.replace(/\$/g, "\\$");
  const keyword = `\\b(?:def|fn|func|function|class|struct|enum|trait|interface|type|impl|module|object)\\s+${n}\\b`;
  const method = `^\\s*(?:(?:pub(?:\\([^)]*\\))?|public|private|protected|static|async|export|override|final|abstract|fun)\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\(`;
  const binding = `^\\s*(?:export\\s+)?(?:const|let|var|val)\\s+${n}\\s*[=:]`;
  return new RegExp(`${keyword}|${method}|${binding}`);
}

/** Lines naming where each backticked name in `prompt` is defined in the project at `cwd`, within `maxChars`. */
export function namedSymbols(cwd: string, prompt: string, maxChars: number): string {
  const names = requestNames(prompt);
  if (!names.length) return "";
  const patterns = names.map((name) => [name, definition(name)] as const);
  const found = new Map<string, string[]>();
  for (const file of projectFiles(cwd).filter((f) => CODE.has(extname(f).toLowerCase())).slice(0, MAX_FILES)) {
    let lines: string[];
    try {
      if (statSync(join(cwd, file)).size > MAX_FILE_BYTES) continue;
      lines = readFileSync(join(cwd, file), "utf8").split("\n");
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      for (const [name, re] of patterns) {
        const hits = found.get(name) ?? [];
        if (hits.length < MAX_PER_NAME && re.test(line)) found.set(name, [...hits, `${file}:${i + 1}: ${line.trim().slice(0, LINE_CHARS)}`]);
      }
    });
  }
  if (!found.size) return "";
  const out = [HEADING];
  for (const [name, hits] of found) out.push(`\`${name}\`: ${hits.join("; ")}`);
  return out.join("\n").slice(0, maxChars);
}
