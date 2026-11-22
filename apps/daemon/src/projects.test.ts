import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecureClient } from "@airemo/client";
import { generateIdentity, parsePairingUri } from "@airemo/crypto";
import { type AgentPlugin, PluginRegistry } from "@airemo/plugin-sdk";
import { createMessage, type Message, parseMessage } from "@airemo/protocol";
import { createRelay } from "@airemo/relay";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./server.js";
import { ProjectAllowlist } from "./stores.js";

// Everything lives under one real (symlink-resolved) temp root.
const root = realpathSync(mkdtempSync(join(tmpdir(), "airemo-proj-")));
const dir = (...parts: string[]) => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

describe("ProjectAllowlist", () => {
  const app = dir("code", "app");
  const sub = dir("code", "app", "packages", "ui");
  const evilSibling = dir("code", "app-evil");
  const dotted = dir("code", "app", "..hidden");
  const outside = dir("secrets");
  const file = join(app, "readme.txt");
  writeFileSync(file, "x");
  symlinkSync(outside, join(app, "escape")); // inside the project, points outside it
  symlinkSync(app, join(root, "alias-to-app")); // outside the project, points inside it

  const list = () => {
    const l = new ProjectAllowlist();
    l.add(app);
    return l;
  };

  it("denies everything while empty", () => {
    expect(new ProjectAllowlist().check(app).ok).toBe(false);
  });

  it("allows the folder itself and anything inside it", () => {
    const l = list();
    expect(l.check(app).ok).toBe(true);
    expect(l.check(sub).ok).toBe(true);
    expect(l.check(dotted).ok).toBe(true); // a folder literally named "..hidden" is inside
  });

  it("denies look-alike siblings, parents and unrelated folders", () => {
    const l = list();
    expect(l.check(evilSibling).ok).toBe(false); // shares the "app" prefix
    expect(l.check(join(root, "code")).ok).toBe(false); // parent
    expect(l.check(outside).ok).toBe(false);
  });

  it("denies .. traversal out of the project", () => {
    const l = list();
    expect(l.check(join(app, "..", "app-evil")).ok).toBe(false);
    expect(l.check(join(sub, "..", "..", "..", "..", "secrets")).ok).toBe(false);
  });

  it("denies a symlink inside the project that points outside it", () => {
    expect(list().check(join(app, "escape")).ok).toBe(false);
  });

  it("judges a symlink by where it really points, and returns the real path", () => {
    const result = list().check(join(root, "alias-to-app"));
    expect(result).toEqual({ ok: true, path: app });
  });

  it("denies relative paths, files and folders that do not exist", () => {
    const l = list();
    expect(l.check("app").ok).toBe(false);
    expect(l.check("./code/app").ok).toBe(false);
    expect(l.check(file).ok).toBe(false);
    expect(l.check(join(app, "missing")).ok).toBe(false);
    expect(l.check("").ok).toBe(false);
  });

  it("refuses to allow bad roots", () => {
    const l = new ProjectAllowlist();
    expect(() => l.add("/")).toThrow(/root/);
    expect(() => l.add("relative/path")).toThrow();
    expect(() => l.add(join(root, "missing"))).toThrow();
    expect(() => l.add(file)).toThrow();
  });

  it("stores the canonical path, dedupes, removes and persists", () => {
    const file2 = join(dir("state"), "projects.json");
    const l = new ProjectAllowlist(file2);
    const added = l.add(join(root, "alias-to-app")); // via the symlink
    expect(added.path).toBe(app);
    expect(added.name).toBe("app");
    l.add(app);
    expect(l.list()).toHaveLength(1);

    expect(new ProjectAllowlist(file2).list()).toHaveLength(1); // survives a restart
    expect(l.remove(app)).toBe(true);
    expect(l.remove(app)).toBe(false);
    expect(new ProjectAllowlist(file2).list()).toHaveLength(0);
  });
});

describe("remote session.start", () => {
  const fake: AgentPlugin = {
    id: "fake",
    displayName: "Fake",
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
  };

  let relay: FastifyInstance;
  let daemon: Daemon;
  let relayUrl: string;
  const clients: SecureClient[] = [];
  const app = dir("remote", "app");
  const evil = dir("remote", "app-evil");
  const until = async (cond: () => boolean, ms = 4000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    relay = await createRelay();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    relayUrl = `ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    daemon = await startDaemon({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), "airemo-data-")),
      relayUrl,
      registry: new PluginRegistry().register(fake),
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

  const start = (c: { client: SecureClient }, cwd: string) =>
    c.client.send("session.start", { agent: "fake", cwd });
  const lastError = (inbox: Message[]) => inbox.filter((m) => m.type === "error").at(-1);

  it("starts nothing by default", async () => {
    const p = await phone();
    const before = daemon.sessions.list().length;
    start(p, app);
    await until(() => !!lastError(p.inbox));
    const err = lastError(p.inbox);
    expect(err?.type === "error" && err.payload.code).toBe("forbidden_path");
    expect(daemon.sessions.list().length).toBe(before);
  });

  it("does not reveal whether a folder exists", async () => {
    const p = await phone();
    start(p, join(root, "definitely-missing"));
    start(p, evil); // exists but not allowed
    await until(() => p.inbox.filter((m) => m.type === "error").length >= 2);
    const messages = p.inbox.filter((m) => m.type === "error").map((m) => m.payload);
    expect(new Set(messages.map((m) => JSON.stringify(m))).size).toBe(1); // identical answers
  });

  it("starts in an allowed project and in folders inside it, but not elsewhere", async () => {
    daemon.projects.add(app);
    const sub = dir("remote", "app", "web");
    const p = await phone();

    start(p, app);
    await until(() => p.inbox.some((m) => m.type === "session.started"));
    start(p, sub);
    await until(() => p.inbox.filter((m) => m.type === "session.started").length >= 2);

    const errorsBefore = p.inbox.filter((m) => m.type === "error").length;
    start(p, evil);
    start(p, join(app, "..", "app-evil"));
    await until(() => p.inbox.filter((m) => m.type === "error").length >= errorsBefore + 2);
    expect(daemon.sessions.list().filter((s) => s.cwd === evil)).toHaveLength(0);
    for (const s of daemon.sessions.list()) s.stop();
  });

  it("launches in the canonical path, not the path the phone sent", async () => {
    const link = join(root, "remote", "link-to-app");
    symlinkSync(app, link);
    const p = await phone();
    start(p, link);
    await until(() => p.inbox.some((m) => m.type === "session.started"));
    expect(daemon.sessions.list().some((s) => s.cwd === app)).toBe(true);
    expect(daemon.sessions.list().some((s) => s.cwd === link)).toBe(false);
    for (const s of daemon.sessions.list()) s.stop();
  });

  it("tells a phone which projects it can use", async () => {
    const p = await phone();
    p.client.send("project.list", {});
    await until(() => p.inbox.some((m) => m.type === "project.listing"));
    const msg = p.inbox.find((m) => m.type === "project.listing");
    expect(msg?.type === "project.listing" && msg.payload.projects).toEqual([
      { path: app, name: "app" },
    ]);
  });

  it("does not restrict the person at the keyboard (local connection)", async () => {
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
    ws.send(JSON.stringify(createMessage("session.start", { agent: "fake", cwd: evil })));
    expect((await got).type).toBe("session.started");
    ws.close();
    for (const s of daemon.sessions.list()) s.stop();
  });

  it("is managed through the local HTTP API", async () => {
    const api = (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${daemon.port}${path}`, init);
    const json = { "content-type": "application/json" };
    const extra = dir("remote", "extra");

    const bad = await api("/projects", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ path: "relative" }),
    });
    expect(bad.status).toBe(400);
    const ok = await api("/projects", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ path: extra }),
    });
    expect(ok.status).toBe(200);
    expect(
      ((await (await api("/projects")).json()) as { path: string }[]).map((p) => p.path),
    ).toContain(extra);
    expect(
      (await api(`/projects?path=${encodeURIComponent(extra)}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await api(`/projects?path=${encodeURIComponent(extra)}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("keeps the allowlist across daemon restarts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "airemo-persist-"));
    const a = await startDaemon({ port: 0, dataDir });
    a.projects.add(app);
    await a.close();
    const b = await startDaemon({ port: 0, dataDir });
    expect(b.projects.check(app).ok).toBe(true);
    await b.close();
  });
});
