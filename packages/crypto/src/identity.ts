import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { fromBase64Url, toBase64Url, utf8Encode } from "./encoding.js";

/**
 * A device identity. One Ed25519 key pair; the Noise (X25519) static key is derived
 * from it, so a device has a single key to store, pin and revoke.
 * `publicKey` doubles as the device ID. Both fields are base64url.
 */
export interface Identity {
  publicKey: string;
  secretKey: string;
}

export function generateIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen();
  return { publicKey: toBase64Url(publicKey), secretKey: toBase64Url(secretKey) };
}

export interface X25519KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** The Noise static key pair for an identity. */
export function noiseStaticKey(identity: Identity): X25519KeyPair {
  const secretKey = ed25519.utils.toMontgomerySecret(fromBase64Url(identity.secretKey));
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The X25519 public key a device ID (Ed25519 public key) corresponds to. */
export function noisePublicFromId(deviceId: string): Uint8Array {
  return ed25519.utils.toMontgomery(fromBase64Url(deviceId));
}

export function sign(identity: Identity, message: Uint8Array): string {
  return toBase64Url(ed25519.sign(message, fromBase64Url(identity.secretKey)));
}

export function verify(deviceId: string, message: Uint8Array, signature: string): boolean {
  try {
    return ed25519.verify(fromBase64Url(signature), message, fromBase64Url(deviceId));
  } catch {
    return false;
  }
}

function approvalBytes(requestId: string, decision: "allow" | "deny"): Uint8Array {
  return utf8Encode(`airemo.approval.v1\n${requestId}\n${decision}`);
}

/** Bind a decision to a request ID so a signature cannot be replayed for another request. */
export function signApproval(
  identity: Identity,
  requestId: string,
  decision: "allow" | "deny",
): string {
  return sign(identity, approvalBytes(requestId, decision));
}

export function verifyApproval(
  deviceId: string,
  requestId: string,
  decision: "allow" | "deny",
  signature: string,
): boolean {
  return verify(deviceId, approvalBytes(requestId, decision), signature);
}

/** Proof of key possession for the relay: sign a server-chosen nonce. */
export function signRelayChallenge(identity: Identity, nonce: string): string {
  return sign(identity, utf8Encode(`airemo.relay.v1\n${nonce}`));
}

export function verifyRelayChallenge(deviceId: string, nonce: string, signature: string): boolean {
  return verify(deviceId, utf8Encode(`airemo.relay.v1\n${nonce}`), signature);
}
