import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Cleanup } from "@airemo/plugin-sdk";

/** File name of our hook script. Used to recognise our own entry among the user's hooks. */
export const HOOK_MARKER = "airemo-approval-hook.mjs";
const EXCLUDE_LINE = "/.cursor/hooks.json";

interface State {
  count: number;
  /** File contents before we touched it, or null if the file did not exist. */
  original: string | null;
  /** What we wrote, to tell whether anyone edited the file while sessions were running. */
  written: string;
  createdDir: boolean;
  excludeFile: string | null;
}

// One entry per project folder: several sessions can share it.
const active = new Map<string, State>();

const quote = (p: string) => `"${p.replace(/(["\\$`])/g, "\\$1")}"`;

function isOurs(entry: unknown): boolean {
  const command = (entry as { command?: unknown } | null)?.command;
  return typeof command === "string" && command.includes(HOOK_MARKER);
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.airemo-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/** Keep the generated file out of `git status` so it cannot be committed by accident. */
function addGitExclude(cwd: string, hadFile: boolean): string | null {
  // A tracked hooks.json belongs to the project: leave git alone.
  if (hadFile && git(cwd, ["ls-files", "--error-unmatch", ".cursor/hooks.json"]) !== null) {
    return null;
  }
  const rel = git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
  if (!rel) return null;
  const file = resolve(cwd, rel);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").includes(EXCLUDE_LINE)) return null; // already there, not ours to remove
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`,
  );
  return file;
}

function removeGitExclude(file: string | null): void {
  if (!file || !existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const i = lines.indexOf(EXCLUDE_LINE);
  if (i >= 0) {
    lines.splice(i, 1);
    writeFileSync(file, lines.join("\n"));
  }
}

function invalid(file: string): Error {
  return new Error(
    `${file} is not valid JSON in the expected shape, so Airemo cannot add its approval hook. ` +
      "Fix or remove it and try again.",
  );
}

export interface InstallOptions {
  /** Absolute path of the hook script. */
  hookPath: string;
  /** Node binary used to run it. */
  nodePath?: string;
  /** How long Cursor waits for a decision, in seconds. */
  timeoutSeconds?: number;
}

/**
 * Add Airemo's approval hook to `<cwd>/.cursor/hooks.json`, keeping everything already in the
 * file. Throws, leaving the file untouched, if the file cannot be understood: a session that
 * cannot be gated must not start ungated. The returned cleanup removes our entry again.
 */
export function installApprovalHook(cwd: string, options: InstallOptions): Cleanup {
  const dir = join(cwd, ".cursor");
  const file = join(dir, "hooks.json");

  const shared = active.get(file);
  if (shared) {
    shared.count++;
    return cleanupFor(file);
  }

  const original = existsSync(file) ? readFileSync(file, "utf8") : null;
  let json: Record<string, unknown> = {};
  if (original !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch {
      throw invalid(file);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid(file);
    json = parsed as Record<string, unknown>;
  }
  if (
    json.hooks !== undefined &&
    (typeof json.hooks !== "object" || json.hooks === null || Array.isArray(json.hooks))
  ) {
    throw invalid(file);
  }
  const hooks = (json.hooks ?? {}) as Record<string, unknown>;
  if (hooks.preToolUse !== undefined && !Array.isArray(hooks.preToolUse)) throw invalid(file);

  const ours = {
    command: `${quote(options.nodePath ?? process.execPath)} ${quote(options.hookPath)}`,
    timeout: options.timeoutSeconds ?? 600,
    // If the hook crashes or times out, block the action instead of letting it through.
    failClosed: true,
  };
  hooks.preToolUse = [
    ...((hooks.preToolUse as unknown[] | undefined) ?? []).filter((e) => !isOurs(e)),
    ours,
  ];
  json.hooks = hooks;
  if (json.version === undefined) json.version = 1;

  const createdDir = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  const written = `${JSON.stringify(json, null, 2)}\n`;
  atomicWrite(file, written);
  const excludeFile = addGitExclude(cwd, original !== null);

  active.set(file, { count: 1, original, written, createdDir, excludeFile });
  return cleanupFor(file);
}

function cleanupFor(file: string): Cleanup {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const state = active.get(file);
    if (!state || --state.count > 0) return;
    active.delete(file);
    restore(file, state);
  };
}

function restore(file: string, state: State): void {
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (current === state.written) {
    // Untouched since we wrote it: put back exactly what was there before.
    if (state.original === null) {
      rmSync(file, { force: true });
      if (state.createdDir) {
        const dir = dirname(file);
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      }
    } else {
      atomicWrite(file, state.original);
    }
  } else if (current !== null) {
    // Edited while a session ran: remove only our entry and keep the edits.
    try {
      const json = JSON.parse(current) as { hooks?: { preToolUse?: unknown[] } };
      const pre = json.hooks?.preToolUse;
      if (json.hooks && Array.isArray(pre)) {
        const rest = pre.filter((e) => !isOurs(e));
        if (rest.length > 0) json.hooks.preToolUse = rest;
        else json.hooks.preToolUse = undefined;
        atomicWrite(file, `${JSON.stringify(json, null, 2)}\n`);
      }
    } catch {
      // Unreadable now: leave it alone. Our entry is inert outside an Airemo session.
    }
  }
  removeGitExclude(state.excludeFile);
}
