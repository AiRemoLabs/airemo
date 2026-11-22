import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecureClient } from "@airemo/client";
import { generateIdentity, parsePairingUri } from "@airemo/crypto";
import { type Daemon, startDaemon } from "@airemo/daemon";
import { type AgentPlugin, PluginRegistry } from "@airemo/plugin-sdk";
import type { Message } from "@airemo/protocol";
import { createRelay } from "@airemo/relay";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  findJoinable,
  type RunInput,
  type RunOutput,
  runSession,
  type SessionSummary,
} from "./run.js";
import { chooseSession, fetchSessions, formatSession, shortId } from "./sessions-command.js";

const until = async (cond: () => boolean, ms = 6000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Kbd extends EventEmitter implements RunInput {
  rawModes: boolean[] = [];
  constructor(public isTTY = true) {
    super();
  }
  setRawMode(raw: boolean) {
    this.rawModes.push(raw);
  }
  resume() {}
  pause() {}
  type(text: string) {
    this.emit("data", Buffer.from(text));
  }
}
class Screen extends EventEmitter implements RunOutput {
  text = "";
  columns = 100;
  rows = 30;
  write(t: string) {
    this.text += t;
    return true;
  }
}

describe("findJoinable", () => {
  const sessions: SessionSummary[] = [
    { id: "a", agent: "claude-code", cwd: "/work/app", status: "running" },
    { id: "b", agent: "cursor", cwd: "/work/app", status: "running" },
    { id: "c", agent: "claude-code", cwd: "/work/other", status: "running" },
    { id: "d", agent: "claude-code", cwd: "/work/app", status: "exited" },
    { id: "e", agent: "claude-code", cwd: "/work/app", status: "awaiting_approval" },
  ];
  const same = (p: string) => p; // no symlinks in these paths

  it("finds running sessions of the same agent in the same folder only", () => {
    expect(findJoinable(sessions, "claude-code", "/work/app", same).map((s) => s.id)).toEqual([
      "a",
      "e",
    ]);
    expect(findJoinable(sessions, "cursor", "/work/app", same).map((s) => s.id)).toEqual(["b"]);
    expect(findJoinable(sessions, "claude-code", "/nowhere", same)).toEqual([]);
  });

  it("compares real paths, so a symlinked folder still matches", () => {
    const canon = (p: string) => (p === "/tmp/app" ? "/private/tmp/app" : p);
    const list = [{ id: "x", agent: "cursor", cwd: "/private/tmp/app", status: "running" }];
    expect(findJoinable(list, "cursor", "/tmp/app", canon)).toHaveLength(1);
  });
});

describe("sessions-command", () => {
  const list: SessionSummary[] = [
    { id: "aaaa1111-0000", agent: "claude-code", cwd: "/work/app", status: "running" },
    { id: "bbbb2222-0000", agent: "cursor", cwd: "/work/web", status: "running" },
    { id: "aaaa9999-0000", agent: "cursor", cwd: "/work/old", status: "exited" },
  ];
  const noAsk = { interactive: false, ask: async () => "" };

  it("formats a session on one line with a short id", () => {
    expect(shortId("aaaa1111-0000")).toBe("aaaa1111");
    const line = formatSession(list[0] as SessionSummary);
    expect(line).toContain("aaaa1111");
    expect(line).toContain("Claude Code");
    expect(line).toContain("app");
    expect(line).toContain("running");
  });

  it("fetches sessions, and says null when the daemon is not there", async () => {
    const ok = (async () => ({ json: async () => list })) as unknown as typeof fetch;
    expect(await fetchSessions(1, ok)).toEqual(list);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchSessions(1, down)).toBeNull();
  });

  it("joins the session whose id starts with what was typed", async () => {
    expect(await chooseSession("bbbb", list, noAsk)).toEqual({ ok: true, session: list[1] });
    expect(await chooseSession("aaaa1111-0000", list, noAsk)).toEqual({
      ok: true,
      session: list[0],
    });
  });

  it("refuses an unknown or ambiguous id, and ignores sessions that have ended", async () => {
    expect((await chooseSession("zzzz", list, noAsk)).ok).toBe(false);
    expect((await chooseSession("aaaa9999", list, noAsk)).ok).toBe(false); // that one has exited
    const two = [...list, { id: "aaaa1111-1111", agent: "cursor", cwd: "/x", status: "running" }];
    const r = await chooseSession("aaaa1111", two, noAsk);
    expect(!r.ok && r.message).toMatch(/more than one/);
  });

  it("with no id: the only running session, an explanation for none, a choice for several", async () => {
    const one = [list[0] as SessionSummary, list[2] as SessionSummary];
    expect(await chooseSession(undefined, one, noAsk)).toEqual({ ok: true, session: list[0] });

    const none = await chooseSession(undefined, [list[2] as SessionSummary], noAsk);
    expect(!none.ok && none.message).toMatch(/No running sessions/);

    const asked: string[] = [];
    const picked = await chooseSession(undefined, list, {
      interactive: true,
      ask: async (q) => {
        asked.push(q);
        return "2";
      },
    });
    expect(picked).toEqual({ ok: true, session: list[1] });
    expect(asked[0]).toContain("1)");
    expect(asked[0]).toContain("2)");
    expect(asked[0]).not.toContain("3)"); // the ended one is not offered
  });

  it("without a terminal, several sessions mean the person has to say which", async () => {
    const r = await chooseSession(undefined, list, noAsk);
    expect(!r.ok && r.message).toMatch(/airemo attach <id>/);
    expect(!r.ok && r.message).toContain("aaaa1111");
  });

  it("gives up after three bad answers", async () => {
    const answers = ["x", "9", "0"];
    const r = await chooseSession(undefined, list, {
      interactive: true,
      ask: async () => answers.shift() ?? "",
    });
    expect(r).toEqual({ ok: false, message: "No session chosen." });
  });
});

describe("one session, a computer terminal and a phone, both ways", () => {
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

  let daemon: Daemon;
  let relay: Awaited<ReturnType<typeof createRelay>>;
  let relayUrl: string;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airemo-sync-")));
  const folder = (name: string) => {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const clients: SecureClient[] = [];
  const running: Array<Promise<number>> = [];

  beforeAll(async () => {
    relay = await createRelay();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    relayUrl = `ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    daemon = await startDaemon({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), "airemo-sync-d-")),
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
  afterEach(async () => {
    for (const s of daemon.sessions.list()) s.stop();
    await Promise.allSettled(running.splice(0));
  });

  async function phone(cwd: string) {
    daemon.projects.add(cwd);
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
    // What the app's terminal view shows: the screen from the snapshot, then every update.
    let view = "";
    let size = { cols: 0, rows: 0 };
    client.on((m) => {
      if (m.type === "terminal.snapshot") {
        view = m.payload.data;
        size = { cols: m.payload.cols, rows: m.payload.rows };
      }
      if (m.type === "terminal.output") view += m.payload.data;
      if (m.type === "terminal.resized") size = { cols: m.payload.cols, rows: m.payload.rows };
    });
    return { client, inbox, view: () => view, size: () => size };
  }

  const pc = (opts: Partial<Parameters<typeof runSession>[0]> & { cwd: string }, tty = true) => {
    const stdin = new Kbd(tty);
    const stdout = new Screen();
    const done = runSession({
      agent: "fake",
      port: daemon.port,
      stdin,
      stdout,
      armMs: 30,
      ...opts,
    });
    running.push(done);
    return { stdin, stdout, done };
  };

  it("a session started on the PHONE shows up in the computer terminal, and both control it", async () => {
    const cwd = folder("from-phone");
    const p = await phone(cwd);
    p.client.send("session.start", { agent: "fake", cwd });
    await until(() => p.inbox.some((m) => m.type === "session.started"));
    const sid = p.inbox.find((m) => m.type === "session.started")?.sessionId ?? "";

    p.client.send("prompt.send", { text: "typed-on-phone-before-joining" }, sid);
    await until(
      () =>
        daemon.sessions.get(sid)?.screenText().includes("typed-on-phone-before-joining") ?? false,
    );

    // The person at the computer joins that session.
    const term = pc({ cwd, attachTo: sid });
    await until(() => term.stdout.text.includes("typed-on-phone-before-joining")); // sees what already happened

    // Phone -> computer
    p.client.send("prompt.send", { text: "second-from-phone" }, sid);
    await until(() => term.stdout.text.includes("second-from-phone"));

    // Computer -> phone
    await pause(100);
    term.stdin.type("typed-on-the-computer\r");
    await until(() => p.view().includes("typed-on-the-computer"));

    expect(daemon.sessions.list().filter((s) => s.status !== "exited")).toHaveLength(1); // one shared session
  });

  it("a session started on the COMPUTER shows up on the phone, and both control it", async () => {
    const cwd = folder("from-computer");
    const term = pc({ cwd, offerJoin: false });
    await until(() => daemon.sessions.list().some((s) => s.cwd === cwd && s.status !== "exited"));
    const sid = daemon.sessions.list().find((s) => s.cwd === cwd)?.id ?? "";

    const p = await phone(cwd);
    p.client.send("session.list", {}); // what the app does as soon as it connects
    await until(() =>
      p.inbox.some(
        (m) => m.type === "session.listing" && m.payload.sessions.some((s) => s.id === sid),
      ),
    );
    p.client.send("session.attach", {}, sid);

    await pause(100);
    term.stdin.type("typed-on-computer\r");
    await until(() => p.view().includes("typed-on-computer"));

    p.client.send("prompt.send", { text: "typed-on-phone" }, sid);
    await until(() => term.stdout.text.includes("typed-on-phone"));
  });

  it("when the computer window is resized, the phone is told the new size", async () => {
    const cwd = folder("resize");
    const term = pc({ cwd, offerJoin: false });
    await until(() => daemon.sessions.list().some((s) => s.cwd === cwd));
    const sid = daemon.sessions.list().find((s) => s.cwd === cwd)?.id ?? "";
    const p = await phone(cwd);
    p.client.send("session.attach", {}, sid);
    await until(() => p.size().cols === 100);

    term.stdout.columns = 70;
    term.stdout.rows = 20;
    term.stdout.emit("resize");
    await until(() => p.size().cols === 70 && p.size().rows === 20);
    expect(daemon.sessions.get(sid)?.snapshot()).toMatchObject({ cols: 70, rows: 20 });
  });

  describe("airemo run offers to join instead of starting a second copy", () => {
    const startedOnPhone = async (cwd: string) => {
      const p = await phone(cwd);
      p.client.send("session.start", { agent: "fake", cwd });
      await until(() => p.inbox.some((m) => m.type === "session.started"));
      return p.inbox.find((m) => m.type === "session.started")?.sessionId ?? "";
    };
    const count = () => daemon.sessions.list().filter((s) => s.status !== "exited").length;

    it("asks, and joins the running one when you say yes", async () => {
      const cwd = folder("join-yes");
      const sid = await startedOnPhone(cwd);
      const term = pc({ cwd });
      await until(() => term.stdout.text.includes("already running in this folder"));
      expect(term.stdout.text).toContain("fake session is already running");
      expect(term.stdout.text).toContain("[Y/n]");
      term.stdin.type("y\n");
      await until(() => term.stdin.rawModes.includes(true)); // now showing the session
      await pause(100);
      term.stdin.type("joined-and-typing\r");
      await until(
        () => daemon.sessions.get(sid)?.screenText().includes("joined-and-typing") ?? false,
      );
      expect(count()).toBe(1);
    });

    it("treats just pressing Enter as yes", async () => {
      const cwd = folder("join-enter");
      await startedOnPhone(cwd);
      const term = pc({ cwd });
      await until(() => term.stdout.text.includes("[Y/n]"));
      term.stdin.type("\n");
      await until(() => term.stdin.rawModes.includes(true));
      await pause(200);
      expect(count()).toBe(1);
    });

    it("starts a separate session when you say no", async () => {
      const cwd = folder("join-no");
      await startedOnPhone(cwd);
      const term = pc({ cwd });
      await until(() => term.stdout.text.includes("[Y/n]"));
      term.stdin.type("n\n");
      await until(() => count() === 2);
    });

    it("does not ask when nothing is running there, or for another agent or folder", async () => {
      const term = pc({ cwd: folder("join-none") });
      await until(() => count() >= 1);
      await pause(200);
      expect(term.stdout.text).not.toContain("[Y/n]");
    });

    it("does not ask without a terminal: it just starts one", async () => {
      const cwd = folder("join-notty");
      await startedOnPhone(cwd);
      pc({ cwd }, false);
      await until(() => count() === 2);
    });
  });

  it("says so, and gives the terminal back, if the session to join no longer exists", async () => {
    const term = pc({ cwd: folder("gone"), attachTo: "no-such-session" });
    expect(await term.done).toBe(1);
    expect(term.stdout.text).toContain("Unknown session");
    expect(term.stdin.rawModes.at(-1)).toBe(false);
  });
});
