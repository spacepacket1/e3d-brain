// ULIDs for result-set ids (`recall_id`, Phase 6): 48 bits of millisecond
// time then 80 random bits, Crockford base32, 26 characters. Uniqueness comes
// from the random part; ids are not monotonic within a millisecond.

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits: ten bytes read as sixteen 5-bit groups.
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(bits & 31n)]! + rand;
    bits >>= 5n;
  }
  return time + rand;
}
