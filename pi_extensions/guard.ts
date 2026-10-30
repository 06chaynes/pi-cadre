/**
 * Path guard for tool calls. Writes and edits must stay inside the project (the working directory). Reads, searches,
 * and bash commands may also use system directories (/usr, /etc, /opt, ...), but nothing else outside the project:
 * not the home directory, not the project's parent, not temporary directories. Bash commands are checked by the paths
 * written in them, so the guard catches mistakes rather than enforcing a sandbox.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_WORD_BREAKS = /[\s;|&()<>'"`=]+/;
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/dev", "/proc", "/sys", "/nix", "/System", "/Library"];
const MAX_LINKS = 40;

/**
 * Resolves `path` against `cwd` the way the operating system does: one component at a time, following each symlink
 * (even one whose target is missing) before applying any later "..", and taking each existing component's on-disk
 * case. A symlink loop, or more than MAX_LINKS links, resolves to the filesystem root, which the guard always blocks.
 */
function physicalPath(path: string, cwd: string, links = { count: 0 }): string {
  const absolute = isAbsolute(path) ? path : `${cwd}${sep}${path}`;
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let isLink = false;
    let exists = true;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      exists = false;
    }
    if (!isLink) {
      // realpathSync.native returns the on-disk case, so case-insensitive file systems compare correctly.
      // A missing component is not a link; the rest of the path stays lexical.
      current = exists ? realpathSync.native(next) : next;
      continue;
    }
    if (++links.count > MAX_LINKS) return root;
    current = physicalPath(readlinkSync(next), current, links);
  }
  return current;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Returns a shell word that looks like a path with ~, $HOME, and ${HOME} expanded, or undefined for other words. */
function shellPath(word: string, home: string): string | undefined {
  const expanded = word.replace(/^(~|\$\{HOME\}|\$HOME)(?=\/|$)/, home);
  const looksLikePath = expanded !== word || expanded.startsWith("/") || expanded.startsWith(".") || expanded.includes("/");
  return looksLikePath ? expanded : undefined;
}

/**
 * Returns why a tool call reaches outside the project at `cwd`, or undefined when it does not. `home` expands ~ and
 * $HOME, and is never treated as a system directory even when it lies under one. Paths are compared after following
 * symlinks.
 */
export function guardReason(toolName: string, input: Record<string, unknown>, cwd: string, home: string): string | undefined {
  const realCwd = physicalPath(cwd, "/");
  const realHome = physicalPath(home, "/");
  const systemDirs = SYSTEM_DIRS.map((dir) => physicalPath(dir, "/"));
  const readable = (path: string) =>
    isInside(path, realCwd) || (!isInside(path, realHome) && systemDirs.some((dir) => isInside(path, dir)));
  let paths: string[] = [];
  if (toolName === "bash" && typeof input.command === "string") {
    paths = input.command.split(SHELL_WORD_BREAKS).flatMap((word) => shellPath(word, home) ?? []);
  } else if ((WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) && typeof input.path === "string") {
    paths = [input.path];
  }
  const outside = paths
    .map((path) => physicalPath(path, realCwd))
    .find((path) => (WRITE_TOOLS.has(toolName) ? !isInside(path, realCwd) : !readable(path)));
  return outside === undefined
    ? undefined
    : `${toolName} reaches ${outside}, outside the project ${cwd}. Work inside the project, or ask the user to run /cadre-guard off.`;
}
