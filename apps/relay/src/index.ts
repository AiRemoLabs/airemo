import { randomBytes } from "node:crypto";
import { toBase64Url, verifyRelayChallenge } from "@airemo/crypto";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

/**
 * Zero-trust relay: forwards opaque frames between authenticated devices by device ID.
 * It never inspects, decrypts or stores payloads. Content is end-to-end encrypted between
 * the devices (Noise), so a compromised relay can drop or delay traffic but cannot read,
 * forge or replay it.
 *
 * Connect:  GET /connect  (WebSocket)
 *   relay  -> { type: "challenge", nonce }
 *   device -> { type: "auth", id, sig }     id = Ed25519 public key (base64url), sig signs the nonce
 *   relay  -> { type: "ready" }
 * Frames:   device -> { to, data }          data is an opaque string
 *           recipient gets { from, data }   `from` is the relay-verified sender ID
 *           sender gets { type: "undeliverable", to } if the recipient is not connected
 * Liveness: the relay sends WebSocket pings and closes a socket that misses one, so a device that
 * vanished (slept, lost its network) is dropped and senders get "undeliverable" instead of frames
 * going into a dead socket. Devices check their own side by sending a frame to their own ID.
 */
export interface RelayOptions {
  logger?: boolean;
  /** Largest accepted WebSocket message, in bytes. */
  maxFrameBytes?: number;
  /** Max simultaneously connected devices. */
  maxDevices?: number;
  /** Seconds a new connection has to authenticate. */
  authTimeoutMs?: number;
  /** WebSocket ping interval; a socket that has not answered the previous ping is closed. 0 = off. */
  heartbeatMs?: number;
  /** Per-connection token bucket. */
  rateLimit?: { burst: number; perSecond: number };
  /** Observe forwarded frames (tests, metrics). Must never log payloads in production. */
  onFrame?: (from: string, to: string, data: string) => void;
}

const MAX_ID_LENGTH = 64;

export async function createRelay(opts: RelayOptions = {}): Promise<FastifyInstance> {
  const maxFrameBytes = opts.maxFrameBytes ?? 1_000_000;
  const maxDevices = opts.maxDevices ?? 1000;
  const authTimeoutMs = opts.authTimeoutMs ?? 5000;
  const rate = opts.rateLimit ?? { burst: 500, perSecond: 200 };

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(fastifyWebsocket, { options: { maxPayload: maxFrameBytes } });

  const devices = new Map<string, WebSocket>();

  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const alive = new WeakMap<WebSocket, boolean>();
  const sockets = new Set<WebSocket>();
  if (heartbeatMs > 0) {
    const beat = setInterval(() => {
      for (const s of sockets) {
        if (alive.get(s) === false) {
          s.terminate();
          continue;
        }
        alive.set(s, false);
        try {
          s.ping();
        } catch {}
      }
    }, heartbeatMs);
    beat.unref();
    app.addHook("onClose", async () => clearInterval(beat));
  }

  app.get("/health", async () => ({ ok: true, devices: devices.size }));

  app.get("/connect", { websocket: true }, (socket) => {
    const nonce = toBase64Url(randomBytes(24));
    let deviceId: string | null = null;
    let tokens = rate.burst;
    let last = Date.now();
    let violations = 0;

    const reply = (obj: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    const timer = setTimeout(() => {
      if (!deviceId) socket.close(1008, "auth timeout");
    }, authTimeoutMs);

    sockets.add(socket);
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));

    socket.send(JSON.stringify({ type: "challenge", nonce }));

    socket.on("message", (raw: Buffer) => {
      alive.set(socket, true);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!deviceId) {
        const { type, id, sig } = msg;
        if (
          type !== "auth" ||
          typeof id !== "string" ||
          typeof sig !== "string" ||
          id.length > MAX_ID_LENGTH ||
          !verifyRelayChallenge(id, nonce, sig)
        ) {
          return socket.close(1008, "auth failed");
        }
        if (!devices.has(id) && devices.size >= maxDevices) {
          return socket.close(1013, "relay full");
        }
        clearTimeout(timer);
        devices.get(id)?.close(1000, "replaced");
        deviceId = id;
        devices.set(id, socket);
        return reply({ type: "ready" });
      }

      // Token bucket.
      const now = Date.now();
      tokens = Math.min(rate.burst, tokens + ((now - last) / 1000) * rate.perSecond);
      last = now;
      if (tokens < 1) {
        reply({ type: "error", code: "rate_limited" });
        if (++violations > 100) socket.close(1008, "rate limit");
        return;
      }
      tokens -= 1;

      const { to, data } = msg;
      if (typeof to !== "string" || typeof data !== "string" || to.length > MAX_ID_LENGTH) return;
      const target = devices.get(to);
      if (!target) return reply({ type: "undeliverable", to });
      opts.onFrame?.(deviceId, to, data);
      target.send(JSON.stringify({ from: deviceId, data }));
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearTimeout(timer);
      if (deviceId && devices.get(deviceId) === socket) devices.delete(deviceId);
    });
  });

  return app;
}
