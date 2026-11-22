import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { concatBytes, utf8Encode } from "./encoding.js";
import type { X25519KeyPair } from "./identity.js";

/**
 * Noise_XX_25519_ChaChaPoly_BLAKE2b (https://noiseprotocol.org/noise.html).
 *
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 *
 * Both sides authenticate with static keys. Interop with an independent
 * implementation (`noise-handshake`) is checked in the tests.
 */
const PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_BLAKE2b";
const HASHLEN = 64;
const DHLEN = 32;
const TAGLEN = 16;

const hash = (data: Uint8Array) => blake2b(data);
const hmacHash = (key: Uint8Array, data: Uint8Array) => hmac(blake2b, key, data);

function hkdf2(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmacHash(chainingKey, input);
  const out1 = hmacHash(temp, Uint8Array.of(1));
  const out2 = hmacHash(temp, concatBytes(out1, Uint8Array.of(2)));
  return [out1, out2];
}

function nonce12(n: number): Uint8Array {
  // Noise ChaChaPoly nonce: 32 zero bits followed by the 64-bit little-endian counter.
  // Plain numbers (not BigInt) so this also runs on engines without DataView BigInt support.
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(4, n % 4294967296, true);
  view.setUint32(8, Math.floor(n / 4294967296), true);
  return out;
}

export interface HandshakeResult {
  /** Key for messages this side sends. */
  sendKey: Uint8Array;
  /** Key for messages this side receives. */
  recvKey: Uint8Array;
  /** The peer's X25519 static public key, authenticated by the handshake. */
  remoteStatic: Uint8Array;
  /** Hash binding the whole handshake transcript (useful for channel binding and tests). */
  handshakeHash: Uint8Array;
}

export type NoiseRole = "initiator" | "responder";

export class NoiseXX {
  private h: Uint8Array;
  private ck: Uint8Array;
  private k: Uint8Array | null = null;
  private n = 0;
  private e: X25519KeyPair | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;
  private step = 0;
  private done: HandshakeResult | null = null;

  /**
   * @param ephemeral Test hook for deterministic vectors. Never pass this in production.
   */
  constructor(
    private role: NoiseRole,
    private s: X25519KeyPair,
    prologue: Uint8Array = new Uint8Array(),
    private ephemeral?: X25519KeyPair,
  ) {
    const name = utf8Encode(PROTOCOL_NAME);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = hash(name);
    }
    this.ck = this.h;
    this.mixHash(prologue);
  }

  get complete(): boolean {
    return this.done !== null;
  }

  get result(): HandshakeResult {
    if (!this.done) throw new Error("Handshake not complete");
    return this.done;
  }

  /** The peer's static key once it has been received (before the handshake completes). */
  get peerStatic(): Uint8Array | null {
    return this.rs;
  }

  writeMessage(payload: Uint8Array = new Uint8Array()): Uint8Array {
    const order = this.role === "initiator" ? [0, 2] : [1];
    if (!order.includes(this.step)) throw new Error("Not this side's turn to write");
    const out: Uint8Array[] = [];

    if (this.step === 0) {
      out.push(this.generateEphemeral());
    } else if (this.step === 1) {
      out.push(this.generateEphemeral());
      this.mixKey(this.dh(this.e as X25519KeyPair, this.re as Uint8Array)); // ee
      out.push(this.encryptAndHash(this.s.publicKey)); // s
      this.mixKey(this.dh(this.s, this.re as Uint8Array)); // es (responder: s, re)
    } else {
      out.push(this.encryptAndHash(this.s.publicKey)); // s
      this.mixKey(this.dh(this.s, this.re as Uint8Array)); // se (initiator: s, re)
    }
    out.push(this.encryptAndHash(payload));
    this.step++;
    this.finishIfDone();
    return concatBytes(...out);
  }

  readMessage(message: Uint8Array): Uint8Array {
    const order = this.role === "initiator" ? [1] : [0, 2];
    if (!order.includes(this.step)) throw new Error("Not this side's turn to read");
    let off = 0;
    const take = (len: number) => {
      if (off + len > message.length) throw new Error("Handshake message too short");
      const part = message.subarray(off, off + len);
      off += len;
      return part;
    };

    if (this.step === 0) {
      this.re = take(DHLEN).slice();
      this.mixHash(this.re);
    } else if (this.step === 1) {
      this.re = take(DHLEN).slice();
      this.mixHash(this.re);
      this.mixKey(this.dh(this.e as X25519KeyPair, this.re)); // ee
      this.rs = this.decryptAndHash(take(DHLEN + TAGLEN)); // s
      this.mixKey(this.dh(this.e as X25519KeyPair, this.rs)); // es (initiator: e, rs)
    } else {
      this.rs = this.decryptAndHash(take(DHLEN + TAGLEN)); // s
      this.mixKey(this.dh(this.e as X25519KeyPair, this.rs)); // se (responder: e, rs)
    }
    const payload = this.decryptAndHash(message.subarray(off));
    this.step++;
    this.finishIfDone();
    return payload;
  }

  private finishIfDone(): void {
    if (this.step < 3) return;
    const [k1, k2] = hkdf2(this.ck, new Uint8Array());
    const initiator = this.role === "initiator";
    this.done = {
      sendKey: (initiator ? k1 : k2).slice(0, 32),
      recvKey: (initiator ? k2 : k1).slice(0, 32),
      remoteStatic: this.rs as Uint8Array,
      handshakeHash: this.h,
    };
    this.e?.secretKey.fill(0);
    this.k = null;
  }

  private generateEphemeral(): Uint8Array {
    if (!this.e) {
      if (this.ephemeral) this.e = this.ephemeral;
      else {
        const { secretKey, publicKey } = x25519.keygen();
        this.e = { secretKey, publicKey };
      }
    }
    this.mixHash(this.e.publicKey);
    return this.e.publicKey;
  }

  private dh(local: X25519KeyPair, remote: Uint8Array): Uint8Array {
    return x25519.getSharedSecret(local.secretKey, remote);
  }

  private mixHash(data: Uint8Array): void {
    this.h = hash(concatBytes(this.h, data));
  }

  private mixKey(input: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, input);
    this.ck = ck;
    this.k = tempK.slice(0, 32);
    this.n = 0;
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!this.k) {
      this.mixHash(plaintext);
      return plaintext;
    }
    const ct = chacha20poly1305(this.k, nonce12(this.n++), this.h).encrypt(plaintext);
    this.mixHash(ct);
    return ct;
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!this.k) {
      this.mixHash(ciphertext);
      return ciphertext;
    }
    const pt = chacha20poly1305(this.k, nonce12(this.n++), this.h).decrypt(ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }
}
