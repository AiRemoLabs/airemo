import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  encodePairingUri,
  FrameKind,
  fromBase64Url,
  generateIdentity,
  InitiatorHandshake,
  NoiseXX,
  noisePublicFromId,
  noiseStaticKey,
  PairingTokenStore,
  PinMismatchError,
  packFrame,
  parsePairingUri,
  ResponderHandshake,
  signApproval,
  signRelayChallenge,
  staticKeyMatchesDeviceId,
  toBase64Url,
  unpackFrame,
  utf8Decode,
  utf8Encode,
  verifyApproval,
  verifyRelayChallenge,
} from "./index.js";

const require = createRequire(import.meta.url);
// Independent implementation, used only to cross-check ours.
const RefNoise = require("noise-handshake");

describe("encoding", () => {
  it("round-trips base64url for every length", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
    expect(toBase64Url(Uint8Array.of(251, 255, 254))).toBe("-__-"); // url-safe alphabet
  });

  it("rejects invalid input", () => {
    expect(() => fromBase64Url("a")).toThrow();
    expect(() => fromBase64Url("ab$d")).toThrow();
  });
});

describe("utf8 codec", () => {
  const samples = [
    "",
    "plain ascii",
    "caf\u00e9 \u00fcber",
    "\u20ac \u2603 \u4e2d\u6587",
    "emoji \u{1F600} \u{1F9D1}\u200D\u{1F4BB} \u{10FFFF}",
    "line1\nline2\r\n\t\u0000 end",
    '{"a":"\u{1F512}","b":[1,2,3]}',
  ];

  it("matches the platform codecs on valid text", () => {
    for (const text of samples) {
      const ours = utf8Encode(text);
      expect(ours).toEqual(new TextEncoder().encode(text));
      expect(utf8Decode(ours)).toBe(text);
      expect(utf8Decode(new TextEncoder().encode(text))).toBe(text);
    }
  });

  it("round-trips random strings, including long ones", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let n = 0; n < 200; n++) {
      let text = "";
      for (let i = 0; i < (n % 7 === 0 ? 20000 : 40); i++) {
        const kind = rand() % 4;
        const cp = [
          rand() % 0x80,
          0x80 + (rand() % 0x700),
          0x800 + (rand() % 0xd000),
          0x10000 + (rand() % 0xf0000),
        ][kind] as number;
        text += String.fromCodePoint(cp);
      }
      expect(utf8Encode(text)).toEqual(new TextEncoder().encode(text));
      expect(utf8Decode(utf8Encode(text))).toBe(text);
    }
  });

  it("replaces lone surrogates and invalid bytes instead of throwing", () => {
    expect(utf8Encode("a\ud800b")).toEqual(new TextEncoder().encode("a\ud800b"));
    for (const bad of [
      [0xff],
      [0xc0, 0x80],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xf8, 0x88, 0x80, 0x80, 0x80],
      [0x80],
    ]) {
      const out = utf8Decode(Uint8Array.from([0x61, ...bad, 0x62]));
      expect(out.startsWith("a")).toBe(true);
      expect(out.endsWith("b")).toBe(true);
      expect(out).toContain("\ufffd");
    }
  });
});

describe("identity", () => {
  it("derives a matching X25519 key from the Ed25519 identity", () => {
    const id = generateIdentity();
    expect(noiseStaticKey(id).publicKey).toEqual(noisePublicFromId(id.publicKey));
  });

  it("verifies approvals bound to the request and decision", () => {
    const id = generateIdentity();
    const sig = signApproval(id, "req-1", "allow");
    expect(verifyApproval(id.publicKey, "req-1", "allow", sig)).toBe(true);
    expect(verifyApproval(id.publicKey, "req-2", "allow", sig)).toBe(false);
    expect(verifyApproval(id.publicKey, "req-1", "deny", sig)).toBe(false);
    expect(verifyApproval(generateIdentity().publicKey, "req-1", "allow", sig)).toBe(false);
    expect(verifyApproval(id.publicKey, "req-1", "allow", "garbage")).toBe(false);
  });

  it("verifies relay challenges", () => {
    const id = generateIdentity();
    const sig = signRelayChallenge(id, "nonce-1");
    expect(verifyRelayChallenge(id.publicKey, "nonce-1", sig)).toBe(true);
    expect(verifyRelayChallenge(id.publicKey, "nonce-2", sig)).toBe(false);
  });
});

describe("pairing tokens and QR payload", () => {
  it("tokens are single-use and expire", () => {
    const store = new PairingTokenStore();
    const t = store.issue(1000);
    expect(store.consume(t.token)).toBe(true);
    expect(store.consume(t.token)).toBe(false);
    const t2 = store.issue(1000);
    expect(store.consume(t2.token, Date.now() + 5000)).toBe(false);
    expect(store.consume("never-issued")).toBe(false);
  });

  it("round-trips the pairing URI", () => {
    const info = {
      daemonId: "abc-_",
      relayUrl: "wss://relay.example.com/connect?x=1&y=2",
      token: "t0k",
    };
    expect(parsePairingUri(encodePairingUri(info))).toEqual(info);
    expect(() => parsePairingUri("https://example.com")).toThrow();
    expect(() => parsePairingUri("airemo://pair?v=2&d=a&r=b&t=c")).toThrow();
    expect(() => parsePairingUri("airemo://pair?v=1&d=a")).toThrow();
  });
});

describe("Noise XX", () => {
  const refKeys = (id: ReturnType<typeof generateIdentity>) => {
    const k = noiseStaticKey(id);
    return { publicKey: Buffer.from(k.publicKey), secretKey: Buffer.from(k.secretKey) };
  };

  it("two of our peers derive matching keys and authenticate each other", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const ini = new NoiseXX("initiator", noiseStaticKey(a));
    const res = new NoiseXX("responder", noiseStaticKey(b));
    res.readMessage(ini.writeMessage(utf8Encode("hello")));
    ini.readMessage(res.writeMessage(utf8Encode("world")));
    expect(utf8Decode(res.readMessage(ini.writeMessage(utf8Encode("!"))))).toBe("!");
    expect(ini.result.sendKey).toEqual(res.result.recvKey);
    expect(ini.result.recvKey).toEqual(res.result.sendKey);
    expect(ini.result.handshakeHash).toEqual(res.result.handshakeHash);
    expect(ini.result.remoteStatic).toEqual(noiseStaticKey(b).publicKey);
    expect(res.result.remoteStatic).toEqual(noiseStaticKey(a).publicKey);
  });

  it("interoperates with an independent implementation (ours as initiator)", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const ref = new RefNoise("XX", false, refKeys(b));
    ref.initialise(Buffer.alloc(0));
    const ours = new NoiseXX("initiator", noiseStaticKey(a));
    ref.recv(Buffer.from(ours.writeMessage()));
    ours.readMessage(ref.send(Buffer.from("p2")));
    const p3 = ref.recv(Buffer.from(ours.writeMessage(utf8Encode("p3"))));
    expect(Buffer.from(p3).toString()).toBe("p3");
    expect(Buffer.from(ours.result.sendKey)).toEqual(Buffer.from(ref.rx));
    expect(Buffer.from(ours.result.recvKey)).toEqual(Buffer.from(ref.tx));
    expect(Buffer.from(ours.result.handshakeHash)).toEqual(Buffer.from(ref.hash));
  });

  it("interoperates with an independent implementation (ours as responder)", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const ref = new RefNoise("XX", true, refKeys(a));
    ref.initialise(Buffer.alloc(0));
    const ours = new NoiseXX("responder", noiseStaticKey(b));
    ours.readMessage(ref.send());
    ref.recv(Buffer.from(ours.writeMessage(utf8Encode("p2"))));
    ours.readMessage(ref.send(Buffer.from("p3")));
    expect(Buffer.from(ours.result.recvKey)).toEqual(Buffer.from(ref.tx));
    expect(Buffer.from(ours.result.sendKey)).toEqual(Buffer.from(ref.rx));
    expect(Buffer.from(ours.result.handshakeHash)).toEqual(Buffer.from(ref.hash));
  });

  it("rejects tampered handshake messages", () => {
    const ini = new NoiseXX("initiator", noiseStaticKey(generateIdentity()));
    const res = new NoiseXX("responder", noiseStaticKey(generateIdentity()));
    res.readMessage(ini.writeMessage());
    const m2 = res.writeMessage();
    m2[40] = (m2[40] as number) ^ 1; // flip a bit inside the encrypted static key
    expect(() => ini.readMessage(m2)).toThrow();
  });

  it("enforces message order", () => {
    const ini = new NoiseXX("initiator", noiseStaticKey(generateIdentity()));
    expect(() => ini.readMessage(new Uint8Array(100))).toThrow();
  });
});

describe("handshake and channel", () => {
  const setup = (token?: string) => {
    const daemon = generateIdentity();
    const phone = generateIdentity();
    const ini = new InitiatorHandshake(phone, daemon.publicKey, { token, name: "My phone" });
    const res = new ResponderHandshake(daemon);
    const f2 = res.first(ini.first());
    const { reply, channel: phoneCh } = ini.second(f2);
    const { channel: daemonCh, peerStatic, payload } = res.third(reply);
    return { daemon, phone, phoneCh, daemonCh, peerStatic, payload };
  };

  it("carries the pairing token and binds the peer key to its device ID", () => {
    const s = setup("tok-123");
    expect(s.payload).toEqual({ token: "tok-123", name: "My phone" });
    expect(staticKeyMatchesDeviceId(s.peerStatic, s.phone.publicKey)).toBe(true);
    expect(staticKeyMatchesDeviceId(s.peerStatic, s.daemon.publicKey)).toBe(false);
  });

  it("exchanges encrypted messages both ways", () => {
    const s = setup();
    expect(utf8Decode(s.daemonCh.open(s.phoneCh.seal(utf8Encode("ls -la"))))).toBe("ls -la");
    expect(utf8Decode(s.phoneCh.open(s.daemonCh.seal(utf8Encode("output"))))).toBe("output");
  });

  it("does not leak plaintext in ciphertext", () => {
    const s = setup();
    const secret = "SECRET-PROMPT-DO-NOT-LEAK";
    const frame = s.phoneCh.seal(utf8Encode(secret));
    expect(utf8Decode(frame)).not.toContain(secret);
  });

  it("rejects replayed, reordered and tampered frames", () => {
    const s = setup();
    const f1 = s.phoneCh.seal(utf8Encode("one"));
    const f2 = s.phoneCh.seal(utf8Encode("two"));
    s.daemonCh.open(f1);
    expect(() => s.daemonCh.open(f1)).toThrow(/Replayed/);
    s.daemonCh.open(f2);
    expect(() => s.daemonCh.open(f1)).toThrow();
    const f3 = s.phoneCh.seal(utf8Encode("three"));
    f3[f3.length - 1] = (f3[f3.length - 1] as number) ^ 1;
    expect(() => s.daemonCh.open(f3)).toThrow();
  });

  it("keeps working past 32-bit counters, and rejects an out-of-range counter", () => {
    const s = setup();
    // Jump both directions far ahead (simulates a very long-lived session).
    const send = s.phoneCh as unknown as { sendCounter: number };
    send.sendCounter = 2 ** 32 + 5;
    expect(utf8Decode(s.daemonCh.open(s.phoneCh.seal(utf8Encode("big"))))).toBe("big");
    send.sendCounter = 2 ** 32 + 6;
    expect(utf8Decode(s.daemonCh.open(s.phoneCh.seal(utf8Encode("bigger"))))).toBe("bigger");
    const forged = s.phoneCh.seal(utf8Encode("x"));
    forged[0] = 0xff; // counter above 2^53
    expect(() => s.daemonCh.open(forged)).toThrow();
  });

  it("tolerates dropped frames", () => {
    const s = setup();
    s.phoneCh.seal(utf8Encode("lost"));
    const f = s.phoneCh.seal(utf8Encode("kept"));
    expect(utf8Decode(s.daemonCh.open(f))).toBe("kept");
  });

  it("a relay substituting its own key is detected before the token is sent", () => {
    const daemon = generateIdentity();
    const phone = generateIdentity();
    const mitm = generateIdentity();
    const ini = new InitiatorHandshake(phone, daemon.publicKey, { token: "secret-token" });
    const evil = new ResponderHandshake(mitm); // attacker answers instead of the daemon
    const f2 = evil.first(ini.first());
    expect(() => ini.second(f2)).toThrow(PinMismatchError);
  });

  it("frames pack and unpack", () => {
    const f = packFrame(FrameKind.Data, Uint8Array.of(9, 8));
    expect(unpackFrame(f)).toEqual({ kind: FrameKind.Data, body: Uint8Array.of(9, 8) });
    expect(() => unpackFrame(new Uint8Array())).toThrow();
  });
});
