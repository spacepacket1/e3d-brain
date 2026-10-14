// Citation grammar. Pure functions: nothing here touches the filesystem or
// the network (citations are never resolved over the network).
//
//   note:<id>@<rev>[#<heading>]      revision-pinned note citation
//   note:<id>@<rev>#turns-<a>-<b>    conversation turn range (reserved fragment)
//   ref:<ref_id>/<chapter>/<ordinal> book passage (checked against refs.db in Phase 11)
//   thesis:<id>   outcome:<id>   commit:<sha>   url:<https-url>
//
// `<id>`, `<ref_id>`, and `<chapter>` match [A-Za-z0-9_]+; `<rev>` is 16
// lowercase hex; `<ordinal>`, `<a>`, `<b>` are decimal integers without
// leading zeros; `<sha>` is 7 to 64 lowercase hex. `<heading>` and
// `<https-url>` are percent-encoded (uppercase hex, UTF-8) so that `@`, `#`,
// `%`, whitespace, commas, brackets, quotes, and non-ASCII never appear raw.
//
// There is exactly one encoding per citation: `parseCitation` rejects any
// string that `formatCitation` would not emit (lowercase hex escapes, escaped
// characters that need no escaping, surrounding whitespace), so two citations
// are equal exactly when their strings are equal.

export const MAX_CITATION_LENGTH = 4096;
export const MAX_ID_LENGTH = 128;
/** Longest heading, in UTF-16 code units after decoding. */
export const MAX_HEADING_LENGTH = 512;
export const MAX_URL_LENGTH = 2048;
/** Largest turn number or ref ordinal. */
export const MAX_ORDINAL = 1_000_000_000;

const ID_RE = /^[A-Za-z0-9_]+$/;
const REV_RE = /^[0-9a-f]{16}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const INT_RE = /^(?:0|[1-9][0-9]*)$/;
/** Characters a heading keeps raw; everything else is percent-encoded. */
const HEADING_SAFE = /[A-Za-z0-9\-._~]/;
/** Characters a URL keeps raw: unreserved plus the URL delimiters that are harmless in a citation. */
const URL_SAFE = /[A-Za-z0-9\-._~:/?=&+!$*;]/;
/** Control characters and bidi overrides/isolates are rejected in decoded headings and URLs. */
const UNSAFE_TEXT = /[\p{Cc}‪-‮⁦-⁩]/u;
/** A fragment starting with this is a turn range; headings that start with it escape its `-`. */
const TURNS_PREFIX = 'turns-';

export type NoteCitation = {
  kind: 'note';
  id: string;
  rev: string;
  /** `#<heading>` fragment, decoded. */
  heading?: string;
  /** `#turns-<a>-<b>` fragment (inclusive). */
  turns?: { from: number; to: number };
};

export type Citation =
  | NoteCitation
  | { kind: 'ref'; refId: string; chapter: string; ordinal: number }
  | { kind: 'thesis'; id: string }
  | { kind: 'outcome'; id: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'url'; url: string };

export type CitationKind = Citation['kind'];

export type ParseResult = { ok: true; citation: Citation } | { ok: false; error: string };

export type Freshness = 'fresh' | 'stale' | 'missing';

/** Looks up a note's current revision by id: the index in production, a stub in tests. */
export type NoteLookup = (id: string) => { rev: string } | undefined;

export class CitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CitationError';
  }
}

export function isNoteId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && ID_RE.test(id);
}

export function isRev(rev: string): boolean {
  return REV_RE.test(rev);
}

function percentEncode(text: string, safe: RegExp): string {
  let out = '';
  for (const ch of text) {
    if (ch.length === 1 && safe.test(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Decode `%XX` escapes as UTF-8; `undefined` for malformed escapes, invalid UTF-8, or raw unsafe characters. */
function percentDecode(text: string, safe: RegExp): string | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '%') {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return undefined;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (safe.test(ch)) bytes.push(ch.charCodeAt(0));
    else return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

function encodeHeading(heading: string): string {
  const enc = percentEncode(heading, HEADING_SAFE);
  // Keep headings distinct from the reserved turn-range fragment.
  return enc.startsWith(TURNS_PREFIX) ? `turns%2D${enc.slice(TURNS_PREFIX.length)}` : enc;
}

function headingError(heading: string): string | undefined {
  if (heading === '') return 'empty heading';
  if (heading.length > MAX_HEADING_LENGTH) return 'heading too long';
  if (UNSAFE_TEXT.test(heading)) return 'heading contains control characters';
  return undefined;
}

function urlError(url: string): string | undefined {
  if (url.length > MAX_URL_LENGTH) return 'url too long';
  if (UNSAFE_TEXT.test(url) || /[\s\\]/u.test(url)) return 'url contains whitespace, backslashes, or control characters';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url does not parse';
  }
  if (parsed.protocol !== 'https:' || !url.startsWith('https://')) return 'url must be https://';
  if (parsed.username !== '' || parsed.password !== '') return 'url must not contain credentials';
  if (parsed.hostname === '') return 'url has no host';
  return undefined;
}

function ordinalError(n: number, what: string): string | undefined {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_ORDINAL ? undefined : `${what} out of range`;
}

/** Why `c` cannot be formatted, or `undefined` when it is valid. */
function citationError(c: Citation): string | undefined {
  switch (c.kind) {
    case 'note': {
      if (!isNoteId(c.id)) return 'invalid note id';
      if (!isRev(c.rev)) return 'invalid rev (expected 16 lowercase hex)';
      if (c.heading !== undefined && c.turns !== undefined) return 'a note citation has one fragment';
      if (c.heading !== undefined) return headingError(c.heading);
      if (c.turns !== undefined) {
        const e = ordinalError(c.turns.from, 'turn') ?? ordinalError(c.turns.to, 'turn');
        if (e) return e;
        if (c.turns.from > c.turns.to) return 'turn range is reversed';
      }
      return undefined;
    }
    case 'ref':
      if (!isNoteId(c.refId)) return 'invalid ref id';
      if (!isNoteId(c.chapter)) return 'invalid chapter';
      return ordinalError(c.ordinal, 'ordinal');
    case 'thesis':
    case 'outcome':
      return isNoteId(c.id) ? undefined : `invalid ${c.kind} id`;
    case 'commit':
      return SHA_RE.test(c.sha) ? undefined : 'invalid commit sha (expected 7-64 lowercase hex)';
    case 'url':
      return urlError(c.url);
    default:
      return 'unknown citation kind';
  }
}

function emit(c: Citation): string {
  switch (c.kind) {
    case 'note': {
      let s = `note:${c.id}@${c.rev}`;
      if (c.heading !== undefined) s += `#${encodeHeading(c.heading)}`;
      else if (c.turns !== undefined) s += `#${TURNS_PREFIX}${c.turns.from}-${c.turns.to}`;
      return s;
    }
    case 'ref':
      return `ref:${c.refId}/${c.chapter}/${c.ordinal}`;
    case 'thesis':
    case 'outcome':
      return `${c.kind}:${c.id}`;
    case 'commit':
      return `commit:${c.sha}`;
    case 'url':
      return `url:${percentEncode(c.url, URL_SAFE)}`;
  }
}

/** The canonical string for `c`. Throws `CitationError` if `c` is not a valid citation. */
export function formatCitation(c: Citation): string {
  const error = citationError(c);
  if (error !== undefined) throw new CitationError(error);
  return emit(c);
}

function parseInt10(s: string): number | undefined {
  if (!INT_RE.test(s) || s.length > 10) return undefined;
  return Number(s);
}

function parseLoose(s: string): Citation | string {
  const colon = s.indexOf(':');
  if (colon < 0) return 'missing citation kind';
  const kind = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  switch (kind) {
    case 'note': {
      const m = /^([^@#]*)@([^@#]*)(?:#(.*))?$/.exec(rest);
      if (!m) return 'expected note:<id>@<rev>[#<fragment>]';
      const c: NoteCitation = { kind: 'note', id: m[1]!, rev: m[2]! };
      const frag = m[3];
      if (frag !== undefined) {
        if (frag.startsWith(TURNS_PREFIX)) {
          const t = /^turns-([0-9]+)-([0-9]+)$/.exec(frag);
          const from = t ? parseInt10(t[1]!) : undefined;
          const to = t ? parseInt10(t[2]!) : undefined;
          if (from === undefined || to === undefined) return 'malformed turn range';
          c.turns = { from, to };
        } else {
          const heading = percentDecode(frag, HEADING_SAFE);
          if (heading === undefined) return 'heading is not percent-encoded';
          c.heading = heading;
        }
      }
      return c;
    }
    case 'ref': {
      const parts = rest.split('/');
      if (parts.length !== 3) return 'expected ref:<ref_id>/<chapter>/<ordinal>';
      const ordinal = parseInt10(parts[2]!);
      if (ordinal === undefined) return 'invalid ordinal';
      return { kind: 'ref', refId: parts[0]!, chapter: parts[1]!, ordinal };
    }
    case 'thesis':
    case 'outcome':
      return { kind, id: rest };
    case 'commit':
      return { kind: 'commit', sha: rest };
    case 'url': {
      const url = percentDecode(rest, URL_SAFE);
      if (url === undefined) return 'url is not percent-encoded';
      return { kind: 'url', url };
    }
    default:
      return 'unknown citation kind';
  }
}

/** Parse a citation string. Only the canonical encoding is accepted. */
export function parseCitation(input: unknown): ParseResult {
  if (typeof input !== 'string') return { ok: false, error: 'not a string' };
  if (input.length === 0) return { ok: false, error: 'empty' };
  if (input.length > MAX_CITATION_LENGTH) return { ok: false, error: 'too long' };
  if (!/^[\x21-\x7e]+$/.test(input)) return { ok: false, error: 'contains whitespace, control, or non-ASCII characters' };
  const loose = parseLoose(input);
  if (typeof loose === 'string') return { ok: false, error: loose };
  const error = citationError(loose);
  if (error !== undefined) return { ok: false, error };
  if (emit(loose) !== input) return { ok: false, error: 'not in canonical form' };
  return { ok: true, citation: loose };
}

/** `fresh` when the note's current rev matches the citation, `stale` when it differs, `missing` when the id is unknown. */
export function checkNoteCitation(cite: NoteCitation, lookup: NoteLookup): Freshness {
  const current = lookup(cite.id);
  if (current === undefined) return 'missing';
  return current.rev === cite.rev ? 'fresh' : 'stale';
}
