// Scrub detectors (Phase 7). Each detector scans a *masked* copy of the text
// (spans claimed by earlier detectors are overwritten with NUL, so later
// detectors cannot match inside or across them) and reports spans to redact.
// Context checks (key-context words, line starts) look at the original text.
//
// Every regex here has bounded quantifiers or a literal anchor, so scanning
// is linear in the input (a 1 MB run of one character must stay fast).

import { parseCitation } from '../cite/citation.js';
import { BIP39_ENGLISH } from './bip39-english.js';
import { btcAddressValid, ibanValid, luhnValid, shannonEntropy, wifValid } from './checks.js';

/** Credential-class detectors: an agent principal's write is rejected outright (strict mode). */
export const CREDENTIAL_TYPES = [
  'private-key',
  'wif-key',
  'hex-private-key',
  'bip39-mnemonic',
  'anthropic-key',
  'openai-key',
  'aws-access-key',
  'aws-secret-key',
  'github-token',
  'slack-token',
  'stripe-key',
  'google-api-key',
  'jwt',
  'bearer-token',
  'password-assignment',
  'url-credentials',
] as const;

/** PII-class detectors, the entropy heuristic, and user literals: redact and continue, even for agents. */
export const REDACT_ONLY_TYPES = ['credit-card', 'us-ssn', 'iban', 'bank-routing', 'bank-account', 'high-entropy', 'extra-pattern'] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];
export type DetectorType = CredentialType | (typeof REDACT_ONLY_TYPES)[number];

export const DETECTOR_TYPES: readonly DetectorType[] = [...CREDENTIAL_TYPES, ...REDACT_ONLY_TYPES];

const CREDENTIAL_SET: ReadonlySet<string> = new Set(CREDENTIAL_TYPES);
export function isCredentialType(type: DetectorType): type is CredentialType {
  return CREDENTIAL_SET.has(type);
}

/**
 * Default Shannon-entropy threshold (bits per character) for the high-entropy
 * heuristic on base64-like strings of length >= 32. Random base64/alphanumeric
 * strings of that length score about 4.5-5.0; identifiers, slugs, and paths
 * score about 3.5-4.1. Lower it to catch more, raise it to flag less.
 */
export const DEFAULT_ENTROPY_THRESHOLD = 4.3;
/** Threshold for pure-hex strings (at most 4 bits per character; random hex of length >= 32 scores about 3.6-3.9). */
export const DEFAULT_HEX_ENTROPY_THRESHOLD = 3.3;
export const MIN_ENTROPY_LENGTH = 32;

export interface Span {
  start: number;
  end: number;
  type: DetectorType;
}

export interface DetectOptions {
  extraPatterns: readonly string[];
  entropyThreshold: number;
  hexEntropyThreshold: number;
}

const MASK = '\u0000';

function mask(text: string, spans: readonly { start: number; end: number }[]): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of sorted) {
    // Spans may overlap (protected spans do); clip so the length never changes.
    const start = Math.max(s.start, pos);
    if (s.end <= start) continue;
    out += text.slice(pos, start) + MASK.repeat(s.end - start);
    pos = s.end;
  }
  return out + text.slice(pos);
}

function hasLower(s: string): boolean {
  return /[a-z]/.test(s);
}
function hasUpper(s: string): boolean {
  return /[A-Z]/.test(s);
}
function hasDigit(s: string): boolean {
  return /[0-9]/.test(s);
}

/** Collect spans for every match of a global regex; `pick` may narrow a match to a sub-span or reject it. */
function scan(
  masked: string,
  re: RegExp,
  type: DetectorType,
  pick: (m: RegExpExecArray) => { start: number; end: number } | undefined | boolean = () => true,
): Span[] {
  const out: Span[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const r = pick(m);
    if (r === false || r === undefined) continue;
    if (r === true) out.push({ start: m.index, end: m.index + m[0].length, type });
    else out.push({ ...r, type });
  }
  return out;
}

/** Offset of capture group `g` inside match `m`, assuming the group's text occurs at the end of the match. */
function tailGroup(m: RegExpExecArray, g: number): { start: number; end: number } {
  const end = m.index + m[0].length;
  return { start: end - m[g]!.length, end };
}

function lineAround(text: string, start: number, end: number, before: number, after: number): { pre: string; post: string } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = text.length;
  return {
    pre: text.slice(Math.max(lineStart, start - before), start),
    post: text.slice(end, Math.min(lineEnd, end + after)),
  };
}

// ---------------------------------------------------------------------------
// PEM / OpenSSH private key blocks.

const PEM_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?)-----/g;
const PEM_BODY_LINE = /^[\t ]*(?:[A-Za-z0-9+/=]{1,200}|[A-Za-z-]{1,40}:[^\n]{0,200})[\t ]*\r?$/;

function detectPem(masked: string): Span[] {
  const out: Span[] = [];
  // Next footer position per label (-1: none after this point), so many
  // unterminated headers do not rescan the text each time.
  const footers = new Map<string, number>();
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(masked); m !== null; m = PEM_BEGIN.exec(masked)) {
    const start = m.index;
    const footer = `-----END ${m[1]}-----`;
    let endIdx = footers.get(footer);
    if (endIdx === undefined || (endIdx >= 0 && endIdx < start + m[0].length)) {
      endIdx = masked.indexOf(footer, start + m[0].length);
      footers.set(footer, endIdx);
    }
    let end: number;
    if (endIdx >= 0) {
      end = endIdx + footer.length;
    } else {
      // No footer: redact the header and every following body-looking line
      // (fail safe: never leave key material after a truncated block).
      end = start + m[0].length;
      let pos = masked.indexOf('\n', end);
      while (pos >= 0) {
        let next = masked.indexOf('\n', pos + 1);
        if (next < 0) next = masked.length;
        const line = masked.slice(pos + 1, next);
        if (!PEM_BODY_LINE.test(line)) break;
        end = next;
        pos = next < masked.length ? next : -1;
      }
    }
    out.push({ start, end, type: 'private-key' });
    PEM_BEGIN.lastIndex = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// User literals (scrub.extraPatterns): case-sensitive, exact.

function detectLiterals(masked: string, literals: readonly string[]): Span[] {
  const out: Span[] = [];
  // Longest first, so a literal that contains another is claimed whole.
  const sorted = [...literals].sort((a, b) => b.length - a.length);
  let current = masked;
  for (const lit of sorted) {
    const found: Span[] = [];
    for (let i = current.indexOf(lit); i >= 0; i = current.indexOf(lit, i + lit.length)) {
      found.push({ start: i, end: i + lit.length, type: 'extra-pattern' });
    }
    out.push(...found);
    current = mask(current, found);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider API keys and tokens.

const RE_ANTHROPIC = /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,512}/g;
const RE_OPENAI = /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{20,512})/g;
const RE_GITHUB = /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g;
const RE_SLACK = /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,255}/g;
const RE_STRIPE = /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}(?![A-Za-z0-9])/g;
const RE_GOOGLE = /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g;
const RE_AWS_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const RE_AWS_SECRET = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=])/g;
const AWS_SECRET_CONTEXT = /aws.{0,20}secret|secret.?access.?key|(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}/i;
const RE_JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{2,8192}\.[A-Za-z0-9_-]{0,4096}/g;
const RE_BEARER = /(?<![A-Za-z0-9])[Bb]earer[ \t]+([A-Za-z0-9._~+/-]{16,4096}=*)/g;
const RE_URL_CREDS = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/([^\s/?#@:[\]\0]{1,256}:[^\s/?#@[\]\0]{1,256})@/g;

/** A 40-character base64 string is an AWS secret key only next to AWS context and only if it mixes cases (a git SHA never does). */
function awsSecretPick(original: string): (m: RegExpExecArray) => boolean {
  return (m) => {
    if (!(hasUpper(m[0]) && hasLower(m[0]) && hasDigit(m[0]))) return false;
    const ctx = original.slice(Math.max(0, m.index - 200), Math.min(original.length, m.index + 240));
    return AWS_SECRET_CONTEXT.test(ctx);
  };
}

// ---------------------------------------------------------------------------
// Crypto: 64-hex keys in context, WIF, BIP39 mnemonics.

const RE_HEX64 = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/g;
/** Key-context words; a 64-hex string counts as a private key only near one of these (same line). */
const KEY_CONTEXT = /priv|secret|seed|mnemonic|key\s*=|\bpk\b|signer|deployer|(?:wallet|signing)[ \t]+key/i;
export const KEY_CONTEXT_BEFORE = 40;
export const KEY_CONTEXT_AFTER = 20;

function detectHexKeys(masked: string, original: string, protectedMask: string): Span[] {
  return scan(masked, RE_HEX64, 'hex-private-key', (m) => {
    // Never inside a well-formed citation.
    if (protectedMask.charCodeAt(m.index) === 0) return false;
    const { pre, post } = lineAround(original, m.index, m.index + m[0].length, KEY_CONTEXT_BEFORE, KEY_CONTEXT_AFTER);
    if (KEY_CONTEXT.test(pre) || KEY_CONTEXT.test(post)) return true;
    // A label on the previous line ("my wallet key" / a JSON key split across lines) counts when the hex starts its line.
    const lineStart = original.lastIndexOf('\n', m.index - 1) + 1;
    if (lineStart > 0 && /^[\s"'`]*$/.test(original.slice(lineStart, m.index))) {
      const prevStart = original.lastIndexOf('\n', lineStart - 2) + 1;
      return KEY_CONTEXT.test(original.slice(Math.max(prevStart, lineStart - 1 - KEY_CONTEXT_BEFORE), lineStart - 1));
    }
    return false;
  });
}

const RE_WIF = /(?<![1-9A-HJ-NP-Za-km-z])[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])/g;

const BIP39_SET: ReadonlySet<string> = new Set(BIP39_ENGLISH);
/** Gap between mnemonic words: whitespace or commas, optionally followed by a list number (`2.`, `3)`). */
const BIP39_GAP = /^[\s,]{1,8}(?:[0-9]{1,2}[.):][ \t]{0,4})?$/;
export const MNEMONIC_MIN_WORDS = 12;

function bip39Word(w: string): boolean {
  // lowercase, Capitalized, or UPPERCASE only.
  const lower = w.toLowerCase();
  if (w !== lower && w !== w.toUpperCase() && w !== w[0]!.toUpperCase() + lower.slice(1)) return false;
  return BIP39_SET.has(lower);
}

function detectMnemonics(masked: string): Span[] {
  const out: Span[] = [];
  const re = /[A-Za-z]+/g;
  let runStart = -1;
  let runEnd = -1;
  let runLen = 0;
  const flush = (): void => {
    if (runLen >= MNEMONIC_MIN_WORDS) out.push({ start: runStart, end: runEnd, type: 'bip39-mnemonic' });
    runLen = 0;
  };
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const w = m[0];
    const ok = w.length >= 3 && w.length <= 8 && bip39Word(w);
    if (!ok) {
      flush();
      continue;
    }
    if (runLen > 0 && BIP39_GAP.test(masked.slice(runEnd, m.index))) {
      runEnd = m.index + w.length;
      runLen++;
    } else {
      flush();
      runStart = m.index;
      runEnd = m.index + w.length;
      runLen = 1;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Password assignments: `password=...`, `"api_key": "..."`, `my password is ...`.

const RE_ASSIGN =
  /(?:password|passwd|passphrase|pwd|secret|token|api[_ -]?key|access[_-]?key|secret[_-]?key|private[_-]?key)(?![A-Za-z0-9])["']?(?:[ \t]*([:=])[ \t]*|[ \t]+(is)[ \t]+)(?:"([^"\n\0]{1,256})"|'([^'\n\0]{1,256})'|`([^`\n\0]{1,256})`|([^\s"'`\0]{1,256}))/gi;
const PLACEHOLDER =
  /^(?:\*+|x{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_]+%|\{\{[^}]*\}\}|null|nil|none|undefined|true|false|empty|redacted|changeme|example|your[_-][A-Za-z_-]+)$/i;
const CODE_EXPR = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(.*|\[.*)?;?$/;
const ASSIGN_LINE_START = /^[ \t]*(?:export[ \t]+|set[ \t]+|-[ \t]+)?["']?[A-Za-z0-9_.-]*$/;
const TRAILING_PUNCT = /[.,;:!?)\]}>]+$/;

function detectAssignments(masked: string, original: string): Span[] {
  return scan(masked, RE_ASSIGN, 'password-assignment', (m) => {
    const sep = m[1] ?? m[2]!;
    const quoted = m[3] ?? m[4] ?? m[5];
    let value = quoted ?? m[6]!;
    if (value.startsWith('[REDACTED:') || PLACEHOLDER.test(value)) return false;
    const end = m.index + m[0].length - (quoted !== undefined ? 1 : 0);
    if (quoted === undefined) value = value.replace(TRAILING_PUNCT, '');
    const valueStart = end - (quoted ?? m[6]!).length;
    const valueEnd = valueStart + value.length;
    if (value.length < 3 || PLACEHOLDER.test(value)) return false;
    if (/^(?:\/|~\/|\.\.?\/)/.test(value)) return false; // a path, e.g. `pwd: /home/me`
    if (quoted !== undefined) return { start: valueStart, end: valueEnd };
    const symbolic = hasDigit(value) || /[^A-Za-z]/.test(value);
    if (sep.toLowerCase() === 'is') return symbolic ? { start: valueStart, end: valueEnd } : false;
    if (CODE_EXPR.test(value) && /[.([]/.test(value)) return false; // `token = getToken()`, `process.env.X`
    if (symbolic) return { start: valueStart, end: valueEnd };
    // Letters only: a config-style line (`password=hunter`) whose value ends the line.
    const lineStart = original.lastIndexOf('\n', m.index - 1) + 1;
    const restOfLine = original.slice(valueEnd, valueEnd + 2);
    const endsLine = restOfLine === '' || restOfLine[0] === '\n' || restOfLine === '\r\n' || restOfLine[0] === '\r';
    return endsLine && ASSIGN_LINE_START.test(original.slice(lineStart, m.index)) ? { start: valueStart, end: valueEnd } : false;
  });
}

// ---------------------------------------------------------------------------
// Financial and identity.

const RE_CARD = /(?<![0-9A-Za-z_.-])[0-9](?:[ -]?[0-9]){12,18}(?![0-9A-Za-z_-])/g;

function cardBrandOk(d: string): boolean {
  const n = d.length;
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  if (d[0] === '4') return n === 13 || n === 16 || n === 19; // Visa
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return n === 16; // Mastercard
  if (p2 === 34 || p2 === 37) return n === 15; // Amex
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || p2 === 62) return n >= 16 && n <= 19; // Discover, UnionPay
  if (p4 >= 3528 && p4 <= 3589) return n >= 16 && n <= 19; // JCB
  if ((p3 >= 300 && p3 <= 305) || p2 === 36 || p2 === 38) return n >= 14 && n <= 19; // Diners
  return false;
}

function detectCards(masked: string): Span[] {
  return scan(masked, RE_CARD, 'credit-card', (m) => {
    const seps = m[0].replace(/[0-9]/g, '');
    if (seps.length > 0 && !(seps === ' '.repeat(seps.length) || seps === '-'.repeat(seps.length))) return false;
    const digits = m[0].replace(/[ -]/g, '');
    return cardBrandOk(digits) && luhnValid(digits);
  });
}

const RE_SSN = /(?<![0-9A-Za-z-])(?!000|666|9[0-9]{2})[0-9]{3}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}(?![0-9A-Za-z-])/g;

const RE_IBAN = /(?<![A-Za-z0-9])[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,40}/g;
const ALNUM = /[A-Za-z0-9]/;

function detectIbans(masked: string): Span[] {
  const out: Span[] = [];
  RE_IBAN.lastIndex = 0;
  for (let m = RE_IBAN.exec(masked); m !== null; m = RE_IBAN.exec(masked)) {
    let found = -1;
    for (let end = m.index + m[0].length; end >= m.index + 15; end--) {
      if (!ALNUM.test(masked[end - 1]!) || (end < masked.length && ALNUM.test(masked[end]!))) continue;
      const raw = masked.slice(m.index, end);
      if (raw.includes('  ')) continue;
      const compact = raw.replace(/ /g, '');
      if (compact.length >= 15 && compact.length <= 34 && ibanValid(compact)) {
        found = end;
        break;
      }
    }
    if (found >= 0) {
      out.push({ start: m.index, end: found, type: 'iban' });
      RE_IBAN.lastIndex = found;
    } else {
      RE_IBAN.lastIndex = m.index + 1;
    }
  }
  return out;
}

const RE_ROUTING = /(?<![A-Za-z])(?:routing|aba|rtn)(?:[ \t]+(?:number|no\.?|num|#))?[ \t]*(?:[:#=]|is)?[ \t]*([0-9]{9})(?![0-9])/gi;
const RE_ACCOUNT =
  /(?<![A-Za-z])(?:account[ \t]*(?:number|no\.?|num|#)|acct\.?(?:[ \t]*(?:number|no\.?|num|#))?)[ \t]*(?:[:#=]|is)?[ \t]*([0-9][0-9 -]{2,18}[0-9])(?![0-9])/gi;

// ---------------------------------------------------------------------------
// High-entropy heuristic, with protected spans (citations, hashes, ids).

const RE_CITATION = /(?<![A-Za-z0-9_])(?:note|thesis|outcome|commit|ref|url):[\x21-\x7e]{1,4096}/g;
const RE_0X_HEX = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{1,4096}(?![0-9A-Za-z])/g;
const RE_HEX_40_64 = /(?<![0-9A-Za-z])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9A-Za-z])/g;
const RE_ULID = /(?<![0-9A-Za-z])[0-7][0-9A-HJKMNP-TV-Z]{25}(?![0-9A-Za-z])/g;
const RE_UUID = /(?<![0-9A-Za-z])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z])/g;
const RE_BECH32 = /(?<![0-9A-Za-z])(?:bc|tb)1[ac-hj-np-z02-9]{11,71}(?![0-9A-Za-z])/g;
const RE_BASE58_ADDRESS = /(?<![0-9A-Za-z])[123mn][1-9A-HJ-NP-Za-km-z]{25,34}(?![0-9A-Za-z])/g;
const CITATION_TRAILING = /[.,;:!?)\]}>'"*_]$/;

/**
 * Spans the hex and entropy detectors never flag: well-formed citations
 * (`note:`, `thesis:`, `outcome:`, `commit:`, ...), `0x` hex (transaction
 * hashes, addresses), bare 40/64-hex (git SHAs, content hashes), ULIDs, UUIDs,
 * and public Bitcoin addresses (bech32, or base58 with a valid checksum).
 */
export function protectedSpans(masked: string, citationsOnly = false): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  RE_CITATION.lastIndex = 0;
  for (let m = RE_CITATION.exec(masked); m !== null; m = RE_CITATION.exec(masked)) {
    let s = m[0];
    while (s.length > 0 && !parseCitation(s).ok && CITATION_TRAILING.test(s)) s = s.slice(0, -1);
    if (s.length > 0 && parseCitation(s).ok) out.push({ start: m.index, end: m.index + s.length });
  }
  if (citationsOnly) return out;
  for (const re of [RE_0X_HEX, RE_HEX_40_64, RE_ULID, RE_UUID, RE_BECH32]) {
    re.lastIndex = 0;
    for (let m = re.exec(masked); m !== null; m = re.exec(masked)) out.push({ start: m.index, end: m.index + m[0].length });
  }
  RE_BASE58_ADDRESS.lastIndex = 0;
  for (let m = RE_BASE58_ADDRESS.exec(masked); m !== null; m = RE_BASE58_ADDRESS.exec(masked)) {
    if (btcAddressValid(m[0])) out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const RE_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g;

function pathLike(candidate: string, before: string): boolean {
  if (/^[/~.]/.test(candidate) || candidate.includes('//') || before === ':') return true;
  const pieces = candidate.split('/').filter((p) => p !== '');
  if (pieces.length < 3) return false;
  const lowercase = pieces.filter((p) => /^[a-z0-9._-]+$/.test(p)).length;
  return lowercase * 2 >= pieces.length;
}

/** Slugs and identifiers: several separator-joined parts, nearly all plain lowercase words or numbers. */
function slugLike(s: string): boolean {
  const parts = s.split(/[-_]/).filter((p) => p !== '');
  if (parts.length < 3) return false;
  const plain = parts.filter((p) => /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+|[0-9]+)$/.test(p)).length;
  return plain >= parts.length - 1;
}

function detectEntropy(protectedMask: string, opts: DetectOptions): Span[] {
  const out: Span[] = [];
  RE_ENTROPY_CANDIDATE.lastIndex = 0;
  for (let m = RE_ENTROPY_CANDIDATE.exec(protectedMask); m !== null; m = RE_ENTROPY_CANDIDATE.exec(protectedMask)) {
    const before = m.index > 0 ? protectedMask[m.index - 1]! : '';
    const pieces: { text: string; offset: number }[] = [];
    if (m[0].includes('/') && pathLike(m[0], before)) {
      let offset = 0;
      for (const p of m[0].split('/')) {
        pieces.push({ text: p, offset });
        offset += p.length + 1;
      }
    } else {
      pieces.push({ text: m[0], offset: 0 });
    }
    for (const piece of pieces) {
      const lead = /^[=_-]*/.exec(piece.text)![0].length;
      const core = piece.text.slice(lead).replace(/[_-]+$/, '');
      if (core.length < MIN_ENTROPY_LENGTH) continue;
      const body = core.replace(/=+$/, '');
      let flag: boolean;
      if (/^[0-9a-fA-F]+$/.test(body)) {
        flag = shannonEntropy(body) >= opts.hexEntropyThreshold;
      } else {
        flag = hasDigit(body) && /[A-Za-z]/.test(body) && !slugLike(body) && shannonEntropy(body) >= opts.entropyThreshold;
      }
      if (flag) {
        const start = m.index + piece.offset + lead;
        out.push({ start, end: start + core.length, type: 'high-entropy' });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

type Step = (masked: string, original: string) => Span[];

/** Detectors in priority order; earlier steps win overlaps. */
function steps(opts: DetectOptions): Step[] {
  const urlCreds = (m: RegExpExecArray): { start: number; end: number } => {
    const end = m.index + m[0].length - 1; // the credentials end just before '@'
    return { start: end - m[1]!.length, end };
  };
  const withProtected = (masked: string, citationsOnly = false): string => mask(masked, protectedSpans(masked, citationsOnly));
  return [
    (t) => detectPem(t),
    (t) => detectLiterals(t, opts.extraPatterns),
    (t) => scan(t, RE_JWT, 'jwt'),
    (t) => scan(t, RE_ANTHROPIC, 'anthropic-key'),
    // Real keys mix upper, lower, and digits; slugs like `sk-learn-...` do not.
    (t) => scan(t, RE_OPENAI, 'openai-key', (m) => hasUpper(m[1]!) && hasLower(m[1]!) && hasDigit(m[1]!)),
    (t) => scan(t, RE_GITHUB, 'github-token'),
    (t) => scan(t, RE_SLACK, 'slack-token', (m) => hasDigit(m[0])),
    (t) => scan(t, RE_STRIPE, 'stripe-key'),
    (t) => scan(t, RE_GOOGLE, 'google-api-key'),
    (t, o) => scan(t, RE_AWS_SECRET, 'aws-secret-key', awsSecretPick(o)),
    (t) => scan(t, RE_AWS_ID, 'aws-access-key'),
    (t) => scan(t, RE_URL_CREDS, 'url-credentials', urlCreds),
    (t) => scan(t, RE_BEARER, 'bearer-token', (m) => (hasDigit(m[1]!) && /[A-Za-z]/.test(m[1]!) ? tailGroup(m, 1) : false)),
    // In key context even a `0x`-prefixed 64-hex string is a key; only citations are exempt.
    (t, o) => detectHexKeys(t, o, withProtected(t, true)),
    (t) => scan(t, RE_WIF, 'wif-key', (m) => wifValid(m[0])),
    (t, o) => detectAssignments(t, o),
    (t) => scan(t, RE_SSN, 'us-ssn'),
    (t) => detectCards(t),
    (t) => detectIbans(t),
    (t) => scan(t, RE_ROUTING, 'bank-routing', (m) => tailGroup(m, 1)),
    (t) => scan(t, RE_ACCOUNT, 'bank-account', (m) => (m[1]!.replace(/[^0-9]/g, '').length >= 4 ? tailGroup(m, 1) : false)),
    // After the context-keyed detectors: list words such as "account",
    // "number", or "secret" must not be swallowed into a mnemonic run first.
    (t) => detectMnemonics(t),
    (t) => detectEntropy(withProtected(t), opts),
  ];
}

/**
 * Run every detector in priority order and return non-overlapping spans,
 * sorted by start. Each detector scans the text with all earlier claims
 * masked, so earlier detectors win.
 */
export function detect(text: string, opts: DetectOptions): Span[] {
  const all: Span[] = [];
  let masked = text;
  for (const step of steps(opts)) {
    const found = step(masked, text).sort((a, b) => a.start - b.start);
    const kept: Span[] = [];
    let lastEnd = -1;
    for (const s of found) {
      if (s.end <= s.start || s.start < lastEnd) continue;
      kept.push(s);
      lastEnd = s.end;
    }
    if (kept.length === 0) continue;
    all.push(...kept);
    masked = mask(masked, kept);
  }
  return all.sort((a, b) => a.start - b.start);
}
