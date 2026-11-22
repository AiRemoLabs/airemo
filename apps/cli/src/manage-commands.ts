import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describeAgents, resolveAgent, unknownAgentMessage } from "./agents.js";
import type { PickItem, PickOptions } from "./picker.js";
import { agentLabel } from "./run.js";

export interface ManageIo {
  port: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Can we show an interactive list? (stdin and stdout are a terminal) */
  interactive: boolean;
  pick(title: string, items: PickItem[], opts?: PickOptions): Promise<string[] | null>;
  /** Agents installed on this computer. Only asked for when the person has to choose. */
  installed?(): Promise<Array<{ id: string; displayName: string; version?: string }>>;
}

/** `code` is the exit code: 1 for an error, 130 when the person cancelled. */
export type Outcome = { ok: true; message: string } | { ok: false; message: string; code: number };

export interface AllowedFolder {
  path: string;
  name?: string;
  agents?: string[];
}

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number;
  connected?: boolean;
}

const UNREACHABLE = "Could not reach the daemon. Run `airemo start` first.";
const fail = (message: string, code = 1): Outcome => ({ ok: false, message, code });
const cancelled = (what: string) => fail(`Cancelled. ${what}`, 130);

class Unreachable extends Error {}

function api(io: ManageIo) {
  const call = io.fetch ?? fetch;
  return async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      return await call(`http://127.0.0.1:${io.port}${path}`, init);
    } catch {
      throw new Unreachable();
    }
  };
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const guard = async (run: () => Promise<Outcome>): Promise<Outcome> => {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Unreachable) return fail(UNREACHABLE);
    throw e;
  }
};

export const RESTART_DAEMON =
  "The running daemon is older than this CLI. Stop it (Ctrl+C in its window) and run `airemo start` again.";

/**
 * Does the running daemon support `feature`? An older daemon silently drops message fields it does
 * not know, so `airemo resume` would quietly start a fresh session instead. Check first.
 */
export async function daemonSupports(
  port: number,
  feature: string,
  call: typeof fetch = fetch,
): Promise<"yes" | "no" | "unreachable"> {
  try {
    const s = (await (await call(`http://127.0.0.1:${port}/status`)).json()) as {
      features?: unknown;
    };
    return Array.isArray(s.features) && s.features.includes(feature) ? "yes" : "no";
  } catch {
    return "unreachable";
  }
}

export function formatFolder(p: AllowedFolder): string {
  return `${p.path}  (${describeAgents(p.agents ?? null)})`;
}

export function formatDevice(d: PairedDevice): string {
  // `connected` is missing from an older daemon: show nothing rather than a wrong "not connected".
  const state =
    d.connected === undefined
      ? ""
      : d.connected
        ? "  \x1b[32mconnected\x1b[0m"
        : "  \x1b[2mnot connected\x1b[0m";
  return `${d.name || "(unnamed)"}${state}  paired ${new Date(d.pairedAt).toLocaleString()}\n  id: ${d.id}`;
}

/**
 * `airemo allow [path] [--agent X ...]`: open a folder to the paired phone, for chosen agents.
 * With no `--agent`, the installed agents are listed and the person ticks at least one. A folder
 * that is already allowed starts with its current agents ticked; allowing again replaces them.
 */
export function allowFolder(
  pathArg: string | undefined,
  agentNames: string[],
  io: ManageIo,
  cwd = process.cwd(),
): Promise<Outcome> {
  return guard(async () => {
    const call = api(io);
    const path = resolve(cwd, pathArg ?? ".");

    let agents: string[];
    if (agentNames.length > 0) {
      agents = [];
      for (const name of agentNames) {
        const id = resolveAgent(name);
        if (!id) return fail(unknownAgentMessage(name));
        if (!agents.includes(id)) agents.push(id);
      }
    } else {
      if (!io.interactive) {
        return fail(
          "Say which agents your phone may use here, for example:\n" +
            "  airemo allow --agent claude-code --agent agent",
        );
      }
      const installed = (await io.installed?.()) ?? [];
      if (installed.length === 0) {
        return fail("No supported agent is installed. Run `airemo doctor` to check.");
      }
      const existing = ((await (await call("/projects")).json()) as AllowedFolder[]).find(
        (p) => canonical(p.path) === canonical(path),
      );
      const chosen = await io.pick(
        `Which agents may your phone use in ${path}?`,
        installed.map((a) => ({
          value: a.id,
          label: a.displayName,
          ...(a.version ? { hint: a.version } : {}),
        })),
        {
          multiple: true,
          min: 1,
          // An old entry without a list allowed every agent.
          selected: existing ? (existing.agents ?? installed.map((a) => a.id)) : [],
        },
      );
      if (!chosen) return cancelled("The folder was not allowed.");
      agents = chosen;
    }

    const res = await call("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, agents }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return fail(`Could not allow that folder: ${body.error ?? res.status}`);
    }
    const saved = (await res.json()) as AllowedFolder;
    return {
      ok: true,
      message: `Allowed: ${saved.path}\nYour phone may start: ${(saved.agents ?? agents).map(agentLabel).join(", ")}`,
    };
  });
}

/** `airemo disallow [path]`: with no path, choose one from the allowed folders. */
export function disallowFolder(pathArg: string | undefined, io: ManageIo): Promise<Outcome> {
  return guard(async () => {
    const call = api(io);
    let path: string;
    if (pathArg) {
      path = resolve(pathArg);
    } else {
      const list = (await (await call("/projects")).json()) as AllowedFolder[];
      if (list.length === 0) return { ok: true, message: "No folders are allowed." };
      if (!io.interactive) {
        return fail(
          `Say which folder: airemo disallow <path>\n${list.map(formatFolder).join("\n")}`,
        );
      }
      const chosen = await io.pick(
        "Which folder should your phone no longer use?",
        list.map((p) => ({ value: p.path, label: p.path, hint: describeAgents(p.agents ?? null) })),
      );
      if (!chosen) return cancelled("Nothing was changed.");
      path = chosen[0] as string;
    }
    const res = await call(`/projects?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    if (res.status === 404) return fail("That folder is not on the allowed list.");
    if (!res.ok) return fail(`Could not remove that folder (${res.status}).`);
    return { ok: true, message: `No longer allowed: ${path}` };
  });
}

/**
 * `airemo unpair [device]`: revoke a paired device. `device` is its id, the start of its id, or its
 * name. With nothing, choose from the list. A revoked device is disconnected at once.
 */
export function unpairDevice(arg: string | undefined, io: ManageIo): Promise<Outcome> {
  return guard(async () => {
    const call = api(io);
    const list = (await (await call("/devices")).json()) as PairedDevice[];
    if (list.length === 0) return { ok: true, message: "No paired devices." };

    let device: PairedDevice | undefined;
    if (arg) {
      const matches = list.filter((d) => d.id === arg || d.name === arg || d.id.startsWith(arg));
      const exact = matches.find((d) => d.id === arg);
      if (exact) device = exact;
      else if (matches.length === 1) device = matches[0];
      else if (matches.length > 1) {
        return fail(`"${arg}" matches more than one device. Use more of its id.`);
      } else {
        return fail(`No paired device matches "${arg}". See \`airemo devices\`.`);
      }
    } else {
      if (!io.interactive) {
        return fail(`Say which device: airemo unpair <id>\n${list.map(formatDevice).join("\n")}`);
      }
      const chosen = await io.pick(
        "Which device should be removed?",
        list.map((d) => ({
          value: d.id,
          label: d.name || "(unnamed)",
          hint: `${d.connected ? "connected" : "not connected"} · ${d.id.slice(0, 12)}…`,
        })),
      );
      if (!chosen) return cancelled("No device was removed.");
      device = list.find((d) => d.id === chosen[0]);
    }
    if (!device) return fail("No such device.");

    const res = await call(`/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
    if (res.status === 404) return fail("No such device.");
    if (!res.ok) return fail(`Could not remove that device (${res.status}).`);
    return {
      ok: true,
      message: `Removed ${device.name || "the device"}. It is disconnected and can no longer connect.`,
    };
  });
}
