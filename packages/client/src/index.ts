import { createMessage, type Message, type MessageType, parseMessage } from "@airemo/protocol";

type Listener = (msg: Message) => void;

export interface ClientOptions {
  url: string;
  /** Reconnect backoff bounds in ms. */
  minBackoff?: number;
  maxBackoff?: number;
}

/** Reconnecting WebSocket client shared by mobile and web. Encryption is added in M4. */
export class AiremoClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private closed = false;
  private attempt = 0;

  constructor(private opts: ClientOptions) {}

  connect(): void {
    this.closed = false;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = parseMessage(JSON.parse(String(ev.data)));
        for (const l of this.listeners) l(msg);
      } catch {
        // Drop malformed frames.
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      const min = this.opts.minBackoff ?? 500;
      const max = this.opts.maxBackoff ?? 15000;
      const delay = Math.min(max, min * 2 ** this.attempt++);
      setTimeout(() => this.connect(), delay);
    };
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send<T extends MessageType>(
    type: T,
    payload: Extract<Message, { type: T }>["payload"],
    sessionId?: string,
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.ws.send(
      JSON.stringify(createMessage(type, payload as never, sessionId ? { sessionId } : {})),
    );
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

export * from "./secure.js";
