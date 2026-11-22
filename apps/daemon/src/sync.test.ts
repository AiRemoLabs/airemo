import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecureClient } from "@airemo/client";
import { generateIdentity, parsePairingUri } from "@airemo/crypto";
import { createMessage, type Message, parseMessage } from "@airemo/protocol";
import { createRelay } from "@airemo/relay";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./server.js";

const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("keeping every connected device in step", () => {
  let daemon: Daemon;
  let relay: Awaited<ReturnType<typeof createRelay>>;
  let relayUrl: string;
  const closers: Array<() => void> = [];

  beforeAll(async () => {
    relay = await createRelay();
    await relay.listen({ port: 0, host: "127.0.0.1" });
    relayUrl = `ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
    daemon = await startDaemon({
      port: 0,
      dataDir: mkdtempSync(join(tmpdir(), "airemo-sync-")),
      relayUrl,
    });
    await until(() => daemon.remote?.status === "connected");
  });
  afterAll(async () => {
    for (const c of closers) c();
    await daemon.close();
    await relay.close();
  });

  function local() {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
    const inbox: Message[] = [];
    ws.onmessage = (ev) => inbox.push(parseMessage(JSON.parse(String(ev.data))));
    closers.push(() => ws.close());
    const ready = new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    const send = (type: Parameters<typeof createMessage>[0], payload: never, sessionId?: string) =>
      ws.send(JSON.stringify(createMessage(type, payload, sessionId ? { sessionId } : {})));
    return { ws, inbox, ready, send };
  }

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
    closers.push(() => client.close());
    await client.connect();
    return { client, inbox };
  }

  const spec = {
    command: "cat",
    args: [] as string[],
    env: process.env as Record<string, string>,
    cwd: process.cwd(),
  };
  const listings = (inbox: Message[]) => inbox.filter((m) => m.type === "session.listing");
  const lastListing = (inbox: Message[]) => {
    const l = listings(inbox).at(-1);
    return l?.type === "session.listing" ? l.payload.sessions : [];
  };

  describe("the session list is pushed, not polled", () => {
    it("tells a connected client at once when a session starts, without being asked", async () => {
      const c = local();
      await c.ready;
      const before = listings(c.inbox).length;
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      await until(() => listings(c.inbox).length > before);
      expect(lastListing(c.inbox).some((x) => x.id === s.id && x.status !== "exited")).toBe(true);
      s.stop();
    });

    it("tells it when a session changes state, and when it ends", async () => {
      const c = local();
      await c.ready;
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      await until(() => lastListing(c.inbox).some((x) => x.id === s.id));

      s.setStatus("awaiting_approval");
      await until(
        () => lastListing(c.inbox).find((x) => x.id === s.id)?.status === "awaiting_approval",
      );

      s.stop();
      await until(() => lastListing(c.inbox).find((x) => x.id === s.id)?.status === "exited");
    });

    it("reaches a paired phone over the relay too", async () => {
      const p = await phone();
      const before = listings(p.inbox).length;
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      await until(() => listings(p.inbox).length > before);
      expect(lastListing(p.inbox).some((x) => x.id === s.id)).toBe(true);
      s.stop();
    });

    it("stops sending to a client that has gone", async () => {
      const c = local();
      await c.ready;
      c.ws.close();
      await pause(100);
      const seen = listings(c.inbox).length;
      const s = daemon.sessions.startRaw("test", process.cwd(), spec); // must not throw
      await pause(150);
      expect(listings(c.inbox).length).toBe(seen);
      s.stop();
    });

    it("answers an explicit request the same way as before", async () => {
      const c = local();
      await c.ready;
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      c.send("session.list", {} as never);
      await until(() => lastListing(c.inbox).some((x) => x.id === s.id));
      s.stop();
    });
  });

  describe("everyone attached follows a resize", () => {
    it("sends the new size to every attached client when one of them resizes", async () => {
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      const a = local();
      const b = local();
      await Promise.all([a.ready, b.ready]);
      a.send("session.attach", {} as never, s.id);
      b.send("session.attach", {} as never, s.id);
      await until(
        () =>
          a.inbox.some((m) => m.type === "terminal.snapshot") &&
          b.inbox.some((m) => m.type === "terminal.snapshot"),
      );

      a.send("terminal.resize", { cols: 70, rows: 20 } as never, s.id);
      for (const c of [a, b]) {
        await until(() => c.inbox.some((m) => m.type === "terminal.resized"));
        const ev = c.inbox.find((m) => m.type === "terminal.resized");
        expect(ev?.type === "terminal.resized" && ev.payload).toEqual({ cols: 70, rows: 20 });
        expect(ev?.sessionId).toBe(s.id);
      }
      expect(s.snapshot()).toMatchObject({ cols: 70, rows: 20 });
      s.stop();
    });

    it("tells a paired phone, so its terminal does not draw at the old size", async () => {
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      const p = await phone();
      p.client.send("session.attach", {}, s.id);
      await until(() => p.inbox.some((m) => m.type === "terminal.snapshot"));

      const pc = local(); // someone at the computer resizes their window
      await pc.ready;
      pc.send("terminal.resize", { cols: 88, rows: 25 } as never, s.id);
      await until(() => p.inbox.some((m) => m.type === "terminal.resized"));
      const ev = p.inbox.find((m) => m.type === "terminal.resized");
      expect(ev?.type === "terminal.resized" && ev.payload).toEqual({ cols: 88, rows: 25 });
      s.stop();
    });

    it("applies a paired phone's resize and tells the computer's terminal too", async () => {
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      const p = await phone();
      p.client.send("session.attach", {}, s.id);
      await until(() => p.inbox.some((m) => m.type === "terminal.snapshot"));
      const pc = local();
      await pc.ready;
      pc.send("session.attach", {} as never, s.id);
      await until(() => pc.inbox.some((m) => m.type === "terminal.snapshot"));

      p.client.send("terminal.resize", { cols: 40, rows: 12 }, s.id);
      await until(() => pc.inbox.some((m) => m.type === "terminal.resized"));
      const ev = pc.inbox.find((m) => m.type === "terminal.resized");
      expect(ev?.type === "terminal.resized" && ev.payload).toEqual({ cols: 40, rows: 12 });
      expect(s.snapshot()).toMatchObject({ cols: 40, rows: 12 });
      s.stop();
    });

    it("does not announce a resize that changed nothing", async () => {
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      const c = local();
      await c.ready;
      c.send("session.attach", {} as never, s.id);
      await until(() => c.inbox.some((m) => m.type === "terminal.snapshot"));
      const { cols, rows } = s.snapshot();
      c.send("terminal.resize", { cols, rows } as never, s.id);
      await pause(200);
      expect(c.inbox.filter((m) => m.type === "terminal.resized")).toHaveLength(0);
      s.stop();
    });

    it("only tells clients attached to that session", async () => {
      const s1 = daemon.sessions.startRaw("test", process.cwd(), spec);
      const s2 = daemon.sessions.startRaw("test", process.cwd(), spec);
      const onS1 = local();
      const onS2 = local();
      await Promise.all([onS1.ready, onS2.ready]);
      onS1.send("session.attach", {} as never, s1.id);
      onS2.send("session.attach", {} as never, s2.id);
      await until(
        () =>
          onS1.inbox.some((m) => m.type === "terminal.snapshot") &&
          onS2.inbox.some((m) => m.type === "terminal.snapshot"),
      );
      onS1.send("terminal.resize", { cols: 66, rows: 18 } as never, s1.id);
      await until(() => onS1.inbox.some((m) => m.type === "terminal.resized"));
      await pause(150);
      expect(onS2.inbox.filter((m) => m.type === "terminal.resized")).toHaveLength(0);
      s1.stop();
      s2.stop();
    });
  });

  describe("GET /sessions (for `airemo sessions` and `airemo attach`)", () => {
    it("lists the sessions with their state", async () => {
      const s = daemon.sessions.startRaw("test", process.cwd(), spec);
      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions`);
      const list = (await res.json()) as Array<{
        id: string;
        agent: string;
        cwd: string;
        status: string;
      }>;
      expect(list.find((x) => x.id === s.id)).toEqual({
        id: s.id,
        agent: "test",
        cwd: process.cwd(),
        status: "running",
      });
      s.stop();
    });

    it("is closed to web pages, like the rest of the local API", async () => {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/sessions`, {
        headers: { origin: "https://evil.example.com" },
      });
      expect(res.status).toBe(403);
    });
  });
});
