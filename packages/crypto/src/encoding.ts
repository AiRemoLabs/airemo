// Portable base64url and byte helpers (no Buffer, so it runs on Node, browsers and React Native).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 3) << 4) | ((b1 ?? 0) >> 4));
    if (b1 !== undefined) out += ALPHABET.charAt(((b1 & 15) << 2) | ((b2 ?? 0) >> 6));
    if (b2 !== undefined) out += ALPHABET.charAt(b2 & 63);
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new Error("Invalid base64url length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => {
      const ch = clean.charAt(i + k);
      if (ch === "") return -1;
      const v = LOOKUP[ch];
      if (v === undefined) throw new Error("Invalid base64url character");
      return v;
    }) as [number, number, number, number];
    out[o++] = (c[0] << 2) | (c[1] >> 4);
    if (c[2] !== -1) out[o++] = ((c[1] & 15) << 4) | (c[2] >> 2);
    if (c[3] !== -1) out[o++] = ((c[2] & 3) << 6) | c[3];
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * UTF-8 without TextEncoder/TextDecoder, which some React Native engines lack.
 * Lone surrogates encode as U+FFFD and invalid bytes decode as U+FFFD, like the WHATWG codecs.
 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    let need = 0;
    let cp = 0;
    let min = 0;
    if (b0 < 0x80) {
      codePoints.push(b0);
      i++;
      continue;
    }
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else {
      codePoints.push(0xfffd);
      i++;
      continue;
    }
    let j = 1;
    for (; j <= need; j++) {
      const b = bytes[i + j];
      if (b === undefined || (b & 0xc0) !== 0x80) break;
      cp = (cp << 6) | (b & 63);
    }
    if (j <= need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      codePoints.push(0xfffd);
      i += Math.max(1, j); // skip the bytes that were consumed before the error
    } else {
      codePoints.push(cp);
      i += need + 1;
    }
  }
  let out = "";
  for (let k = 0; k < codePoints.length; k += 8192) {
    out += String.fromCodePoint(...codePoints.slice(k, k + 8192));
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
