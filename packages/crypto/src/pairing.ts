import { randomBytes } from "@noble/hashes/utils.js";
import { toBase64Url } from "./encoding.js";

export interface PairingToken {
  token: string;
  expiresAt: number;
}

export function createPairingToken(ttlMs = 2 * 60 * 1000, now = Date.now()): PairingToken {
  return { token: toBase64Url(randomBytes(24)), expiresAt: now + ttlMs };
}

/** Tracks single-use pairing tokens. */
export class PairingTokenStore {
  private tokens = new Map<string, number>();

  issue(ttlMs?: number): PairingToken {
    const t = createPairingToken(ttlMs);
    this.tokens.set(t.token, t.expiresAt);
    return t;
  }

  /** Returns true once for a valid, unexpired token; the token is consumed. */
  consume(token: string, now = Date.now()): boolean {
    for (const [t, exp] of this.tokens) if (exp <= now) this.tokens.delete(t); // drop expired
    const expiresAt = this.tokens.get(token);
    this.tokens.delete(token);
    return expiresAt !== undefined && expiresAt > now;
  }
}

/** What the QR code carries. */
export interface PairingInfo {
  /** The computer's device ID (Ed25519 public key). The phone pins it. */
  daemonId: string;
  /** Relay WebSocket URL, e.g. wss://relay.example.com */
  relayUrl: string;
  token: string;
}

export function encodePairingUri(info: PairingInfo): string {
  return `airemo://pair?v=1&d=${encodeURIComponent(info.daemonId)}&r=${encodeURIComponent(info.relayUrl)}&t=${encodeURIComponent(info.token)}`;
}

export function parsePairingUri(uri: string): PairingInfo {
  const prefix = "airemo://pair?";
  if (!uri.startsWith(prefix)) throw new Error("Not an Airemo pairing code");
  const params: Record<string, string> = {};
  for (const part of uri.slice(prefix.length).split("&")) {
    const i = part.indexOf("=");
    if (i > 0) params[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  if (params.v !== "1") throw new Error("Unsupported pairing code version");
  const { d, r, t } = params;
  if (!d || !r || !t) throw new Error("Incomplete pairing code");
  return { daemonId: d, relayUrl: r, token: t };
}

/** Accepts `wss://host`, `wss://host/` or `wss://host/connect` and returns the connect URL. */
export function relayConnectUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/connect") ? trimmed : `${trimmed}/connect`;
}
