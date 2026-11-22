import { mkdtempSync, statSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingError, SecureClient } from "@airemo/client";
import {
  fromBase64Url,
  generateIdentity,
  type Identity,
  parsePairingUri,
  signRelayChallenge,
} from "@airemo/crypto";
import type { Message } from "@airemo/protocol";
import { createRelay } from "@airemo/relay";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONNECTED_WINDOW_MS } from "./remote.js";
import { type Daemon, startDaemon } from "./server.js";

const tmp = () => mkdtempSync(join(tmpdir(), "airemo-m4-"));
const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let relay: FastifyInstance;
let relayUrl: string;
const tapped: Array<{ from: string; to: string; data: string }> = [];
let daemon: Daemon;
let dataDir: string;
const clients: SecureClient[] = [];

beforeAll(async () => {
  relay = await createRelay({ onFrame: (from, to, data) => tapped.push({ from, to, data }) });
  await relay.listen({ port: 0, host: "127.0.0.1" });
  relayUrl = `ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
  dataDir = tmp();
  daemon = await startDaemon({ port: 0, dataDir, relayUrl });
  await until(() => daemon.remote?.status === "connected");
});

afterAll(async () => {
  for (const c of clients) c.close();
  await daemon.close();
  await relay.close();
});

function newPhone(opts: { identity?: Identity; token?: string; name?: string; daemonId?: string }) {
  const identity = opts.identity ?? generateIdentity();
  const inbox: Message[] = [];
  const client = new SecureClient({
    identity,
    daemonId: opts.daemonId ?? daemon.identity.publicKey,
    relayUrl,
    ...(opts.token ? { token: opts.token } : {}),
    name: opts.name ?? "Test phone",
    timeoutMs: 3000,
  });
  client.on((m) => inbox.push(m));
  clients.push(client);
  return { identity, client, inbox };
}

async function pairedPhone() {
  const { uri } = daemon.remote?.createPairing() ?? { uri: "" };
  const info = parsePairingUri(uri);
  const p = newPhone({ token: info.token });
  await p.client.connect();
  return p;
}

const rawSession = () =>
  daemon.sessions.startRaw("test", process.cwd(), {
    command: "cat",
    args: [],
    env: process.env as Record<string, string>,
    cwd: process.cwd(),
  });

describe("local identity and storage", () => {
  it("keeps the identity private and stable across restarts", async () => {
    expect(statSync(join(dataDir, "identity.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    const again = await startDaemon({ port: 0, dataDir });
    expect(again.identity).toEqual(daemon.identity);
    await again.close();
  });

  it("launches agents in ask-first mode by default", async () => {
    expect(daemon.sessions.requireApproval).toBe(true);
    const off = await startDaemon({ port: 0, dataDir: tmp(), requireApproval: false });
    expect(off.sessions.requireApproval).toBe(false);
    await off.close();
  });
});

describe("pairing", () => {
  it("pairs a new device with a QR token and registers it", async () => {
    const { identity, client } = await pairedPhone();
    expect(client.status).toBe("ready");
    expect(daemon.devices.has(identity.publicKey)).toBe(true);
    expect(daemon.devices.list().find((d) => d.id === identity.publicKey)?.name).toBe("Test phone");
  });

  it("lists a paired device as connected only while it is heard from", async () => {
    const { identity } = await pairedPhone();
    const listed = async () =>
      (
        (await (await fetch(`http://127.0.0.1:${daemon.port}/devices`)).json()) as Array<{
          id: string;
          connected: boolean;
        }>
      ).find((d) => d.id === identity.publicKey);
    expect(await listed()).toMatchObject({ connected: true });
    // A phone that went quiet (closed app, lost network) stops counting as connected.
    const later = Date.now() + CONNECTED_WINDOW_MS + 1;
    expect(daemon.remote?.connectedDevices(later).has(identity.publicKey)).toBe(false);
  });

  it("a pairing token works only once", async () => {
    const { uri } = daemon.remote?.createPairing() ?? { uri: "" };
    const { token } = parsePairingUri(uri);
    const first = newPhone({ token });
    await first.client.connect();
    const second = newPhone({ token });
    await expect(second.client.connect()).rejects.toBeInstanceOf(PairingError);
    expect(daemon.devices.has(second.identity.publicKey)).toBe(false);
  });

  it("rejects an unpaired device that has no token", async () => {
    const stranger = newPhone({});
    await expect(stranger.client.connect()).rejects.toBeInstanceOf(PairingError);
  });

  it("rejects an expired token", async () => {
    const t = daemon.remote?.tokens.issue(1);
    await new Promise((r) => setTimeout(r, 20));
    const p = newPhone({ token: t?.token ?? "" });
    await expect(p.client.connect()).rejects.toBeInstanceOf(PairingError);
  });

  it("lets a paired device reconnect later without a token", async () => {
    const { identity, client } = await pairedPhone();
    client.close();
    const again = newPhone({ identity });
    await again.client.connect();
    expect(again.client.status).toBe("ready");
  });

  it("exposes the pairing endpoint locally and returns a usable code", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/pairing`, { method: "POST" });
    const body = (await res.json()) as { uri: string; daemonId: string };
    const info = parsePairingUri(body.uri);
    expect(info.daemonId).toBe(daemon.identity.publicKey);
    expect(info.relayUrl).toBe(`${relayUrl}/connect`);
    expect(body.daemonId).toBe(daemon.identity.publicKey);
  });

  it("reports that pairing is unavailable without a relay", async () => {
    const local = await startDaemon({ port: 0, dataDir: tmp() });
    const res = await fetch(`http://127.0.0.1:${local.port}/pairing`, { method: "POST" });
    expect(res.status).toBe(409);
    await local.close();
  });
});

describe("remote control over the relay", () => {
  it("streams output, accepts prompts and never exposes plaintext to the relay", async () => {
    const { client, inbox } = await pairedPhone();
    const s = rawSession();
    client.send("session.attach", {}, s.id);
    await until(() => inbox.some((m) => m.type === "terminal.snapshot"));

    const marker = "TOP-SECRET-PROMPT-7f3a";
    const before = tapped.length;
    client.send("prompt.send", { text: marker }, s.id);
    await until(() =>
      inbox.some((m) => m.type === "terminal.output" && m.payload.data.includes(marker)),
    );

    // Everything the relay forwarded for this exchange is ciphertext.
    const forwarded = tapped.slice(before);
    expect(forwarded.length).toBeGreaterThan(0);
    for (const f of forwarded) {
      expect(f.data).not.toContain(marker);
      expect(Buffer.from(fromBase64Url(f.data)).toString("latin1")).not.toContain(marker);
    }
    s.stop();
  });

  it("shows the exact command and applies a remote approval", async () => {
    const { client, inbox } = await pairedPhone();
    const s = rawSession();
    client.send("session.attach", {}, s.id);
    await until(() => inbox.some((m) => m.type === "terminal.snapshot"));

    const pending = fetch(`http://127.0.0.1:${daemon.port}/hooks/permission`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-airemo-token": daemon.hookToken },
      body: JSON.stringify({ sessionId: s.id, tool: "Bash", command: "rm -rf build" }),
    });
    await until(() => inbox.some((m) => m.type === "permission.request"));
    const req = inbox.find((m) => m.type === "permission.request");
    if (req?.type !== "permission.request") throw new Error("unreachable");
    expect(req.payload.command).toBe("rm -rf build");

    client.send("permission.decision", { requestId: req.payload.requestId, decision: "deny" });
    expect(await (await pending).json()).toMatchObject({ decision: "deny" });

    // The same decision cannot be applied twice.
    client.send("permission.decision", { requestId: req.payload.requestId, decision: "allow" });
    await until(() => inbox.some((m) => m.type === "error" && m.payload.code === "no_request"));
    s.stop();
  });

  it("drops replayed frames", async () => {
    const phone = await pairedPhone();
    const s = rawSession();
    phone.client.send("session.attach", {}, s.id);
    await until(() => phone.inbox.some((m) => m.type === "terminal.snapshot"));

    const marker = "REPLAY-MARKER-91";
    const count = () => s.snapshot().data.split(marker).length - 1;
    const mark = tapped.length;
    phone.client.send("prompt.send", { text: marker }, s.id);
    await until(() => count() >= 1);
    await new Promise((r) => setTimeout(r, 400));
    const afterFirst = count();
    const captured = tapped.slice(mark).find((f) => f.from === phone.identity.publicKey);
    expect(captured).toBeTruthy();

    // A network attacker replays the captured ciphertext.
    const replayer = new WebSocket(`${relayUrl}/connect`);
    await new Promise<void>((resolve) => {
      replayer.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === "challenge") {
          replayer.send(
            JSON.stringify({
              type: "auth",
              id: phone.identity.publicKey,
              sig: signRelayChallenge(phone.identity, m.nonce),
            }),
          );
        } else if (m.type === "ready") resolve();
      };
    });
    replayer.send(JSON.stringify({ to: daemon.identity.publicKey, data: captured?.data }));
    await new Promise((r) => setTimeout(r, 500));
    expect(count()).toBe(afterFirst);
    replayer.close();
    s.stop();
  });

  it("stops serving a device as soon as it is revoked", async () => {
    const { identity, client, inbox } = await pairedPhone();
    const s = rawSession();
    client.send("session.attach", {}, s.id);
    await until(() => inbox.some((m) => m.type === "terminal.snapshot"));

    expect(daemon.devices.remove(identity.publicKey)).toBe(true);
    const before = inbox.length;
    client.send("session.list", {});
    await new Promise((r) => setTimeout(r, 400));
    expect(inbox.length).toBe(before); // no reply

    const again = newPhone({ identity });
    await expect(again.client.connect()).rejects.toBeInstanceOf(PairingError);
    s.stop();
  });

  it("revokes through the local API", async () => {
    const { identity } = await pairedPhone();
    const res = await fetch(`http://127.0.0.1:${daemon.port}/devices/${identity.publicKey}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(daemon.devices.has(identity.publicKey)).toBe(false);
    const again = await fetch(`http://127.0.0.1:${daemon.port}/devices/${identity.publicKey}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });
});

describe("local daemon hardening", () => {
  const raw = (headers: Record<string, string>, path = "/status") =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: daemon.port, path, method: "GET", headers },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("refuses requests whose Host is not loopback (DNS rebinding)", async () => {
    expect(await raw({ host: "evil.example.com" })).toBe(403);
    expect(await raw({ host: `127.0.0.1:${daemon.port}` })).toBe(200);
  });

  /** Send a raw WebSocket upgrade request and return the HTTP status line the server answers with. */
  const probeUpgrade = (extraHeaders: string) =>
    new Promise<string>((resolve) => {
      const sock = connect(daemon.port, "127.0.0.1", () => {
        sock.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${daemon.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extraHeaders}\r\n`,
        );
      });
      let buf = "";
      sock.on("data", (c) => {
        buf += c;
        sock.destroy();
      });
      sock.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
      sock.on("error", () => resolve("error"));
    });

  it("refuses browser origins, including WebSocket upgrades from web pages", async () => {
    expect(await raw({ origin: "https://evil.example.com" })).toBe(403);
    expect(await probeUpgrade("Origin: https://evil.example.com\r\n")).toContain("403");
    // A non-browser client (no Origin header) still connects.
    expect(await probeUpgrade("")).toContain("101");
  });

  it("refuses a WebSocket upgrade with a rebinding Host", async () => {
    const status = await new Promise<string>((resolve) => {
      const sock = connect(daemon.port, "127.0.0.1", () => {
        sock.write(
          "GET /ws HTTP/1.1\r\nHost: evil.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      let buf = "";
      sock.on("data", (c) => {
        buf += c;
        sock.destroy();
      });
      sock.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
    });
    expect(status).toContain("403");
  });

  it("allows only origins that were explicitly configured", async () => {
    const d = await startDaemon({
      port: 0,
      dataDir: tmp(),
      allowedOrigins: ["http://localhost:5173"],
    });
    const status = (origin: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: d.port, path: "/status", headers: { origin } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect(await status("http://localhost:5173")).toBe(200);
    expect(await status("http://localhost:9999")).toBe(403);
    await d.close();
  });
});
