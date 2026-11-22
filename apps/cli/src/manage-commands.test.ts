import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon } from "@airemo/daemon";
import { type AgentPlugin, PluginRegistry } from "@airemo/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAgent } from "./agents.js";
import {
  allowFolder,
  daemonSupports,
  disallowFolder,
  type ManageIo,
  unpairDevice,
} from "./manage-commands.js";
import type { PickItem, PickOptions } from "./picker.js";

const fake = (id: string, displayName: string): AgentPlugin => ({
  id,
  displayName,
  capabilities: { structuredOutput: false, permissionHooks: false, pauseResume: false },
  detect: async () => ({ installed: true }),
  launch: ({ cwd }) => ({ command: "cat", args: [], env: {}, cwd }),
  parseOutput: () => [],
  respondToPermission: () => null,
});

describe("agent names", () => {
  it("knows claude-code and agent (Cursor), plus a few aliases", () => {
    expect(resolveAgent("claude-code")).toBe("claude-code");
    expect(resolveAgent("Claude")).toBe("claude-code");
    expect(resolveAgent("agent")).toBe("cursor");
    expect(resolveAgent("cursor")).toBe("cursor");
    expect(resolveAgent("codex")).toBeNull();
  });
});

describe("allow / disallow / unpair, against a real daemon", () => {
  let daemon: Daemon;
  let dataDir: string;
  let folder: string;
  let picks: Array<{ title: string; items: PickItem[]; opts?: PickOptions }>;
  let answer: string[] | null;

  const io = (interactive = true): ManageIo => ({
    port: daemon.port,
    interactive,
    pick: async (title, items, opts) => {
      picks.push({ title, items, ...(opts ? { opts } : {}) });
      return answer;
    },
    installed: async () => [
      { id: "claude-code", displayName: "Claude Code", version: "2.1" },
      { id: "cursor", displayName: "Cursor" },
    ],
  });
  const allowed = () => daemon.projects.list();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "airemo-manage-"));
    daemon = await startDaemon({
      port: 0,
      dataDir,
      registry: new PluginRegistry()
        .register(fake("claude-code", "Claude Code"))
        .register(fake("cursor", "Cursor")),
    });
  });
  afterAll(() => daemon.close());
  beforeEach(() => {
    picks = [];
    answer = null;
    for (const p of daemon.projects.list()) daemon.projects.remove(p.path);
    folder = realpathSync(mkdtempSync(join(tmpdir(), "airemo-proj-")));
  });

  it("allow asks which installed agents, and saves exactly those", async () => {
    answer = ["cursor"];
    const r = await allowFolder(folder, [], io());
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toContain("Cursor");
    expect(picks[0]?.items.map((i) => i.value)).toEqual(["claude-code", "cursor"]);
    expect(picks[0]?.opts).toMatchObject({ multiple: true, min: 1, selected: [] });
    expect(allowed()).toEqual([expect.objectContaining({ path: folder, agents: ["cursor"] })]);
  });

  it("allowing again starts from the folder's current agents and replaces them", async () => {
    answer = ["cursor"];
    await allowFolder(folder, [], io());
    answer = ["claude-code", "cursor"];
    await allowFolder(folder, [], io());
    expect(picks[1]?.opts?.selected).toEqual(["cursor"]);
    expect(allowed()[0]?.agents).toEqual(["claude-code", "cursor"]);
  });

  it("allow defaults to this folder", async () => {
    answer = ["claude-code"];
    const sub = join(folder, "app");
    mkdirSync(sub);
    await allowFolder(undefined, [], io(), sub);
    expect(allowed()[0]?.path).toBe(sub);
  });

  it("cancelling the list allows nothing", async () => {
    answer = null;
    expect(await allowFolder(folder, [], io())).toMatchObject({ ok: false, code: 130 });
    expect(allowed()).toEqual([]);
  });

  it("--agent skips the list and accepts the names people type", async () => {
    const r = await allowFolder(folder, ["agent", "claude-code", "cursor"], io(false));
    expect(r.ok).toBe(true);
    expect(picks).toHaveLength(0);
    expect(allowed()[0]?.agents).toEqual(["cursor", "claude-code"]);
    expect(await allowFolder(folder, ["codex"], io())).toMatchObject({ ok: false });
  });

  it("without a terminal and without --agent, it says how instead of guessing", async () => {
    const r = await allowFolder(folder, [], io(false));
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("--agent");
    expect(allowed()).toEqual([]);
  });

  it("with no agent installed, nothing can be chosen", async () => {
    const none = { ...io(), installed: async () => [] };
    expect(await allowFolder(folder, [], none)).toMatchObject({ ok: false });
  });

  it("disallow removes a folder by path, or one picked from the list", async () => {
    await allowFolder(folder, ["agent"], io());
    expect(await disallowFolder(folder, io())).toMatchObject({ ok: true });
    expect(allowed()).toEqual([]);
    expect(await disallowFolder(folder, io())).toMatchObject({ ok: false });

    await allowFolder(folder, ["agent"], io());
    answer = [folder];
    expect(await disallowFolder(undefined, io())).toMatchObject({ ok: true });
    expect(picks.at(-1)?.items.map((i) => i.value)).toEqual([folder]);
    expect(allowed()).toEqual([]);
  });

  it("unpair removes a device by name, id prefix, or from the list", async () => {
    daemon.devices.add("AAAA-phone-id", "Pixel");
    daemon.devices.add("BBBB-tablet-id", "iPad");
    expect(await unpairDevice("Pixel", io())).toMatchObject({ ok: true });
    expect(daemon.devices.has("AAAA-phone-id")).toBe(false);

    answer = ["BBBB-tablet-id"];
    expect(await unpairDevice(undefined, io())).toMatchObject({ ok: true });
    expect(daemon.devices.has("BBBB-tablet-id")).toBe(false);

    daemon.devices.add("CCCC-1", "A");
    daemon.devices.add("CCCC-2", "B");
    expect(await unpairDevice("CCCC", io())).toMatchObject({ ok: false }); // ambiguous
    expect(await unpairDevice("CCCC-2", io())).toMatchObject({ ok: true });
    expect(await unpairDevice("nobody", io())).toMatchObject({ ok: false });
  });

  it("tells an old daemon (which would silently ignore resume) from a current one", async () => {
    expect(await daemonSupports(daemon.port, "resume")).toBe("yes");
    const oldStatus = (async () =>
      new Response(JSON.stringify({ daemonId: "x", relay: null }))) as unknown as typeof fetch;
    expect(await daemonSupports(daemon.port, "resume", oldStatus)).toBe("no");
    expect(await daemonSupports(1, "resume")).toBe("unreachable");
  });

  it("says when the daemon is not running", async () => {
    const down = { ...io(), port: 1 };
    expect((await allowFolder(folder, ["agent"], down)).message).toContain("airemo start");
  });
});
