import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "./encoding.js";

const TWO_32 = 4294967296;

function nonceFor(counter: number): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(4, Math.floor(counter / TWO_32), false);
  view.setUint32(8, counter % TWO_32, false);
  return out;
}

function counterHeader(counter: number): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, Math.floor(counter / TWO_32), false);
  view.setUint32(4, counter % TWO_32, false);
  return header;
}

/**
 * Encrypts application messages after the handshake.
 *
 * Every frame carries an explicit 64-bit counter used as the AEAD nonce. The receiver only
 * accepts counters higher than any it has seen, so a replayed (or reordered) frame is
 * rejected, while a dropped frame does not break the channel.
 */
export class SecureChannel {
  // Plain numbers: exact up to 2^53, far beyond any real session, and no BigInt needed.
  private sendCounter = 0;
  private highestReceived = -1;

  constructor(
    private sendKey: Uint8Array,
    private recvKey: Uint8Array,
  ) {}

  seal(plaintext: Uint8Array): Uint8Array {
    if (this.sendCounter >= Number.MAX_SAFE_INTEGER) throw new Error("Channel exhausted");
    const counter = this.sendCounter++;
    const header = counterHeader(counter);
    const ct = chacha20poly1305(this.sendKey, nonceFor(counter), header).encrypt(plaintext);
    return concatBytes(header, ct);
  }

  /** Throws on forgery, tampering or replay. */
  open(frame: Uint8Array): Uint8Array {
    if (frame.length < 8 + 16) throw new Error("Frame too short");
    const header = frame.subarray(0, 8);
    const view = new DataView(header.buffer, header.byteOffset, 8);
    const high = view.getUint32(0, false);
    if (high >= 2 ** 21) throw new Error("Counter out of range"); // beyond 2^53
    const counter = high * TWO_32 + view.getUint32(4, false);
    if (counter <= this.highestReceived) throw new Error("Replayed or out-of-order frame");
    const pt = chacha20poly1305(this.recvKey, nonceFor(counter), header).decrypt(frame.subarray(8));
    this.highestReceived = counter;
    return pt;
  }
}
