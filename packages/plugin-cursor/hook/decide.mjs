import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Tools that only look. They are allowed without asking, as long as they stay inside the
 * workspace. Everything else (shell, writes, deletes, MCP, web, unknown tools) asks first.
 */
export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "SemanticSearch",
  "ReadLints",
  "TodoWrite",
]);

const PATH_KEYS = ["file_path", "path", "target_file", "target_directory", "directory", "cwd"];
const GLOB_KEYS = ["glob", "glob_pattern"];

/** Resolve symlinks, even for a path that does not exist yet, so a link cannot hide an escape. */
function canonical(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonical(parent), basename(p));
  }
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Decide whether a tool call may run without asking the user.
 * Returns "allow" or "ask". There is deliberately no "deny": the user decides.
 */
export function classify(toolName, toolInput, workspaceRoots, cwd) {
  if (!READ_ONLY_TOOLS.has(toolName)) return "ask";
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) return "ask";

  const base = typeof cwd === "string" && cwd !== "" ? cwd : workspaceRoots[0];
  const roots = workspaceRoots.map((r) => canonical(String(r)));
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const insideRoots = (p) => roots.some((r) => isInside(r, canonical(p)));

  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value === "") continue;
    if (!insideRoots(isAbsolute(value) ? value : resolve(base, value))) return "ask";
  }
  for (const key of GLOB_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value === "") continue;
    if (value.split(/[\\/]/).includes("..")) return "ask";
    if (isAbsolute(value)) {
      // Check the fixed part of the pattern, before the first wildcard.
      const fixed = value.split(/[*?[{]/)[0] ?? value;
      if (!insideRoots(fixed)) return "ask";
    }
  }
  return "allow";
}
