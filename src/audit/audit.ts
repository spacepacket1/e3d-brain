// The audit log (Phase 5). Every MCP tool call, in every mode, appends
// exactly one JSON line to `<stateDir>/audit.jsonl`, written from `dispatch`.
//
// What a line may contain: tool name, principal, mode, outcome, counts,
// sizes, the result-set `recall_id`, the `{id, rev}` of returned notes, and
// an `args_summary` of paths, ids, and counts. Never note bodies, query text,
// credentials, or rejection details (a rejection is logged by type and a
// short code: the detector or limit type).
//
// Segments: `audit.jsonl` is segment 0, then `audit.jsonl.1`, `.2`, ... New
// lines go to the highest-numbered segment. When it has reached
// `maxSegmentBytes`, the next segment is created under the cross-process
// lock `<stateDir>/locks/audit.lock` (the decision is re-checked under the
// lock, so concurrent writers start exactly one new segment). Earlier
// segments are never rewritten; a writer that raced a rotation may still
// land a line in the previous segment. The server never truncates a
// segment; only the owner-run `ebrain audit prune` deletes whole old ones.
//
// Each line is one write(2) on an O_APPEND descriptor (file mode 0600) and
// at most MAX_LINE_BYTES long, so several MCP processes can share the log
// without torn lines.

import { isNoteId, isRev } from '../cite/citation.js';
import { withLock } from '../lock.js';
import type { DispatchRecord } from '../mcp/dispatch.js';
import type { ObjectSchema, Schema } from '../mcp/schema.js';
import {
  appendSafe,
  createExclusive,
  readDirSafe,
  readFileSafe,
  resolveInState,
  SafePathError,
  statSafe,
  unlinkSafe,
  type SafePath,
} from '../safe-path.js';

export const AUDIT_FILE = 'audit.jsonl';
export const AUDIT_LOCK = 'audit';
export const MAX_LINE_BYTES = 8192;
const SEGMENT_RE = /^audit\.jsonl(?:\.([1-9][0-9]{0,8}))?$/;
const MAX_SUMMARY_ITEMS = 20;
const MAX_PATH_CHARS = 512;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const REDACTED = '[redacted]';

/** How a tool argument may appear in the audit line. Unannotated strings are redacted. */
export type AuditArgKind = 'path' | 'id';
export type AuditArgKinds = Readonly<Record<string, AuditArgKind>>;

export interface AuditLine {
  ts: string;
  principal: string;
  mode: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_count?: number;
  bytes_returned: number;
  outcome: string;
  error?: { type: string; code?: string };
  recall_id?: string;
  returned?: { id: string; rev: string }[];
  returned_truncated?: true;
}

// ---------------------------------------------------------------------------
// Argument summaries

// Declared path/id values are logged verbatim, so a value with a well-known
// credential shape is redacted anyway (a caller pasting a token into an id
// field). Phase 7's scrubber is the general detector; this is a backstop.
const CREDENTIAL_SHAPES = [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, /\b(?:sk|rk)[-_][A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bxox[abprs]-/, /\beyJ[A-Za-z0-9_-]{8,}\./];

function looksLikeCredential(v: string): boolean {
  return CREDENTIAL_SHAPES.some((re) => re.test(v));
}

function isPathLike(v: string): boolean {
  return v.length > 0 && v.length <= MAX_PATH_CHARS && !/[\p{Cc}\p{Cf}\\]/u.test(v) && !v.startsWith('/');
}

function isIdLike(v: string): boolean {
  if (v.length > 256 || /[\s\p{Cc}\p{Cf}]/u.test(v)) return false;
  if (isNoteId(v)) return true;
  // `note:<id>@<rev>` style references (ids and revisions only).
  const m = /^note:([^@#]+)(?:@([0-9a-f]+))?$/.exec(v);
  return m !== null && isNoteId(m[1]!) && (m[2] === undefined || isRev(m[2]));
}

function summarizeString(v: string, schema: Schema | undefined, kind: AuditArgKind | undefined): string {
  if (schema !== undefined && !('anyOf' in schema) && schema.type === 'string' && schema.enum?.includes(v)) return v;
  if (kind === undefined || looksLikeCredential(v)) return REDACTED;
  if (kind === 'path' && isPathLike(v)) return v;
  if (kind === 'id' && isIdLike(v)) return v;
  return REDACTED;
}

/** Schemas a value may have matched (anyOf branches flattened). */
function branches(schema: Schema | undefined): Schema[] {
  if (schema === undefined) return [];
  if ('anyOf' in schema) return schema.anyOf.flatMap((s) => branches(s));
  return [schema];
}

function summarizeValue(v: unknown, schema: Schema | undefined, kind: AuditArgKind | undefined, depth: number): unknown {
  const forms = branches(schema);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const str = forms.find((s) => !('anyOf' in s) && s.type === 'string');
    return summarizeString(v, str, kind);
  }
  if (Array.isArray(v)) {
    const arr = forms.find((s) => !('anyOf' in s) && s.type === 'array') as Extract<Schema, { type: 'array' }> | undefined;
    const items = v.slice(0, MAX_SUMMARY_ITEMS).map((x) => summarizeValue(x, arr?.items, kind, depth + 1));
    const out: Record<string, unknown> = { count: v.length };
    // A list of redacted strings says nothing beyond its count.
    if (items.some((x) => x !== REDACTED)) out.items = items;
    return out;
  }
  if (typeof v === 'object' && v !== null && depth < 4) {
    const obj = forms.find((s) => !('anyOf' in s) && s.type === 'object') as ObjectSchema | undefined;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = summarizeValue(x, obj?.properties[k], undefined, depth + 1);
    return out;
  }
  return REDACTED;
}

/**
 * Reduce validated tool arguments to paths, ids, and counts: numbers,
 * booleans, and schema enum values are kept; strings are kept only for
 * top-level arguments the tool annotated as `path` or `id` and only when they
 * have that shape; every other string becomes "[redacted]"; arrays become
 * `{count, items?}`.
 */
export function summarizeArgs(args: Readonly<Record<string, unknown>> | undefined, schema?: ObjectSchema, kinds: AuditArgKinds = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args === undefined) return out;
  for (const [k, v] of Object.entries(args)) out[k] = summarizeValue(v, schema?.properties[k], Object.hasOwn(kinds, k) ? kinds[k] : undefined, 1);
  return out;
}

// ---------------------------------------------------------------------------
// Line building

/** Build the audit line for a dispatch record (args already summarized). */
export function auditLine(record: DispatchRecord, argsSummary: Record<string, unknown>, now: Date = new Date()): AuditLine {
  const line: AuditLine = {
    ts: now.toISOString(),
    principal: record.principal,
    mode: record.mode,
    // Caller text is never logged: an unknown or malformed tool name is just "(unknown)".
    tool: record.unknown_tool || !TOOL_RE.test(record.tool) ? '(unknown)' : record.tool,
    args_summary: argsSummary,
    bytes_returned: record.bytes_returned,
    outcome: record.outcome,
  };
  if (record.result_count !== undefined) line.result_count = record.result_count;
  if (record.error !== undefined) {
    line.error = { type: record.error.type };
    if (record.error.code !== undefined && CODE_RE.test(record.error.code)) line.error.code = record.error.code;
  }
  if (record.recall_id !== undefined && TOKEN_RE.test(record.recall_id)) line.recall_id = record.recall_id;
  if (record.returned !== undefined) {
    line.returned = record.returned.filter((r) => TOKEN_RE.test(r.id) && TOKEN_RE.test(r.rev)).map((r) => ({ id: r.id, rev: r.rev }));
    if (line.returned.length !== record.returned.length) line.returned_truncated = true;
  }
  return line;
}

/**
 * Serialize a line within MAX_LINE_BYTES (newline included). Past the cap the
 * `returned` list is cut (with `returned_truncated: true`); if that is not
 * enough, the argument summary is replaced by a marker.
 */
export function serializeLine(line: AuditLine, maxBytes = MAX_LINE_BYTES): string {
  const fits = (l: AuditLine) => {
    const s = `${JSON.stringify(l)}\n`;
    return Buffer.byteLength(s) <= maxBytes ? s : undefined;
  };
  const whole = fits(line);
  if (whole !== undefined) return whole;
  let current = line;
  if (line.returned !== undefined && line.returned.length > 0) {
    // Binary search the longest prefix of `returned` that fits.
    let lo = 0;
    let hi = line.returned.length - 1;
    let best: string | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = fits({ ...line, returned: line.returned.slice(0, mid), returned_truncated: true });
      if (s !== undefined) {
        best = s;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best !== undefined) return best;
    current = { ...line, returned: [], returned_truncated: true };
  }
  const reduced = fits({ ...current, args_summary: { truncated: true } });
  if (reduced !== undefined) return reduced;
  throw new Error('audit line exceeds the size cap');
}

// ---------------------------------------------------------------------------
// Segments

export interface Segment {
  /** 0 for `audit.jsonl`, n for `audit.jsonl.n`. */
  index: number;
  name: string;
  path: SafePath;
}

function segmentName(index: number): string {
  return index === 0 ? AUDIT_FILE : `${AUDIT_FILE}.${index}`;
}

/** All audit segments in the state dir, in numeric order. */
export function listSegments(stateDir: SafePath): Segment[] {
  const out: Segment[] = [];
  for (const e of readDirSafe(stateDir)) {
    const m = SEGMENT_RE.exec(e.name);
    if (m === null || !e.isFile()) continue;
    const index = m[1] === undefined ? 0 : Number(m[1]);
    out.push({ index, name: e.name, path: resolveInState(stateDir, e.name) });
  }
  return out.sort((a, b) => a.index - b.index);
}

function currentSegment(stateDir: SafePath): Segment {
  const segs = listSegments(stateDir);
  if (segs.length > 0) return segs[segs.length - 1]!;
  return { index: 0, name: AUDIT_FILE, path: resolveInState(stateDir, AUDIT_FILE) };
}

function sizeOf(p: SafePath): number {
  return statSafe(p)?.size ?? 0;
}

export interface AuditLogOptions {
  /** Segment size threshold in bytes (from `audit.maxSegmentMB`). */
  maxSegmentBytes: number;
  /** Lock wait for the rotation decision (default 10 s). */
  lockWaitMs?: number;
  now?: () => Date;
}

/** Appends audit lines for one server process. Holds no open descriptors between writes. */
export class AuditLog {
  readonly stateDir: SafePath;
  private readonly maxSegmentBytes: number;
  private readonly lockWaitMs: number | undefined;
  private readonly now: () => Date;

  constructor(stateDir: SafePath, opts: AuditLogOptions) {
    if (!(opts.maxSegmentBytes > 0)) throw new Error('maxSegmentBytes must be positive');
    this.stateDir = stateDir;
    this.maxSegmentBytes = opts.maxSegmentBytes;
    this.lockWaitMs = opts.lockWaitMs;
    this.now = opts.now ?? (() => new Date());
  }

  /** Append one serialized line (must end with a newline and fit the cap). */
  appendRaw(text: string): void {
    if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw new Error('audit line must be one line');
    if (Buffer.byteLength(text) > MAX_LINE_BYTES) throw new Error('audit line exceeds the size cap');
    let seg = currentSegment(this.stateDir);
    if (sizeOf(seg.path) >= this.maxSegmentBytes) seg = this.rotate();
    appendSafe(seg.path, text);
  }

  /** Write the line for one dispatch record. */
  write(record: DispatchRecord, argsSummary: Record<string, unknown>): void {
    this.appendRaw(serializeLine(auditLine(record, argsSummary, this.now())));
  }

  /** Under the lock: start the next segment unless another writer already did. */
  private rotate(): Segment {
    const opts = this.lockWaitMs === undefined ? {} : { waitMs: this.lockWaitMs };
    return withLock(
      this.stateDir,
      AUDIT_LOCK,
      () => {
        const seg = currentSegment(this.stateDir);
        if (sizeOf(seg.path) < this.maxSegmentBytes) return seg;
        const index = seg.index + 1;
        const next: Segment = { index, name: segmentName(index), path: resolveInState(this.stateDir, segmentName(index)) };
        try {
          createExclusive(next.path, '', { strategy: 'excl' });
        } catch (err) {
          if (!(err instanceof SafePathError && err.code === 'exists')) throw err;
        }
        return next;
      },
      opts,
    );
  }
}

/** Bytes for a `audit.maxSegmentMB` value. */
export function segmentBytes(maxSegmentMB: number): number {
  return Math.max(1, Math.floor(maxSegmentMB * 1024 * 1024));
}

// ---------------------------------------------------------------------------
// Readers (`ebrain audit tail|stats`, later rollups) and prune

export interface ReadResult {
  lines: AuditLine[];
  /** Lines that were not valid JSON objects (for example a partial last line mid-write). */
  malformed: number;
  segments: Segment[];
  bytes: number;
}

function parseSegment(text: string, into: AuditLine[]): number {
  let malformed = 0;
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    try {
      const v = JSON.parse(raw) as unknown;
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) into.push(v as AuditLine);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return malformed;
}

/** Read every segment in numeric order. */
export function readAudit(stateDir: SafePath): ReadResult {
  const segments = listSegments(stateDir);
  const lines: AuditLine[] = [];
  let malformed = 0;
  let bytes = 0;
  for (const s of segments) {
    const text = readFileSafe(s.path, 'utf8');
    bytes += Buffer.byteLength(text);
    malformed += parseSegment(text, lines);
  }
  return { lines, malformed, segments, bytes };
}

/** The last `n` lines across all segments, oldest first. Reads segments newest-first only as far as needed. */
export function tailAudit(stateDir: SafePath, n: number): string[] {
  const segments = listSegments(stateDir);
  const out: string[] = [];
  for (let i = segments.length - 1; i >= 0 && out.length < n; i--) {
    const rows = readFileSafe(segments[i]!.path, 'utf8').split('\n').filter((l) => l !== '');
    out.unshift(...rows.slice(Math.max(0, rows.length - (n - out.length))));
  }
  return out;
}

export interface AuditStats {
  segments: { name: string; bytes: number; lines: number }[];
  lines: number;
  malformed: number;
  byOutcome: Record<string, number>;
  byTool: Record<string, number>;
  byPrincipal: Record<string, number>;
  first?: string;
  last?: string;
}

function bump(m: Record<string, number>, k: unknown): void {
  const key = typeof k === 'string' ? k : '(none)';
  m[key] = (m[key] ?? 0) + 1;
}

export function auditStats(stateDir: SafePath): AuditStats {
  const stats: AuditStats = { segments: [], lines: 0, malformed: 0, byOutcome: {}, byTool: {}, byPrincipal: {} };
  for (const s of listSegments(stateDir)) {
    const text = readFileSafe(s.path, 'utf8');
    const lines: AuditLine[] = [];
    stats.malformed += parseSegment(text, lines);
    stats.segments.push({ name: s.name, bytes: Buffer.byteLength(text), lines: lines.length });
    for (const l of lines) {
      stats.lines++;
      bump(stats.byOutcome, l.outcome);
      bump(stats.byTool, l.tool);
      bump(stats.byPrincipal, l.principal);
      if (typeof l.ts === 'string') {
        if (stats.first === undefined) stats.first = l.ts;
        stats.last = l.ts;
      }
    }
  }
  return stats;
}

/**
 * Delete whole segments whose last write is older than `olderThanDays`,
 * oldest first, stopping at the first newer one. The current (highest)
 * segment is never deleted, and no segment is ever truncated or rewritten.
 * Runs under the audit lock so it cannot race a rotation.
 */
export function pruneAudit(stateDir: SafePath, olderThanDays: number, now: number = Date.now()): string[] {
  const cutoff = now - olderThanDays * 86_400_000;
  return withLock(stateDir, AUDIT_LOCK, () => {
    const segments = listSegments(stateDir);
    const deleted: string[] = [];
    for (const s of segments.slice(0, -1)) {
      const st = statSafe(s.path);
      if (st === undefined || !st.isFile() || st.mtimeMs >= cutoff) break;
      unlinkSafe(s.path);
      deleted.push(s.name);
    }
    return deleted;
  });
}
