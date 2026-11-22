import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecureClient } from "@airemo/client";
import { generateIdentity, parsePairingUri } from "@airemo/crypto";
import { type AgentPlugin, PluginRegistry } from "@airemo/plugin-sdk";
import { createMessage, type Message, parseMessage } from "@airemo/protocol";
import { createRelay } from "@airemo/relay";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./server.js";
import { ProjectAllowlist } from "./stores.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "airemo-agents-")));
const dir = (...parts: string[]) => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("ProjectAllowlist: agents per folder", () => {
  const app = dir("lists", "app");
  const sub = dir("lists", "app", "packages", "ui");
  const other = dir("lists", "other");

  it("allows every agent unless told otherwise", () => {
    const l = new ProjectAllowlist();
    l.add(app);
    expect(l.list()[0]?.agents).toBeUndefined();
    expect(l.check(app, "claude-code")).toEqual({ ok: true, path: app });
    expect(l.check(app, "cursor").ok).toBe(true);
    expect(l.check(app, "anything-else").ok).toBe(true);
    expect(l.check(app).ok).toBe(true); // no agent asked about
  });

  it("limits a folder to the agents it was given", () => {
    const l = new ProjectAllowlist();
    l.add(app, ["claude-code"]);
    expect(l.list()[0]?.agents).toEqual(["claude-code"]);
    expect(l.check(app, "claude-code").ok).toBe(true);
    expect(l.check(app, "cursor")).toEqual({ ok: false, reason: "agent" });
    expect(l.check(sub, "cursor")).toEqual({ ok: false, reason: "agent" }); // subfolders inherit
    expect(l.check(sub, "claude-code").ok).toBe(true);
  });

  it("says whether the folder or the agent was the problem", () => {
    const l = new ProjectAllowlist();
    l.add(app, ["cursor"]);
    expect(l.check(other, "cursor")).toEqual({ ok: false, reason: "folder" });
    expect(l.check(app, "claude-code")).toEqual({ ok: false, reason: "agent" });
    expect(l.check("relative/path", "cursor")).toEqual({ ok: false, reason: "folder" });
  });

  it("allows several agents, ignores duplicates, and refuses an empty choice", () => {
    const l = new ProjectAllowlist();
    expect(l.add(app, ["cursor", "claude-code", "cursor"]).agents).toEqual([
      "cursor",
      "claude-code",
    ]);
    expect(() => l.add(app, [])).toThrow(/at least one agent/);
    expect(l.list()[0]?.agents).toEqual(["cursor", "claude-code"]); // unchanged by the failed call
  });

  it("replaces the agents when the folder is allowed again (the last choice wins)", () => {
    const l = new ProjectAllowlist();
    l.add(app, ["claude-code"]);
    l.add(app, ["cursor"]);
    expect(l.list()).toHaveLength(1);
    expect(l.check(app, "claude-code").ok).toBe(false);
    expect(l.check(app, "cursor").ok).toBe(true);
    l.add(app, null); // back to every agent
    expect(l.list()[0]?.agents).toBeUndefined();
    expect(l.check(app, "claude-code").ok).toBe(true);
    expect(l.check(app, "cursor").ok).toBe(true);
  });

  it("lets the most specific folder decide when folders are nested", () => {
    const l = new ProjectAllowlist();
    l.add(app, ["claude-code"]); // parent: Claude Code only
    l.add(sub, null); // child: every agent
    expect(l.check(sub, "cursor").ok).toBe(true); // the child is not narrowed by its parent
    expect(l.check(app, "cursor").ok).toBe(false);

    const m = new ProjectAllowlist();
    m.add(app, null); // parent: every agent
    m.add(sub, ["cursor"]); // child: Cursor only
    expect(m.check(sub, "claude-code").ok).toBe(false); // the child is not widened by its parent
    expect(m.check(sub, "cursor").ok).toBe(true);
    expect(m.check(app, "claude-code").ok).toBe(true);
  });

  it("remembers agents across restarts, and treats old entries without agents as every agent", () => {
    const file = join(dir("state"), "projects.json");
    const l = new ProjectAllowlist(file);
    l.add(app, ["cursor"]);
    l.add(other);
    const again = new ProjectAllowlist(file);
    expect(again.check(app, "cursor").ok).toBe(true);
    expect(again.check(app, "claude-code").ok).toBe(false);
    expect(again.check(other, "claude-code").ok).toBe(true);

    // The file as written before this feature existed: no `agents` field at all.
    const oldFile = join(dir("state-old"), "projects.json");
    writeFileSync(oldFile, JSON.stringify([{ path: app, name: "app", addedAt: 1 }]));
    const old = new ProjectAllowlist(oldFile);
    expect(old.check(app, "claude-code").ok).toBe(true);
    expect(old.check(app, "cursor").ok).toBe(true);
  });
});

describe("agents per folder, through the relay and a paired phone", () => {
  const plugin = (id: string): AgentPlugin => ({
    id,
    displayName: id,
    capabilities: { structuredOutput: false, permissionHooks: false, pauseResume: false },
    detect: async () => ({ installed: true }),
    launch: ({ cwd }) => ({
      command: "cat",
      args: [],
      env: process.env as Record<string, string>,
      cwd,
    }),
    parseOutput: () => [],
    respondToPermission: () => null,
  });

  let relay: Awaited<ReturnType<typeof createRelay>>;
  let daemon: Daemon;
  let relayUrl: string;
  const clients: SecureClient[] = [];
  const app = dir("remote", "app");
  const sub = dir("remote", "app", "web");

  beforeAll(async () => {
    relay = await createRelay();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    relayUrl = `ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    daemon = await startDaemon({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), "airemo-agents-d-")),
      relayUrl,
      registry: new PluginRegistry().register(plugin("alpha")).register(plugin("beta")),
    });
    await until(() => daemon.remote?.status === "connected");
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await daemon.close();
    await relay.close();
  });

  async function phone() {
    const { token } = parsePairingUri(daemon.remote?.createPairing().uri ?? "");
    const inbox: Message[] = [];
    const client = new SecureClient({
      identity: generateIdentity(),
      daemonId: daemon.identity.publicKey,
      relayUrl,
      token,
      timeoutMs: 3000,
    });
    client.on((m) => inbox.push(m));
    clients.push(client);
    await client.connect();
    return { client, inbox };
  }
  const start = (p: { client: SecureClient }, agent: string, cwd: string) =>
    p.client.send("session.start", { agent, cwd });
  const errors = (inbox: Message[]) =>
    inbox
      .filter((m) => m.type === "error")
      .map((m) => (m.type === "error" ? m.payload.message : ""));
  const started = (inbox: Message[]) => inbox.filter((m) => m.type === "session.started").length;
  const listing = async (p: { client: SecureClient; inbox: Message[] }) => {
    const before = p.inbox.filter((m) => m.type === "project.listing").length;
    p.client.send("project.list", {});
    await until(() => p.inbox.filter((m) => m.type === "project.listing").length > before);
    const last = p.inbox.filter((m) => m.type === "project.listing").at(-1);
    return last?.type === "project.listing" ? last.payload.projects : [];
  };
  const api = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lets the phone start only the agent the folder was opened for", async () => {
    daemon.projects.add(app, ["alpha"]);
    const p = await phone();

    start(p, "alpha", app);
    await until(() => started(p.inbox) === 1);

    start(p, "beta", app);
    await until(() => errors(p.inbox).length === 1);
    expect(errors(p.inbox)[0]).toBe("That agent is not allowed in this folder");
    expect(started(p.inbox)).toBe(1);
    expect(daemon.sessions.list().filter((s) => s.agent === "beta")).toHaveLength(0);

    start(p, "beta", sub); // subfolders follow the folder
    await until(() => errors(p.inbox).length === 2);
    for (const s of daemon.sessions.list()) s.stop();
  });

  it("tells the phone which agents each folder allows, so it can show only those", async () => {
    daemon.projects.add(app, ["beta"]);
    const other = dir("remote", "everyone");
    daemon.projects.add(other, null);
    const p = await phone();
    const projects = await listing(p);
    expect(projects.find((x) => x.path === app)?.agents).toEqual(["beta"]);
    expect(projects.find((x) => x.path === other)?.agents).toBeUndefined(); // no field = every agent
  });

  it("opens a folder to every agent when none are named", async () => {
    daemon.projects.add(app, null);
    const p = await phone();
    start(p, "alpha", app);
    start(p, "beta", app);
    await until(() => started(p.inbox) === 2);
    expect(errors(p.inbox)).toEqual([]);
    for (const s of daemon.sessions.list()) s.stop();
  });

  it("does not restrict the person at the keyboard (a local connection)", async () => {
    daemon.projects.add(app, ["alpha"]);
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
    const got = new Promise<Message>((resolve) => {
      ws.onmessage = (ev) => {
        const m = parseMessage(JSON.parse(String(ev.data)));
        if (m.type === "session.started" || m.type === "error") resolve(m);
      };
    });
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send(JSON.stringify(createMessage("session.start", { agent: "beta", cwd: app })));
    expect((await got).type).toBe("session.started");
    ws.close();
    for (const s of daemon.sessions.list()) s.stop();
  });

  describe("the local API behind `airemo run` and `airemo allow`", () => {
    const folder = dir("api", "demo");

    it("accepts a list of agents, a missing list (all) and null (all)", async () => {
      let r = await api("/projects", { path: folder, agents: ["alpha"] });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { agents: string[] }).agents).toEqual(["alpha"]);

      r = await api("/projects", { path: folder, agents: ["beta", "alpha"] }); // replaces
      expect(((await r.json()) as { agents: string[] }).agents).toEqual(["beta", "alpha"]);

      r = await api("/projects", { path: folder }); // no agents given: every agent
      expect(((await r.json()) as { agents?: string[] }).agents).toBeUndefined();

      await api("/projects", { path: folder, agents: ["alpha"] });
      r = await api("/projects", { path: folder, agents: null });
      expect(((await r.json()) as { agents?: string[] }).agents).toBeUndefined();
    });

    it("refuses unknown agents, bad shapes and an empty list, and changes nothing", async () => {
      await api("/projects", { path: folder, agents: ["alpha"] });
      for (const bad of [["nope"], ["alpha", "nope"], [], "alpha", [1], {}]) {
        const r = await api("/projects", { path: folder, agents: bad });
        expect(r.status).toBe(400);
      }
      const r = await api("/projects", { path: folder, agents: ["nope"] });
      expect(((await r.json()) as { error: string }).error).toBe("Unknown agent: nope");
      const list = (await (
        await fetch(`http://127.0.0.1:${daemon.port}/projects`)
      ).json()) as Array<{
        path: string;
        agents?: string[];
      }>;
      expect(list.find((p) => p.path === folder)?.agents).toEqual(["alpha"]);
    });
  });
});
