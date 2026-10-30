/**
 * The project's files, listed in the system prompt so the model knows where things are without searching. In testing,
 * Spark ran ls or find before reading a file it had been told about in most samples; a listing removes that step.
 * Built by code from git (or the directory), bounded in size, and the same for the same project.
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Directories a listing outside git skips (dependencies, builds, caches, version control).
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "target", "dist", "build", "__pycache__", ".next", ".cache"]);
const MAX_FILES = 20000;
const HEADING = "Project files (paths relative to the working directory):";

/** Relative paths of the project's files: git's tracked and untracked-but-not-ignored files, else a directory walk. */
function projectFiles(cwd: string): string[] {
  try {
    // core.fsmonitor in a repository's own config names a command git would run; it stays off.
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean).slice(0, MAX_FILES);
  } catch {
    const files: string[] = [];
    const queue = [""];
    while (queue.length && files.length < MAX_FILES) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = readdirSync(join(cwd, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(rel);
        } else files.push(rel);
      }
    }
    return files;
  }
}

/**
 * A listing of the project at `cwd` within `maxChars`: every file when they fit, else top-level directories with file
 * counts and top-level files, plus the project files whose paths `prompt` names.
 */
export function projectMap(cwd: string, prompt: string, maxChars: number): string {
  const files = projectFiles(cwd).sort();
  const full = [HEADING, ...files].join("\n");
  if (full.length <= maxChars) return full;
  const counts = new Map<string, number>();
  const topFiles: string[] = [];
  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash < 0) topFiles.push(file);
    else counts.set(file.slice(0, slash), (counts.get(file.slice(0, slash)) ?? 0) + 1);
  }
  const named = files.filter((file) => prompt.includes(file));
  const lines = [HEADING, ...named, ...[...counts].map(([dir, n]) => `${dir}/ (${n} files)`), ...topFiles];
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}
