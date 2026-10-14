// Bearer tokens for the optional HTTP transport (Phase 15). A token is
// `ebt_<principal>.<43 base64url chars>` (32 random bytes). Only a SHA-256
// hash is stored, in `<stateDir>/http-tokens.json` (0600), one entry per
// principal; the plaintext is shown once at creation. Verification compares
// hashes in constant time and requires the token's principal to equal the
// instance's configured principal.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PRINCIPAL_ID_RE } from '../config.js';
import { FILE_MODE, readFileSafe, resolveInState, statSafe, writeAtomic, type SafePath } from '../safe-path.js';

export const TOKEN_FILE = 'http-tokens.json';
export const TOKEN_BYTES = 32;
const PREFIX = 'ebt_';
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

interface TokenEntry {
  sha256: string;
  created: string;
}
type TokenStore = Record<string, TokenEntry>;

const hashOf = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

function readStore(stateDir: SafePath): TokenStore {
  const file = resolveInState(stateDir, TOKEN_FILE);
  if (statSafe(file) === undefined) return {};
  try {
    const raw = JSON.parse(readFileSafe(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: TokenStore = {};
    for (const [k, v] of Object.entries(raw)) {
      const e = v as Partial<TokenEntry> | null;
      if (e && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)) out[k] = { sha256: e.sha256, created: String(e.created ?? '') };
    }
    return out;
  } catch {
    return {};
  }
}

/** Create (or rotate) the token for a principal. Returns the plaintext, which is never stored. */
export function createToken(stateDir: SafePath, principal: string, now: Date = new Date()): string {
  if (!PRINCIPAL_ID_RE.test(principal)) throw new Error('invalid principal id');
  const secret = randomBytes(TOKEN_BYTES).toString('base64url');
  const store = readStore(stateDir);
  store[principal] = { sha256: hashOf(secret), created: now.toISOString() };
  writeAtomic(resolveInState(stateDir, TOKEN_FILE), `${JSON.stringify(store, null, 2)}\n`, { mode: FILE_MODE });
  return `${PREFIX}${principal}.${secret}`;
}

/** True only for a well-formed token of `principal` that matches the stored hash. */
export function verifyToken(stateDir: SafePath, principal: string, presented: string): boolean {
  if (!presented.startsWith(PREFIX)) return false;
  const dot = presented.indexOf('.');
  if (dot < 0) return false;
  const who = presented.slice(PREFIX.length, dot);
  const secret = presented.slice(dot + 1);
  if (!SECRET_RE.test(secret) || !PRINCIPAL_ID_RE.test(who)) return false;
  const entry = readStore(stateDir)[principal];
  // Always hash and compare, so timing does not reveal whether a token exists.
  const expected = Buffer.from(entry?.sha256 ?? '0'.repeat(64), 'hex');
  const actual = Buffer.from(hashOf(secret), 'hex');
  const principalOk = who === principal;
  return timingSafeEqual(expected, actual) && entry !== undefined && principalOk;
}
