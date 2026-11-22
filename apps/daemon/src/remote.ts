import { hostname } from "node:os";
import {
  encodePairingUri,
  FrameKind,
  fromBase64Url,
  type Identity,
  PairingTokenStore,
  packFrame,
  ResponderHandshake,
  relayConnectUrl,
  type SecureChannel,
  signRelayChallenge,
  staticKeyMatchesDeviceId,
  toBase64Url,
  unpackFrame,
  utf8Decode,
  utf8Encode,
} from "@airemo/crypto";
import { createMessage, type Message } from "@airemo/protocol";
import { type Connection, type ConnectionDeps, createConnection } from "./connection.js";
import type { DeviceRegistry, ProjectAllowlist } from "./stores.js";

export type RelayStatus = "disconnected" | "connecting" | "connected";

export interface RemoteHubOptions {
  identity: Identity;
  relayUrl: string;
  registry: DeviceRegistry;
  projects: ProjectAllowlist;
  deps: ConnectionDeps;
  log?: (msg: string) => void;
  /** How long a peer has to finish the handshake. */
  handshakeTimeoutMs?: number;
  /** How often the relay link is checked. See `RemoteHub.tick`. */
  liveness?: { tickMs?: number; probeEveryMs?: number; probeTimeoutMs?: number };
}

type Peer =
  | { state: "handshaking"; hs: ResponderHandshake; timer: NodeJS.Timeout }
  | { state: "ready"; channel: SecureChannel; conn: Connection; lastSeen: number };

/**
 * The relay does not tell us when a phone goes away, so a device counts as connected while its
 * channel is open and it sent something recently. The app asks for updates every 5 s while open.
 */
export const CONNECTED_WINDOW_MS = 20_000;

const MAX_HANDSHAKING = 32;

/** Body of the frame the daemon sends to itself through the relay to prove the link works. */
const PROBE_PREFIX = "airemo-probe.";

/**
 * Keeps the computer connected to the relay and serves paired devices over end-to-end
 * encrypted channels. The relay only ever sees opaque frames and device IDs.
 */
export class RemoteHub {
  status: RelayStatus = "disconnected";
  readonly tokens = new PairingTokenStore();
  private ws: WebSocket | null = null;
  private peers = new Map<string, Peer>();
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private url: string;
  private ticker: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  private lastProbeAt = 0;
  private probe: { id: string; sentAt: number } | null = null;
  private probeSeq = 0;

  constructor(private o: RemoteHubOptions) {
    this.url = relayConnectUrl(o.relayUrl);
    o.registry.onRevoked((id) => this.dropPeer(id));
  }

  get relayUrl(): string {
    return this.url;
  }

  /** IDs of the paired devices with an open channel that were heard from recently. */
  connectedDevices(now = Date.now()): Set<string> {
    const ids = new Set<string>();
    if (this.status !== "connected") return ids;
    for (const [id, p] of this.peers) {
      if (p.state === "ready" && now - p.lastSeen < CONNECTED_WINDOW_MS) ids.add(id);
    }
    return ids;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    const tickMs = this.o.liveness?.tickMs ?? 5_000;
    this.lastTick = Date.now();
    this.ticker = setInterval(() => this.tick(), tickMs);
    this.ticker.unref?.();
  }

  /**
   * Liveness of the relay link. A WebSocket can look open long after it died: after the computer
   * slept, after a network change, or when the relay dropped us without a close the daemon saw.
   * Phones' frames would then vanish silently. So:
   *  - if the wall clock jumped (the computer was asleep, timers were paused), reconnect at once;
   *  - otherwise every `probeEveryMs` send a frame addressed to ourselves. The relay routes it
   *    back only if it still maps our ID to this socket, which is exactly what phones rely on.
   *    It works with any relay version (it is an ordinary frame). No echo within
   *    `probeTimeoutMs` means the link is dead: reconnect.
   */
  private tick(now = Date.now()): void {
    const tickMs = this.o.liveness?.tickMs ?? 5_000;
    const slept = now - this.lastTick > tickMs * 3;
    this.lastTick = now;
    if (this.stopped || this.status !== "connected") return;
    if (slept) {
      this.o.log?.("computer was asleep; reconnecting to relay");
      this.reconnectNow();
      return;
    }
    if (this.probe) {
      if (now - this.probe.sentAt > (this.o.liveness?.probeTimeoutMs ?? 10_000)) {
        this.o.log?.("relay link stopped answering; reconnecting");
        this.reconnectNow();
      }
      return;
    }
    if (now - this.lastProbeAt >= (this.o.liveness?.probeEveryMs ?? 15_000)) {
      const id = `${PROBE_PREFIX}${++this.probeSeq}`;
      this.probe = { id, sentAt: now };
      this.lastProbeAt = now;
      this.ws?.send(JSON.stringify({ to: this.o.identity.publicKey, data: id }));
    }
  }

  /** Abandon the current socket without waiting for a close handshake a dead link never finishes. */
  private reconnectNow(): void {
    const ws = this.ws;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    this.onDisconnected(ws, 0);
  }

  private onDisconnected(ws: WebSocket | null, delay: number): void {
    if (this.ws === ws) this.ws = null;
    this.status = "disconnected";
    this.probe = null;
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.ws?.close();
    this.status = "disconnected";
  }

  /** The QR payload a phone scans to pair. The token is single-use and expires quickly. */
  createPairing(): { uri: string; expiresAt: number } {
    const { token, expiresAt } = this.tokens.issue();
    const uri = encodePairingUri({
      daemonId: this.o.identity.publicKey,
      relayUrl: this.url,
      token,
    });
    return { uri, expiresAt };
  }

  private connect(): void {
    if (this.stopped) return;
    this.status = "connecting";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (ev) => this.onRelayText(String(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onDisconnected(ws, Math.min(30_000, 1000 * 2 ** this.attempt++));
    };
    ws.onerror = () => this.o.log?.("relay connection error");
  }

  private onRelayText(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "challenge" && typeof msg.nonce === "string") {
      this.ws?.send(
        JSON.stringify({
          type: "auth",
          id: this.o.identity.publicKey,
          sig: signRelayChallenge(this.o.identity, msg.nonce),
        }),
      );
    } else if (msg.type === "ready") {
      this.status = "connected";
      this.attempt = 0;
      this.probe = null;
      this.lastProbeAt = Date.now();
      this.o.log?.("connected to relay");
    } else if (typeof msg.from === "string" && typeof msg.data === "string") {
      if (msg.from === this.o.identity.publicKey) {
        // Our own liveness probe came back. Nothing else is ever addressed from us to us.
        if (this.probe?.id === msg.data) this.probe = null;
        return;
      }
      try {
        this.onFrame(msg.from, fromBase64Url(msg.data));
      } catch (e) {
        this.o.log?.(`dropped frame: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private sendFrame(to: string, frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ to, data: toBase64Url(frame) }));
    }
  }

  private dropPeer(id: string): void {
    const p = this.peers.get(id);
    if (!p) return;
    if (p.state === "handshaking") clearTimeout(p.timer);
    else p.conn.close();
    this.peers.delete(id);
  }

  /** `from` is the relay-verified sender ID (it proved possession of that key). */
  private onFrame(from: string, frame: Uint8Array): void {
    const { kind, body } = unpackFrame(frame);

    if (kind === FrameKind.Hs1) {
      this.dropPeer(from);
      const handshaking = [...this.peers.values()].filter((p) => p.state === "handshaking").length;
      if (handshaking >= MAX_HANDSHAKING) return;
      const hs = new ResponderHandshake(this.o.identity);
      const reply = hs.first(frame);
      const timer = setTimeout(() => this.dropPeer(from), this.o.handshakeTimeoutMs ?? 10_000);
      this.peers.set(from, { state: "handshaking", hs, timer });
      this.sendFrame(from, reply);
      return;
    }

    const peer = this.peers.get(from);

    if (kind === FrameKind.Hs3) {
      if (peer?.state !== "handshaking") return;
      clearTimeout(peer.timer);
      this.peers.delete(from);
      const { channel, peerStatic, payload } = peer.hs.third(frame);
      // The relay vouched for `from`; the handshake must prove the same key.
      if (!staticKeyMatchesDeviceId(peerStatic, from)) return;

      let authorized = this.o.registry.has(from);
      if (!authorized && payload.token && this.tokens.consume(payload.token)) {
        this.o.registry.add(from, payload.name ?? "");
        authorized = true;
        this.o.log?.("paired a new device");
      }

      const send = (m: Message) =>
        this.sendFrame(
          from,
          packFrame(FrameKind.Data, channel.seal(utf8Encode(JSON.stringify(m)))),
        );
      if (!authorized) {
        send(createMessage("error", { code: "unauthorized", message: "Device is not paired" }));
        return;
      }
      const conn = createConnection(this.o.deps, send, {
        projects: this.o.projects,
        enforceProjects: true,
      });
      this.peers.set(from, { state: "ready", channel, conn, lastSeen: Date.now() });
      send(
        createMessage("pair.accept", {
          daemonPublicKey: this.o.identity.publicKey,
          name: hostname().slice(0, 100),
        }),
      );
      return;
    }

    if (kind === FrameKind.Data) {
      if (peer?.state !== "ready") {
        this.sendFrame(from, packFrame(FrameKind.Reset, new Uint8Array()));
        return;
      }
      // A revoked device must stop working immediately, even on an open channel.
      if (!this.o.registry.has(from)) {
        this.dropPeer(from);
        return;
      }
      let text: string;
      try {
        text = utf8Decode(peer.channel.open(body));
      } catch {
        return; // forged, tampered or replayed: drop silently
      }
      peer.lastSeen = Date.now();
      void peer.conn.handle(text);
    }
  }
}
