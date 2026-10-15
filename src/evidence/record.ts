// One evidence record per JSONL line (cognition Phase 3). Pure: nothing here
// touches the filesystem or the network.
//
//   {"kind":"thesis","id":"th_123","occurred":"2026-09-01T00:00:00Z",
//    "summary":"short text","attributes":{"agent":"0x...","status":"closed"}}
//
// The format is closed: unknown top-level keys make the line malformed. Lines
// are checked against the per-record byte limit before parsing, against the
// nesting limit before `JSON.parse` (a pre-scan, so hostile nesting never
// reaches the parser), and again against the byte limit after scrubbing.
// `summary` and every string in `attributes` pass the scrubber; in strict mode
// (agent brains) a credential rejects the whole record.

import { isNoteId } from '../cite/citation.js';
import { scrub, type ScrubOptions } from '../scrub/scrub.js';

/** `kind`: lowercase, starts with a letter. Citable kinds are `thesis` and `outcome` (Phase 3 grammar). */
export const EVIDENCE_KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Attribute keys: identifiers. */
export const ATTRIBUTE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_SUMMARY_CHARS = 1000;
/** Most attribute values (every scalar, array, and object counts), so a record cannot be a huge flat bag. */
export const MAX_ATTRIBUTE_VALUES = 256;
/** Nesting depth: the record object is 1, `attributes` is 2, so attribute values nest at most two more levels. */
export const MAX_RECORD_DEPTH = 4;
/** `occurred`: an ISO 8601 UTC timestamp (`Z`), optional fractional seconds. */
const OCCURRED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const RECORD_KEYS = new Set(['kind', 'id', 'occurred', 'summary', 'attributes']);

export type AttributeValue = string | number | boolean | null | AttributeValue[] | { [key: string]: AttributeValue };
export type Attributes = { [key: string]: AttributeValue };

export interface EvidenceRecord {
  kind: string;
  id: string;
  /** Normalized to `toISOString()` form (milliseconds, `Z`). */
  occurred: string;
  /** Scrubbed. */
  summary: string;
  /** Scrubbed; keys sorted. */
  attributes: Attributes;
}

/** Why a line was skipped. Never carries the line's text. */
export type SkipReason = 'malformed' | 'too_large' | 'too_deep' | 'scrub_rejected';
export const SKIP_REASONS: readonly SkipReason[] = ['malformed', 'too_large', 'too_deep', 'scrub_rejected'];

export type LineResult =
  | { ok: true; record: EvidenceRecord; canonical: string; findings: number }
  | { ok: false; reason: SkipReason };

export interface RecordLimits {
  maxRecordBytes: number;
  scrub: ScrubOptions;
}

class Skip extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

/** Deepest `{`/`[` nesting outside strings, stopping as soon as `limit` is exceeded. */
export function jsonDepthExceeds(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > limit) return true;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `toISOString()` of a valid UTC timestamp (calendar-checked), else undefined. */
export function normalizeOccurred(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = OCCURRED_RE.exec(value);
  if (!m) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const iso = d.toISOString();
  // Reject rollovers such as 2026-02-30 or 24:00:00.
  if (iso.slice(0, 19) !== value.slice(0, 19)) return undefined;
  return iso;
}

function scrubText(text: string, opts: ScrubOptions, counter: { findings: number }): string {
  const r = scrub(text, opts);
  if (!r.ok) throw new Skip('scrub_rejected');
  counter.findings += r.findings.reduce((n, f) => n + f.count, 0);
  return r.text;
}

function cleanValue(v: unknown, opts: ScrubOptions, counter: { findings: number; values: number }): AttributeValue {
  if (++counter.values > MAX_ATTRIBUTE_VALUES) throw new Skip('too_large');
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Skip('malformed');
    return v;
  }
  if (typeof v === 'string') return scrubText(v, opts, counter);
  if (Array.isArray(v)) return v.map((x) => cleanValue(x, opts, counter));
  if (isPlainObject(v)) return cleanObject(v, opts, counter);
  throw new Skip('malformed');
}

function cleanObject(obj: Record<string, unknown>, opts: ScrubOptions, counter: { findings: number; values: number }): Attributes {
  const out: Attributes = {};
  for (const key of Object.keys(obj).sort()) {
    if (!ATTRIBUTE_KEY_RE.test(key)) throw new Skip('malformed');
    // Keys are text too: a key the scrubber would change is refused, not rewritten.
    if (scrubText(key, opts, { findings: 0 }) !== key) throw new Skip('scrub_rejected');
    out[key] = cleanValue(obj[key], opts, counter);
  }
  return out;
}

function parseOrSkip(line: string, limits: RecordLimits): { record: EvidenceRecord; canonical: string; findings: number } {
  if (Buffer.byteLength(line, 'utf8') > limits.maxRecordBytes) throw new Skip('too_large');
  if (jsonDepthExceeds(line, MAX_RECORD_DEPTH)) throw new Skip('too_deep');
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Skip('malformed');
  }
  if (!isPlainObject(raw)) throw new Skip('malformed');
  for (const key of Object.keys(raw)) if (!RECORD_KEYS.has(key)) throw new Skip('malformed');
  const { kind, id, summary } = raw;
  if (typeof kind !== 'string' || !EVIDENCE_KIND_RE.test(kind)) throw new Skip('malformed');
  if (typeof id !== 'string' || !isNoteId(id)) throw new Skip('malformed');
  const occurred = normalizeOccurred(raw['occurred']);
  if (occurred === undefined) throw new Skip('malformed');
  if (typeof summary !== 'string' || summary.trim() === '' || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(summary)) throw new Skip('malformed');
  if (summary.length > MAX_SUMMARY_CHARS) throw new Skip('too_large');
  const attrsRaw = raw['attributes'] ?? {};
  if (!isPlainObject(attrsRaw)) throw new Skip('malformed');

  const counter = { findings: 0, values: 0 };
  const cleanSummary = scrubText(summary, limits.scrub, counter);
  if (cleanSummary.length > MAX_SUMMARY_CHARS) throw new Skip('too_large');
  const attributes = cleanObject(attrsRaw, limits.scrub, counter);
  const record: EvidenceRecord = { kind, id, occurred, summary: cleanSummary, attributes };
  const canonical = JSON.stringify(record);
  // Scrubbing may lengthen text (redaction tokens); the stored record never exceeds the limit.
  if (Buffer.byteLength(canonical, 'utf8') > limits.maxRecordBytes) throw new Skip('too_large');
  return { record, canonical, findings: counter.findings };
}

/** Validate and scrub one line (without its newline; a trailing CR is ignored). */
export function parseEvidenceLine(line: string, limits: RecordLimits): LineResult {
  try {
    return { ok: true, ...parseOrSkip(line.endsWith('\r') ? line.slice(0, -1) : line, limits) };
  } catch (err) {
    if (err instanceof Skip) return { ok: false, reason: err.reason };
    throw err;
  }
}

/** Per-file line counts: `lines` non-blank lines, `records` accepted, the rest skipped by reason. */
export interface LineCounts {
  lines: number;
  records: number;
  skipped: Record<SkipReason, number>;
  /** Total scrubber findings across accepted records (counts only). */
  findings: number;
}

export function emptyCounts(): LineCounts {
  return { lines: 0, records: 0, skipped: { malformed: 0, too_large: 0, too_deep: 0, scrub_rejected: 0 }, findings: 0 };
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Split file bytes into lines and parse each one. A line that is not valid
 * UTF-8 is malformed (the rest of the file still loads). Blank lines are
 * ignored; a leading BOM on the first line is dropped.
 */
export function parseEvidenceBuffer(data: Uint8Array, limits: RecordLimits, onRecord: (r: { record: EvidenceRecord; canonical: string; line: number }) => void): LineCounts {
  const counts = emptyCounts();
  let start = 0;
  let lineNo = 0;
  while (start <= data.length) {
    let end = data.indexOf(0x0a, start);
    if (end < 0) end = data.length;
    lineNo++;
    let bytes = data.subarray(start, end);
    start = end + 1;
    if (lineNo === 1 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 0x0d)) continue;
    counts.lines++;
    if (bytes.length > limits.maxRecordBytes + 1) {
      counts.skipped.too_large++;
      continue;
    }
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      counts.skipped.malformed++;
      continue;
    }
    if (text.trim() === '') {
      counts.lines--;
      continue;
    }
    const r = parseEvidenceLine(text, limits);
    if (!r.ok) {
      counts.skipped[r.reason]++;
      continue;
    }
    counts.records++;
    counts.findings += r.findings;
    onRecord({ record: r.record, canonical: r.canonical, line: lineNo });
  }
  return counts;
}
