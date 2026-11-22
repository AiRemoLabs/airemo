import {
  FrameKind,
  fromBase64Url,
  type Identity,
  InitiatorHandshake,
  PinMismatchError,
  packFrame,
  relayConnectUrl,
  type SecureChannel,
  signRelayChallenge,
  toBase64Url,
  unpackFrame,
  utf8Decode,
  utf8Encode,
} from "@airemo/crypto";
import { createMessage, type Message, type MessageType, parseMessage } from "@airemo/protocol";

export type SecureStatus =
  | "connecting" // reaching the relay
  | "handshaking" // securing the channel with the computer
  | "ready"
  | "offline" // the computer is not connected to the relay
  | "closed";

export interface SecureClientOptions {
  /** This device's identity. Generate once, store securely, reuse. */
  identity: Identity;
  /** The computer's device ID, pinned from the QR code. */
  daemonId: string;
  relayUrl: string;
  /** Single-use pairing token from the QR code. Only needed the first time. */
  token?: string;
  /** Name shown in the computer's device list. */
  name?: string;
  /** Per-attempt timeout for reaching the relay and finishing the handshake. */
  timeoutMs?: number;
  /** Reconnect backoff bounds in ms. */
  minBackoff?: number;
  maxBackoff?: number;
}

type Listener = (msg: Message) => void;

/** Why a connection can never succeed without user action. */
export class PairingError extends Error {}

/**
 * End-to-end encrypted client for a paired computer, through the relay.
 * It verifies the computer against the pinned key before revealing any pairing token, and
 * reconnects (relay drop, computer restart) by repeating the handshake.
 */
export class SecureClient {
  status: SecureStatus = "connecting";
  /** The computer's name (its hostname), known once the channel is ready. */
  daemonName: string | undefined;
  private ws: WebSocket | null = null;
  private ini: InitiatorHandshake | null = null;
  private channel: SecureChannel | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: SecureStatus) => void>();
  private token: string | undefined;
  private attempt = 0;
  private stopped = false;
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(private o: SecureClientOptions) {
    this.token = o.token;
  }

  /** Resolves once the channel is ready. Rejects if pairing fails or the computer's key does not match. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
      this.stopped = false;
      this.open();
    });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: SecureStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  send<T extends MessageType>(
    type: T,
    payload: Extract<Message, { type: T }>["payload"],
    sessionId?: string,
  ): void {
    if (this.status !== "ready" || !this.channel) throw new Error("Not connected");
    const msg = createMessage(type, payload as never, sessionId ? { sessionId } : {});
    this.sendFrame(packFrame(FrameKind.Data, this.channel.seal(utf8Encode(JSON.stringify(msg)))));
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.setStatus("closed");
  }

  private setStatus(s: SecureStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private clearTimers(): void {
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.attemptTimer = this.retryTimer = null;
  }

  private fail(error: Error): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.setStatus("closed");
    this.settle?.reject(error);
    this.settle = null;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const min = this.o.minBackoff ?? 500;
    const max = this.o.maxBackoff ?? 15_000;
    const delay = Math.min(max, min * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private open(): void {
    if (this.stopped) return;
    this.channel = null;
    this.ini = null;
    this.setStatus("connecting");
    const ws = new WebSocket(relayConnectUrl(this.o.relayUrl));
    this.ws = ws;

    // One overall timeout per attempt (relay unreachable, computer silent, ...).
    this.attemptTimer = setTimeout(() => {
      if (this.status !== "ready") ws.close();
    }, this.o.timeoutMs ?? 10_000);

    ws.onmessage = (ev) => this.onRelayText(ws, String(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.channel = null;
      if (this.attemptTimer) clearTimeout(this.attemptTimer);
      if (this.stopped) return;
      if (this.status === "ready" || this.status === "handshaking") this.setStatus("connecting");
      this.scheduleRetry();
    };
    ws.onerror = () => {
      // onclose follows and drives the retry.
    };
  }

  private startHandshake(): void {
    this.setStatus("handshaking");
    this.ini = new InitiatorHandshake(this.o.identity, this.o.daemonId, {
      ...(this.token ? { token: this.token } : {}),
      ...(this.o.name ? { name: this.o.name } : {}),
    });
    this.sendFrame(this.ini.first());
  }

  private sendFrame(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ to: this.o.daemonId, data: toBase64Url(frame) }));
    }
  }

  private onRelayText(ws: WebSocket, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "challenge" && typeof msg.nonce === "string") {
      ws.send(
        JSON.stringify({
          type: "auth",
          id: this.o.identity.publicKey,
          sig: signRelayChallenge(this.o.identity, msg.nonce),
        }),
      );
    } else if (msg.type === "ready") {
      this.startHandshake();
    } else if (msg.type === "undeliverable") {
      // The computer is not connected to the relay right now.
      this.setStatus("offline");
      ws.close();
    } else if (msg.from === this.o.daemonId && typeof msg.data === "string") {
      try {
        this.onFrame(fromBase64Url(msg.data));
      } catch {
        // Malformed or forged frame: ignore.
      }
    }
  }

  private onFrame(frame: Uint8Array): void {
    const { kind, body } = unpackFrame(frame);

    if (kind === FrameKind.Hs2 && this.ini) {
      try {
        const { reply, channel } = this.ini.second(frame);
        this.channel = channel;
        this.ini = null;
        this.sendFrame(reply);
      } catch (e) {
        // A wrong key means the relay (or someone) is impersonating the computer: never retry.
        if (e instanceof PinMismatchError) this.fail(e);
        else this.ws?.close();
      }
      return;
    }

    if (kind === FrameKind.Reset) {
      // The computer restarted and forgot this session: handshake again.
      this.channel = null;
      this.startHandshake();
      return;
    }

    if (kind === FrameKind.Data && this.channel) {
      let msg: Message;
      try {
        msg = parseMessage(JSON.parse(utf8Decode(this.channel.open(body))));
      } catch {
        return; // forged, replayed or malformed
      }
      if (msg.type === "error" && msg.payload.code === "unauthorized") {
        this.fail(new PairingError("This device is not paired with that computer"));
        return;
      }
      if (msg.type === "pair.accept") {
        this.token = undefined; // single-use, already spent
        this.daemonName = msg.payload.name;
        this.attempt = 0;
        if (this.attemptTimer) clearTimeout(this.attemptTimer);
        this.setStatus("ready");
        this.settle?.resolve();
        this.settle = null;
        return;
      }
      for (const l of this.listeners) l(msg);
    }
  }
}
