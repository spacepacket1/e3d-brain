// Checksums and statistics used by the scrub detectors (Phase 7). Pure.

import { createHash } from 'node:crypto';

/** Luhn check over a string of decimal digits. */
export function luhnValid(digits: string): boolean {
  if (!/^[0-9]+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ISO 13616 IBAN check: move the first four characters to the end, letters to numbers, mod 97 == 1. */
export function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch;
    for (const digit of value) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode base58 to bytes, or undefined if a character is outside the alphabet. */
export function base58Decode(s: string): Uint8Array | undefined {
  let n = 0n;
  for (const ch of s) {
    const v = BASE58_ALPHABET.indexOf(ch);
    if (v < 0) return undefined;
    n = n * 58n + BigInt(v);
  }
  // Most significant byte first; each leading '1' is a leading zero byte.
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Base58check payload (version byte first) if the 4-byte double-SHA256 checksum matches. */
export function base58CheckPayload(s: string): Uint8Array | undefined {
  const raw = base58Decode(s);
  if (raw === undefined || raw.length < 5) return undefined;
  const payload = raw.subarray(0, raw.length - 4);
  const check = sha256(sha256(payload)).subarray(0, 4);
  return Buffer.compare(check, Buffer.from(raw.subarray(raw.length - 4))) === 0 ? payload : undefined;
}

/**
 * Wallet Import Format: base58check with version 0x80 (mainnet) or 0xef
 * (testnet), a 32-byte key, and an optional 0x01 compression flag.
 */
export function wifValid(s: string): boolean {
  const payload = base58CheckPayload(s);
  if (payload === undefined || (payload.length !== 33 && payload.length !== 34)) return false;
  if (payload[0] !== 0x80 && payload[0] !== 0xef) return false;
  return payload.length === 33 || payload[33] === 0x01;
}

/** A legacy Bitcoin address (P2PKH/P2SH, mainnet or testnet): base58check, 21-byte payload. */
export function btcAddressValid(s: string): boolean {
  const payload = base58CheckPayload(s);
  return payload !== undefined && payload.length === 21 && [0x00, 0x05, 0x6f, 0xc4].includes(payload[0]!);
}

/** Shannon entropy of a string in bits per character (over its own character distribution). */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
