// Note parser: frontmatter (YAML), schema fields, title, tags, aliases,
// headings, wikilinks, body, and chunks. Pure: takes bytes, returns data.
//
// Fail closed without aborting (I10): malformed frontmatter is skipped (the
// body is still indexed), and invalid dates, unknown statuses, and wrongly
// typed fields are recorded as problems. Unknown frontmatter keys are kept as
// an opaque JSON blob, never dropped.

import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { isNoteId, parseCitation } from '../cite/citation.js';
import { chunkBody, DEFAULT_MAX_CHUNK_CHARS, type Chunk } from './chunk.js';
import { extractInlineTags, extractWikiLinks, maskInlineCode, scanLines, type WikiLink } from './markdown.js';
import { compareBytes, nfc, noteBasename } from './names.js';

export const STATUSES = ['proposed', 'accepted', 'rejected', 'journal', 'superseded', 'archived', 'stale'] as const;
export const KINDS = [
  'fact', 'decision', 'preference', 'idea', 'lesson', 'reference', 'summary',
  'raw', 'log', 'observation', 'todo', 'proposal',
] as const;
export const ORIGINS = ['mcp', 'hook', 'import', 'cli'] as const;

const DATE_FIELDS = [
  'occurred', 'valid_from', 'valid_until', 'created', 'expires', 'accepted', 'applied', 'superseded_at', 'archived_at',
] as const;
type DateField = (typeof DATE_FIELDS)[number];

/** Frontmatter keys the parser interprets; everything else goes to `extra`. */
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'title', 'tags', 'tag', 'aliases', 'alias', 'id', 'schema', 'status', 'pinned', 'kind', 'author', 'origin',
  'sources', 'untrusted_origin', 'superseded_by', 'supersedes', 'merged_into', 'derived_from', 'scrubVersion',
  ...DATE_FIELDS,
]);

export type NoteFields = {
  schema: number | null;
  id: string | null;
  /** As written; an unknown or non-string value is kept (stringified) so it is never mistaken for absent. */
  status: string | null;
  pinned: boolean | null;
  kind: string | null;
  author: string | null;
  origin: string | null;
  sources: string[];
  untrusted_origin: boolean | null;
  superseded_by: string | null;
  supersedes: string[];
  merged_into: string | null;
  derived_from: string[];
  scrubVersion: string | null;
} & Record<DateField, string | null>;

export type ProblemKind = 'malformed_frontmatter' | 'invalid_utf8' | 'invalid_date' | 'unknown_status' | 'invalid_field';

export interface Problem {
  kind: ProblemKind;
  field: string | null;
  detail: string;
}

export interface ParsedNote {
  /** Note revision: see `revOf`. */
  rev: string;
  title: string;
  frontmatter: 'none' | 'ok' | 'malformed';
  fields: NoteFields;
  statusKnown: boolean;
  aliases: string[];
  tags: { tag: string; source: 'frontmatter' | 'inline' }[];
  headings: { level: number; text: string; line: number }[];
  links: WikiLink[];
  /** Unknown frontmatter keys, verbatim (as JSON values). */
  extra: Record<string, unknown>;
  body: string;
  chunks: Chunk[];
  problems: Problem[];
}

/** Decode UTF-8 (counting invalid sequences), strip a BOM, normalize CRLF and CR to LF. */
export function decodeNote(data: Uint8Array): { text: string; invalidUtf8: boolean } {
  let text: string;
  let invalidUtf8 = false;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    invalidUtf8 = true;
    text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return { text: text.replace(/\r\n?/g, '\n'), invalidUtf8 };
}

/** Provisional ids are minted by the index; an explicit `id` may not claim the prefix. */
export const PROVISIONAL_PREFIX = 'prov_';

/** The frontmatter `id` if it is usable as a note id, else `null` (the note gets a provisional id). */
export function explicitId(id: string | null): string | null {
  return id !== null && isNoteId(id) && !id.startsWith(PROVISIONAL_PREFIX) ? id : null;
}

/**
 * Revision of normalized text: the first 16 hex characters of the SHA-256 of
 * its UTF-8 encoding. `rev` is this over the whole decoded note (frontmatter
 * plus body) and `chunk_rev` over a chunk's text; `decodeNote` is the whole
 * normalization (UTF-8, leading BOM stripped, CRLF and CR to LF).
 */
export function revOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** Split off a leading `---` frontmatter block closed by `---` or `...`. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string; bodyLine: number; unclosed: boolean } {
  if (!/^---[ \t]*\n/.test(text) && !/^---[ \t]*$/.test(text)) return { yaml: null, body: text, bodyLine: 1, unclosed: false };
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i]!)) {
      return { yaml: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n'), bodyLine: i + 2, unclosed: false };
    }
  }
  return { yaml: null, body: text, bodyLine: 1, unclosed: true };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):?(\d{2}))?)?$/;

/** ISO 8601 calendar date or date-time with a valid calendar day and clock time. */
export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  if (d > days) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return false;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false;
  return true;
}

function emptyFields(): NoteFields {
  const fields: Record<string, unknown> = {
    schema: null, id: null, status: null, pinned: null, kind: null, author: null, origin: null, sources: [],
    untrusted_origin: null, superseded_by: null, supersedes: [], merged_into: null, derived_from: [], scrubVersion: null,
  };
  for (const f of DATE_FIELDS) fields[f] = null;
  return fields as NoteFields;
}

/** Canonical JSON: object keys sorted bytewise, non-finite numbers as strings. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(Number.isNaN(value.getTime()) ? String(value) : value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Map) return canonicalJson(Object.fromEntries([...value].map(([k, v]) => [String(k), v])));
  if (value instanceof Set) return canonicalJson([...value]);
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareBytes);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** A string, or a list of strings; `null` for anything else. */
function stringList(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return null;
}

function interpretFields(fm: Record<string, unknown>, problems: Problem[]): { fields: NoteFields; statusKnown: boolean } {
  const fields = emptyFields();
  const invalid = (field: string, detail: string) => problems.push({ kind: 'invalid_field', field, detail });
  const has = (k: string) => Object.prototype.hasOwnProperty.call(fm, k) && fm[k] !== null && fm[k] !== undefined;
  const str = (k: 'id' | 'author' | 'superseded_by' | 'merged_into') => {
    if (!has(k)) return;
    if (typeof fm[k] === 'string') fields[k] = fm[k];
    else invalid(k, 'expected a string');
  };
  const list = (k: 'sources' | 'supersedes' | 'derived_from') => {
    if (!has(k)) return;
    const l = stringList(fm[k]);
    if (l === null) invalid(k, 'expected a string or a list of strings');
    else fields[k] = l;
  };
  const bool = (k: 'pinned' | 'untrusted_origin') => {
    if (!has(k)) return;
    if (typeof fm[k] === 'boolean') fields[k] = fm[k];
    else invalid(k, 'expected true or false');
  };

  if (has('schema')) {
    const v = fm.schema;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) fields.schema = v;
    else invalid('schema', 'expected a positive integer');
  }
  str('id');
  if (fields.id !== null && explicitId(fields.id) === null) {
    invalid('id', `expected [A-Za-z0-9_]+ not starting with ${PROVISIONAL_PREFIX}; a provisional id is used`);
  }
  str('author');
  str('superseded_by');
  str('merged_into');
  list('sources');
  list('supersedes');
  list('derived_from');
  for (const k of ['sources', 'derived_from'] as const) {
    for (const entry of fields[k]) {
      const c = parseCitation(entry);
      if (!c.ok) invalid(k, `not a citation (${c.error}): ${JSON.stringify(entry.slice(0, 100))}`);
    }
  }
  bool('pinned');
  bool('untrusted_origin');

  let statusKnown = true;
  if (has('status')) {
    const v = fm.status;
    fields.status = typeof v === 'string' ? v : canonicalJson(v);
    if (!(STATUSES as readonly string[]).includes(fields.status)) {
      statusKnown = false;
      problems.push({ kind: 'unknown_status', field: 'status', detail: fields.status });
    }
  }
  if (has('kind')) {
    const v = fm.kind;
    if (typeof v !== 'string') invalid('kind', 'expected a string');
    else {
      fields.kind = v;
      if (!(KINDS as readonly string[]).includes(v)) invalid('kind', `unknown kind ${JSON.stringify(v)}`);
    }
  }
  if (has('origin')) {
    const v = fm.origin;
    if (typeof v !== 'string') invalid('origin', 'expected a string');
    else {
      fields.origin = v;
      if (!(ORIGINS as readonly string[]).includes(v)) invalid('origin', `unknown origin ${JSON.stringify(v)}`);
    }
  }
  if (has('scrubVersion')) {
    const v = fm.scrubVersion;
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) fields.scrubVersion = String(v);
    else invalid('scrubVersion', 'expected a string or number');
  }
  for (const f of DATE_FIELDS) {
    if (!has(f)) continue;
    const v = fm[f];
    if (typeof v === 'string' && isIsoDate(v)) fields[f] = v;
    else problems.push({ kind: 'invalid_date', field: f, detail: canonicalJson(v) });
  }
  return { fields, statusKnown };
}

function cleanTag(tag: string): string {
  return nfc(tag.trim().replace(/^#+/, '')).toLowerCase();
}

export interface ParseOptions {
  maxChunkChars?: number;
}

export function parseNote(relPath: string, data: Uint8Array, opts: ParseOptions = {}): ParsedNote {
  const problems: Problem[] = [];
  const { text, invalidUtf8 } = decodeNote(data);
  if (invalidUtf8) problems.push({ kind: 'invalid_utf8', field: null, detail: 'invalid UTF-8 sequences replaced' });

  const split = splitFrontmatter(text);
  let frontmatter: ParsedNote['frontmatter'] = 'none';
  let fm: Record<string, unknown> = {};
  if (split.unclosed) {
    frontmatter = 'malformed';
    problems.push({ kind: 'malformed_frontmatter', field: null, detail: 'frontmatter block is not closed' });
  } else if (split.yaml !== null) {
    const doc = parseDocument(split.yaml, { schema: 'core', prettyErrors: false, uniqueKeys: true });
    let value: unknown;
    let error = doc.errors[0]?.message;
    if (error === undefined) {
      try {
        value = doc.toJS({ maxAliasCount: 100 });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (error === undefined && value !== null && value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
      error = 'frontmatter is not a mapping';
    }
    if (error !== undefined) {
      frontmatter = 'malformed';
      problems.push({ kind: 'malformed_frontmatter', field: null, detail: error.split('\n')[0]!.slice(0, 200) });
    } else {
      frontmatter = 'ok';
      fm = (value ?? {}) as Record<string, unknown>;
    }
  }
  // A closed block is skipped even when its YAML is malformed; an unclosed
  // one has no boundary, so the whole text is body.
  const body = split.unclosed ? text : split.body;
  const bodyLine = split.unclosed ? 1 : split.bodyLine;

  const { fields, statusKnown } = interpretFields(fm, problems);
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(fm)) if (!KNOWN_KEYS.has(k)) extra[k] = fm[k];

  const lines = scanLines(body, bodyLine);
  const headings: ParsedNote['headings'] = [];
  const links: WikiLink[] = [];
  const tagSet = new Map<string, 'frontmatter' | 'inline'>();
  for (const k of ['tags', 'tag'] as const) {
    if (fm[k] === undefined || fm[k] === null) continue;
    const raw = typeof fm[k] === 'string' ? (fm[k] as string).split(/[\s,]+/) : stringList(fm[k]);
    if (raw === null) problems.push({ kind: 'invalid_field', field: k, detail: 'expected a string or a list of strings' });
    else for (const t of raw.map(cleanTag)) if (t !== '' && !tagSet.has(t)) tagSet.set(t, 'frontmatter');
  }
  for (const l of lines) {
    if (l.fence) continue;
    if (l.heading) headings.push({ level: l.heading.level, text: l.heading.text, line: l.line });
    const masked = maskInlineCode(l.text);
    links.push(...extractWikiLinks(masked, l.line));
    for (const t of extractInlineTags(masked).map(cleanTag)) if (t !== '' && !tagSet.has(t)) tagSet.set(t, 'inline');
  }

  const aliases: string[] = [];
  for (const k of ['aliases', 'alias'] as const) {
    if (fm[k] === undefined || fm[k] === null) continue;
    const l = stringList(fm[k]);
    if (l === null) problems.push({ kind: 'invalid_field', field: k, detail: 'expected a string or a list of strings' });
    else for (const a of l.map((s) => nfc(s.trim()))) if (a !== '' && !aliases.includes(a)) aliases.push(a);
  }

  let title: string | undefined;
  if (fm.title !== undefined && fm.title !== null) {
    if (typeof fm.title === 'string' && fm.title.trim() !== '') title = fm.title.trim();
    else problems.push({ kind: 'invalid_field', field: 'title', detail: 'expected a non-empty string' });
  }
  title ??= headings.find((h) => h.level === 1 && h.text !== '')?.text;
  title ??= noteBasename(relPath);

  return {
    rev: revOf(text),
    title: nfc(title),
    frontmatter,
    fields,
    statusKnown,
    aliases,
    tags: [...tagSet].map(([tag, source]) => ({ tag, source })).sort((a, b) => compareBytes(a.tag, b.tag)),
    headings,
    links,
    extra,
    body,
    chunks: chunkBody(lines, opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS),
    problems,
  };
}
