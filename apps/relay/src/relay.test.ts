import type { Identity } from "@airemo/crypto";
import { generateIdentity, signRelayChallenge } from "@airemo/crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay } from "./index.js";

let app: FastifyInstance;
let port: number;
const tapped: Array<{ from: string; to: string; data: string }> = [];

beforeAll(async () => {
  app = await createRelay({
    onFrame: (from, to, data) => tapped.push({ from, to, data }),
    authTimeoutMs: 300,
    rateLimit: { burst: 5, perSecond: 1 },
    maxFrameBytes: 2000,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});
afterAll(() => app.close());

interface Dev {
  ws: WebSocket;
  inbox: Record<string, unknown>[];
  next: (p: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

function raw(): Dev {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect`);
  const inbox: Record<string, unknown>[] = [];
  const waiters: Array<{
    p: (m: Record<string, unknown>) => boolean;
    res: (m: Record<string, unknown>) => void;
  }> = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    inbox.push(m);
    for (const w of [...waiters]) {
      if (w.p(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(m);
      }
    }
  };
  const closed = new Promise<number>((res) => {
    ws.onclose = (e) => res(e.code);
  });
  const next = (p: (m: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      const hit = inbox.find(p);
      if (hit) return res(hit);
      waiters.push({ p, res });
      setTimeout(() => rej(new Error("timeout")), 3000);
    });
  return { ws, inbox, next, closed };
}

async function authed(id: Identity): Promise<Dev> {
  const d = raw();
  const ch = await d.next((m) => m.type === "challenge");
  d.ws.send(
    JSON.stringify({
      type: "auth",
      id: id.publicKey,
      sig: signRelayChallenge(id, String(ch.nonce)),
    }),
  );
  await d.next((m) => m.type === "ready");
  return d;
}

describe("relay", () => {
  it("forwards opaque frames and stamps the verified sender", async () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const da = await authed(a);
    const db = await authed(b);
    da.ws.send(JSON.stringify({ to: b.publicKey, data: "ciphertext==" }));
    const got = await db.next((m) => "from" in m);
    expect(got).toEqual({ from: a.publicKey, data: "ciphertext==" });
    da.ws.close();
    db.ws.close();
  });

  it("refuses a device that cannot prove it owns the ID", async () => {
    const victim = generateIdentity();
    const attacker = generateIdentity();
    const d = raw();
    const ch = await d.next((m) => m.type === "challenge");
    // Claims the victim's ID but signs with its own key.
    d.ws.send(
      JSON.stringify({
        type: "auth",
        id: victim.publicKey,
        sig: signRelayChallenge(attacker, String(ch.nonce)),
      }),
    );
    expect(await d.closed).toBe(1008);
  });

  it("refuses a replayed signature from an earlier challenge", async () => {
    const id = generateIdentity();
    const first = raw();
    const ch1 = await first.next((m) => m.type === "challenge");
    const oldSig = signRelayChallenge(id, String(ch1.nonce));
    first.ws.close();
    const second = raw();
    await second.next((m) => m.type === "challenge");
    second.ws.send(JSON.stringify({ type: "auth", id: id.publicKey, sig: oldSig }));
    expect(await second.closed).toBe(1008);
  });

  it("closes connections that never authenticate", async () => {
    const d = raw();
    expect(await d.closed).toBe(1008);
  });

  it("reports an unreachable recipient", async () => {
    const a = await authed(generateIdentity());
    a.ws.send(JSON.stringify({ to: "nobody", data: "x" }));
    expect(await a.next((m) => m.type === "undeliverable")).toMatchObject({ to: "nobody" });
    a.ws.close();
  });

  it("rate limits a chatty device", async () => {
    const a = await authed(generateIdentity());
    for (let i = 0; i < 12; i++) a.ws.send(JSON.stringify({ to: "nobody", data: "x" }));
    expect(await a.next((m) => m.code === "rate_limited")).toBeTruthy();
    a.ws.close();
  });

  it("rejects oversized frames", async () => {
    const a = await authed(generateIdentity());
    a.ws.send(JSON.stringify({ to: "x", data: "y".repeat(5000) }));
    expect(await a.closed).toBe(1009);
  });
});

describe("relay heartbeat", () => {
  it("drops a socket that stops answering pings, keeps one that answers", async () => {
    const { connect } = await import("node:net");
    const hb = await createRelay({ heartbeatMs: 100 });
    await hb.listen({ port: 0, host: "127.0.0.1" });
    const hbPort = (hb.server.address() as { port: number }).port;
    try {
      // A healthy client: the WebSocket implementation answers pings by itself.
      const healthy = new WebSocket(`ws://127.0.0.1:${hbPort}/connect`);
      let healthyClosed = false;
      healthy.onclose = () => {
        healthyClosed = true;
      };
      // A dead peer: completes the upgrade, then never reads or answers (like a sleeping laptop).
      const dead = connect(hbPort, "127.0.0.1");
      dead.write(
        "GET /connect HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
      dead.on("data", () => {});
      const deadClosed = new Promise<void>((res) => dead.on("close", () => res()));
      await deadClosed;
      expect(healthyClosed).toBe(false);
      healthy.close();
    } finally {
      await hb.close();
    }
  });
});
