import { generateIdentity } from "@airemo/crypto";
import { PluginRegistry } from "@airemo/plugin-sdk";
import { createRelay } from "@airemo/relay";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionBroker } from "./broker.js";
import { RemoteHub } from "./remote.js";
import { SessionManager } from "./sessions.js";
import { DeviceRegistry, ProjectAllowlist } from "./stores.js";

const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const fast = { tickMs: 50, probeEveryMs: 100, probeTimeoutMs: 200 };
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function hub(relayUrl: string, logs: string[] = []) {
  const identity = generateIdentity();
  const h = new RemoteHub({
    identity,
    relayUrl,
    registry: new DeviceRegistry(),
    projects: new ProjectAllowlist(),
    deps: {
      sessions: new SessionManager(new PluginRegistry()),
      broker: new PermissionBroker(),
    },
    liveness: fast,
    log: (m) => logs.push(m),
  });
  cleanup.push(() => h.stop());
  return { h, identity, logs };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  cleanup.push(() => app.close());
  return `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

/** A relay that authenticates anyone and then forwards nothing: a link that looks open but is dead. */
async function blackHoleRelay() {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  let connections = 0;
  app.get("/connect", { websocket: true }, (socket) => {
    connections++;
    socket.send(JSON.stringify({ type: "challenge", nonce: "n" }));
    socket.on("message", (raw: Buffer) => {
      if (JSON.parse(raw.toString()).type === "auth")
        socket.send(JSON.stringify({ type: "ready" }));
    });
  });
  const url = await listen(app);
  return { url, connections: () => connections };
}

describe("relay liveness", () => {
  it("probes itself through a real relay and stays connected", async () => {
    const tapped: Array<{ from: string; to: string }> = [];
    const url = await listen(
      await createRelay({ onFrame: (from, to) => tapped.push({ from, to }) }),
    );
    const { h, identity, logs } = hub(url);
    h.start();
    await until(() => h.status === "connected");
    await until(() => tapped.filter((t) => t.to === identity.publicKey).length >= 3);
    expect(tapped.every((t) => t.from === identity.publicKey)).toBe(true);
    expect(h.status).toBe("connected");
    expect(logs.filter((l) => l.includes("reconnecting"))).toEqual([]);
  });

  it("reconnects when the link stops answering", async () => {
    const relay = await blackHoleRelay();
    const { h, logs } = hub(relay.url);
    h.start();
    await until(() => relay.connections() >= 2);
    expect(logs.some((l) => l.includes("stopped answering"))).toBe(true);
    await until(() => h.status === "connected");
  });

  it("reconnects at once after the computer slept", async () => {
    const url = await listen(await createRelay());
    const { h, logs } = hub(url);
    h.start();
    await until(() => h.status === "connected");
    // Timers stop while the computer sleeps, so the next tick sees a jump in the wall clock.
    (h as unknown as { tick(now: number): void }).tick(Date.now() + 60_000);
    expect(h.status).toBe("disconnected");
    expect(logs.some((l) => l.includes("was asleep"))).toBe(true);
    await until(() => h.status === "connected");
  });

  it("stops probing after stop()", async () => {
    const relay = await blackHoleRelay();
    const { h } = hub(relay.url);
    h.start();
    await until(() => h.status === "connected");
    h.stop();
    const n = relay.connections();
    await new Promise((r) => setTimeout(r, 500));
    expect(relay.connections()).toBe(n);
  });
});
