import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, relative, sep } from "node:path";
import { generateIdentity, type Identity } from "@airemo/crypto";

/** Where Airemo keeps its keys and paired devices. Override with AIREMO_HOME. */
export function defaultDataDir(): string {
  return process.env.AIREMO_HOME ?? join(homedir(), ".airemo");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writePrivate(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** The computer's long-lived identity. Created on first run, readable only by the user. */
export function loadOrCreateIdentity(dataDir: string): Identity {
  ensureDir(dataDir);
  const file = join(dataDir, "identity.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Identity>;
    if (typeof parsed.publicKey === "string" && typeof parsed.secretKey === "string") {
      chmodSync(file, 0o600);
      return { publicKey: parsed.publicKey, secretKey: parsed.secretKey };
    }
    throw new Error(`Corrupt identity file: ${file}`);
  }
  const identity = generateIdentity();
  writePrivate(file, JSON.stringify(identity));
  return identity;
}

export interface PairedDevice {
  /** Device ID (Ed25519 public key, base64url). */
  id: string;
  name: string;
  pairedAt: number;
}

/** Devices allowed to connect. Revoking removes access immediately. */
export class DeviceRegistry {
  private devices = new Map<string, PairedDevice>();
  private listeners = new Set<(id: string) => void>();

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as PairedDevice[];
      for (const d of parsed) this.devices.set(d.id, d);
    }
  }

  has(id: string): boolean {
    return this.devices.has(id);
  }

  list(): PairedDevice[] {
    return [...this.devices.values()];
  }

  add(id: string, name: string): PairedDevice {
    const device = { id, name: name || "Unnamed device", pairedAt: Date.now() };
    this.devices.set(id, device);
    this.save();
    return device;
  }

  remove(id: string): boolean {
    const removed = this.devices.delete(id);
    if (removed) {
      this.save();
      for (const l of this.listeners) l(id);
    }
    return removed;
  }

  /** Called after a device is revoked, so live connections can be dropped. */
  onRevoked(listener: (id: string) => void): void {
    this.listeners.add(listener);
  }

  private save(): void {
    if (this.file) writePrivate(this.file, JSON.stringify(this.list(), null, 2));
  }
}

export interface AllowedProject {
  /** Canonical (symlink-resolved) absolute path. */
  path: string;
  name: string;
  addedAt: number;
  /** Agents a remote device may start here. Absent means every agent (also for old entries). */
  agents?: string[];
}

/** `reason` says what failed: the folder is not allowed, or it is but not for that agent. */
export type StartCheck = { ok: true; path: string } | { ok: false; reason: "folder" | "agent" };

function canonical(input: string): string | null {
  try {
    if (!isAbsolute(input)) return null;
    const real = realpathSync.native(input);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Project folders a remote device may start agents in. Empty by default, so a newly paired
 * phone can start nothing until the owner runs `airemo allow` in a project.
 *
 * This limits where an agent is started, not what it can touch once running: that is still
 * gated by the approval flow. Paths are compared after resolving symlinks, so `..`, symlinks
 * and look-alike names (`/code/app-evil` vs `/code/app`) cannot escape an allowed folder.
 */
export class ProjectAllowlist {
  private projects = new Map<string, AllowedProject>();

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as AllowedProject[];
      for (const p of parsed) this.projects.set(p.path, p);
    }
  }

  list(): AllowedProject[] {
    return [...this.projects.values()];
  }

  /**
   * Allow a folder. `agents` is exactly the set a remote device may start there; null means every
   * agent. Allowing a folder again replaces its agents (the last choice wins).
   * Throws if the path is not an existing absolute directory, or is a filesystem root.
   */
  add(input: string, agents: string[] | null = null): AllowedProject {
    const real = canonical(input);
    if (!real) throw new Error("Not an existing absolute directory");
    if (parse(real).root === real) throw new Error("Refusing to allow a filesystem root");
    if (agents !== null && agents.length === 0) throw new Error("Choose at least one agent");
    const chosen = agents === null ? undefined : [...new Set(agents)];

    const existing = this.projects.get(real);
    const project: AllowedProject = existing ?? {
      path: real,
      name: basename(real),
      addedAt: Date.now(),
    };
    if (chosen) project.agents = chosen;
    else delete project.agents;
    this.projects.set(real, project);
    this.save();
    return project;
  }

  remove(input: string): boolean {
    // The folder may have been deleted since it was added, so fall back to the raw string.
    const key = canonical(input) ?? input;
    const removed = this.projects.delete(key);
    if (removed) this.save();
    return removed;
  }

  /**
   * Is `cwd` an allowed project folder or inside one, and may `agent` be started there? Returns the
   * canonical path to launch in. If folders are nested, the most specific one decides, so a
   * folder allowed for one agent inside a folder allowed for all is not widened by its parent.
   */
  check(cwd: string, agent?: string): StartCheck {
    const real = canonical(cwd);
    if (!real) return { ok: false, reason: "folder" };
    let best: { root: string; project: AllowedProject } | null = null;
    for (const [root, project] of this.projects) {
      const realRoot = canonical(root);
      if (realRoot && isInside(realRoot, real) && (!best || realRoot.length > best.root.length)) {
        best = { root: realRoot, project };
      }
    }
    if (!best) return { ok: false, reason: "folder" };
    if (agent !== undefined && best.project.agents && !best.project.agents.includes(agent)) {
      return { ok: false, reason: "agent" };
    }
    return { ok: true, path: real };
  }

  private save(): void {
    if (this.file) writePrivate(this.file, JSON.stringify(this.list(), null, 2));
  }
}
