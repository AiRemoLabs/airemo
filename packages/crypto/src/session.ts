import { SecureChannel } from "./channel.js";
import { bytesEqual, concatBytes, utf8Decode, utf8Encode } from "./encoding.js";
import { type Identity, noisePublicFromId, noiseStaticKey } from "./identity.js";
import { NoiseXX } from "./noise.js";

/** First byte of every frame sent between a client and a daemon (through the relay or directly). */
export const FrameKind = {
  Hs1: 1,
  Hs2: 2,
  Hs3: 3,
  Data: 4,
  /** Unencrypted hint from the computer: "I have no session with you, handshake again". */
  Reset: 5,
} as const;
export type FrameKindValue = (typeof FrameKind)[keyof typeof FrameKind];

export function packFrame(kind: FrameKindValue, body: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(kind), body);
}

export function unpackFrame(frame: Uint8Array): { kind: number; body: Uint8Array } {
  if (frame.length < 1) throw new Error("Empty frame");
  return { kind: frame[0] as number, body: frame.subarray(1) };
}

/** Carried, encrypted, in the third handshake message. */
export interface HandshakePayload {
  /** Single-use pairing token. Only needed the first time a device connects. */
  token?: string;
  /** Human-readable device name, shown in the device list. */
  name?: string;
}

const MAX_PAYLOAD_BYTES = 1024;

export class PinMismatchError extends Error {
  constructor() {
    super("The computer's key does not match the one from pairing");
  }
}

/** Does this Noise static key belong to that device ID? Ties the relay-authenticated ID to the handshake. */
export function staticKeyMatchesDeviceId(staticKey: Uint8Array, deviceId: string): boolean {
  try {
    return bytesEqual(staticKey, noisePublicFromId(deviceId));
  } catch {
    return false;
  }
}

/** Phone side. Verifies the computer's key against the one pinned from the QR code. */
export class InitiatorHandshake {
  private noise: NoiseXX;

  constructor(
    identity: Identity,
    private peerDeviceId: string,
    private payload: HandshakePayload = {},
  ) {
    this.noise = new NoiseXX("initiator", noiseStaticKey(identity));
  }

  first(): Uint8Array {
    return packFrame(FrameKind.Hs1, this.noise.writeMessage());
  }

  /** Returns the third handshake frame to send and the ready channel. */
  second(frame: Uint8Array): { reply: Uint8Array; channel: SecureChannel } {
    const { kind, body } = unpackFrame(frame);
    if (kind !== FrameKind.Hs2) throw new Error("Unexpected frame");
    this.noise.readMessage(body);
    // Verify the pinned key BEFORE sending the third message, which carries the pairing token.
    const rs = this.noise.peerStatic;
    if (!rs || !staticKeyMatchesDeviceId(rs, this.peerDeviceId)) throw new PinMismatchError();
    const reply = packFrame(
      FrameKind.Hs3,
      this.noise.writeMessage(utf8Encode(JSON.stringify(this.payload))),
    );
    const r = this.noise.result;
    return { reply, channel: new SecureChannel(r.sendKey, r.recvKey) };
  }
}

/** Computer side. */
export class ResponderHandshake {
  private noise: NoiseXX;

  constructor(identity: Identity) {
    this.noise = new NoiseXX("responder", noiseStaticKey(identity));
  }

  /** Takes the first frame, returns the second. */
  first(frame: Uint8Array): Uint8Array {
    const { kind, body } = unpackFrame(frame);
    if (kind !== FrameKind.Hs1) throw new Error("Unexpected frame");
    this.noise.readMessage(body);
    return packFrame(FrameKind.Hs2, this.noise.writeMessage());
  }

  /**
   * Takes the third frame. The caller must still check the peer is allowed: either its key is
   * already paired, or `payload.token` is a valid single-use pairing token.
   */
  third(frame: Uint8Array): {
    channel: SecureChannel;
    peerStatic: Uint8Array;
    payload: HandshakePayload;
  } {
    const { kind, body } = unpackFrame(frame);
    if (kind !== FrameKind.Hs3) throw new Error("Unexpected frame");
    const raw = this.noise.readMessage(body);
    if (raw.length > MAX_PAYLOAD_BYTES) throw new Error("Handshake payload too large");
    let payload: HandshakePayload = {};
    if (raw.length > 0) {
      const parsed: unknown = JSON.parse(utf8Decode(raw));
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        payload = {
          ...(typeof p.token === "string" ? { token: p.token } : {}),
          ...(typeof p.name === "string" ? { name: p.name.slice(0, 64) } : {}),
        };
      }
    }
    const r = this.noise.result;
    return {
      channel: new SecureChannel(r.sendKey, r.recvKey),
      peerStatic: r.remoteStatic,
      payload,
    };
  }
}
