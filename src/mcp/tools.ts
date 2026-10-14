// The MCP read tools (Phase 6): search, read_note, list_notes, related.
// `search` gains `scope` in Phase 11 (notes, raw, refs, all): reference-book
// passages come from `<stateDir>/refs.db`, opened read-only per call.
// Available in every mode. Each is registered through `registerTool`
// (dispatch is the only path to a handler), calls `refreshIndex()` before it
// reads, and orders results only through `rank()` (I13).
//
// Response layout: one server-written text part (a JSON header with the
// tool, `recall_id`, format, and counts; never note text), then one data part
// that dispatch fences (I6). For lists the data part is JSON Lines, one
// result per line, so note text (titles, excerpts) is JSON-escaped and cannot
// fake a result boundary; for read_note it is the metadata line, a blank
// line, and the note text. Handlers fit whole results into the call's size
// cap, so `returned` (audited) lists exactly the notes the caller received.

import { formatCitation, type NoteCitation } from '../cite/citation.js';
import { refreshIndex, MAX_NOTE_BYTES, type IndexHandle } from '../index/indexer.js';
import {
  allNoteRows, firstChunkText, ftsQuery, neighbours, noteRowByPath, searchChunks, tagsByPath, type NoteRow,
} from '../index/query.js';
import { effectiveTier, HIDDEN_STATUSES, rank, type RankItem, type TierOrHidden } from '../index/rank.js';
import { nfc, type FolderClass } from '../vault/names.js';
import { decodeNote, isIsoDate, revOf, STATUSES } from '../vault/parse.js';
import { readFileWithStatSafe, resolveInVault, SafePathError, type SafePath } from '../safe-path.js';
import { openRefsDbReadOnly, refCitation, refLabel, searchRefChunks, type RefHit } from '../refs/db.js';
import type { Mode } from '../config.js';
import { MODES, registerTool, ToolRejection, type ReturnedNote, type ToolRegistry, type ToolResult } from './dispatch.js';
import { fence, truncateText } from './fence.js';
import { MAX_CHARS_SCHEMA, type ObjectSchema, type Schema } from './schema.js';
import { ulid } from './ulid.js';

/** Excerpt length in compact format (I6). */
export const COMPACT_EXCERPT_CHARS = 200;
/** Excerpt length of a full-format search result. */
export const SEARCH_EXCERPT_CHARS = 1000;
/** Excerpt length of a full-format list_notes result. */
export const LIST_EXCERPT_CHARS = 300;

export const SEARCH_LIMIT = { default: 10, max: 50 };
export const LIST_LIMIT = { default: 50, max: 200 };
export const RELATED_LIMIT = { default: 10, max: 50 };

export type Format = 'full' | 'compact';

/** `search` scopes (Phase 11): vault notes (default; raw archive included at T6), only the raw archive, only reference books, or both. */
export const SEARCH_SCOPES = ['notes', 'raw', 'refs', 'all'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** Where `search` finds reference books, and its per-call output limits (config `refs`). */
export interface RefsEnv {
  stateDir: SafePath;
  excerptChars: number;
  maxHits: number;
}

export interface ReadToolEnv {
  vaultPath: string;
  index: IndexHandle;
  /** The instance mode; in `journal` mode search and list_notes accept `include_expired` (Phase 9). */
  mode?: Mode;
  /** Clock for the default `as_of` (tests inject one). */
  now?: () => Date;
  /** The reference library (Phase 11); without it `scope: refs` finds nothing. */
  refs?: RefsEnv;
}

// ---- schemas ----

const FORMAT_SCHEMA: Schema = {
  type: 'string',
  enum: ['full', 'compact'],
  description: '"compact" returns citations plus excerpts of at most 200 characters.',
};
const STATUS_ENUM: Schema = { type: 'string', enum: STATUSES };
const STATUS_SCHEMA: Schema = {
  anyOf: [STATUS_ENUM, { type: 'array', items: STATUS_ENUM, minItems: 1, maxItems: STATUSES.length }],
  description: 'Only notes with these statuses; also reveals notes hidden by default because of a listed status.',
};
const AS_OF_SCHEMA: Schema = {
  type: 'string',
  maxLength: 40,
  description: 'ISO 8601 date: evaluate validity windows and lifecycle (superseded_at, archived_at) at that time. Default: now.',
};
const FOLDER_SCHEMA: Schema = { type: 'string', minLength: 1, maxLength: 1024, description: 'Vault-relative folder.' };
const PATH_SCHEMA: Schema = { type: 'string', minLength: 1, maxLength: 4096, description: 'Vault-relative note path.' };
const TAG_SCHEMA: Schema = { type: 'string', minLength: 1, maxLength: 200 };
const INCLUDE_SUPERSEDED: Schema = { type: 'boolean', description: 'Also return superseded notes.' };
const INCLUDE_ARCHIVED: Schema = { type: 'boolean', description: 'Also return archived notes and notes under archive folders.' };
const INCLUDE_EXPIRED: Schema = { type: 'boolean', description: 'Also return journal entries past their `expires` date.' };

function limitSchema(l: { default: number; max: number }): Schema {
  return { type: 'integer', minimum: 1, maximum: l.max, description: `Maximum results (default ${l.default}).` };
}

export const SEARCH_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 1000, description: 'Search text (BM25 full-text).' },
    limit: limitSchema(SEARCH_LIMIT),
    tags: { type: 'array', items: TAG_SCHEMA, minItems: 1, maxItems: 20, description: 'Only notes with all of these tags.' },
    folder: FOLDER_SCHEMA,
    status: STATUS_SCHEMA,
    include_superseded: INCLUDE_SUPERSEDED,
    include_archived: INCLUDE_ARCHIVED,
    as_of: AS_OF_SCHEMA,
    advanced: {
      type: 'boolean',
      description: 'Pass the query to SQLite FTS5 unescaped (operators, phrases, prefixes). Default false: the query is plain words.',
    },
    scope: {
      type: 'string',
      enum: SEARCH_SCOPES,
      description:
        'What to search: "notes" (default: vault notes), "raw" (only the raw conversation archive), "refs" (only reference books: ' +
        'short excerpts with ref: citations; read more with read_ref_chunk), or "all" (notes, then books). Note filters apply to notes only.',
    },
    max_chars: MAX_CHARS_SCHEMA,
    format: FORMAT_SCHEMA,
  },
  required: ['query'],
};

/** `schema` plus `include_expired` (journal mode, Phase 9). */
function withIncludeExpired(schema: ObjectSchema): ObjectSchema {
  return { ...schema, properties: { ...schema.properties, include_expired: INCLUDE_EXPIRED } };
}

export const SEARCH_SCHEMA_JOURNAL: ObjectSchema = withIncludeExpired(SEARCH_SCHEMA);

export const READ_NOTE_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: { path: PATH_SCHEMA, max_chars: MAX_CHARS_SCHEMA, format: FORMAT_SCHEMA },
  required: ['path'],
};

export const LIST_NOTES_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    folder: FOLDER_SCHEMA,
    tag: TAG_SCHEMA,
    limit: limitSchema(LIST_LIMIT),
    status: STATUS_SCHEMA,
    include_superseded: INCLUDE_SUPERSEDED,
    include_archived: INCLUDE_ARCHIVED,
    as_of: AS_OF_SCHEMA,
    max_chars: MAX_CHARS_SCHEMA,
    format: FORMAT_SCHEMA,
  },
};

export const LIST_NOTES_SCHEMA_JOURNAL: ObjectSchema = withIncludeExpired(LIST_NOTES_SCHEMA);

export const RELATED_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: { path: PATH_SCHEMA, limit: limitSchema(RELATED_LIMIT), max_chars: MAX_CHARS_SCHEMA, format: FORMAT_SCHEMA },
  required: ['path'],
};

// ---- visibility (Phase 4 defaults, Phase 6 filters) ----

const DAY_MS = 86_400_000;

/**
 * Milliseconds for an ISO 8601 date or date-time (validated by `isIsoDate`).
 * Values without an offset are UTC. A bare date is the start of that day, or
 * its last millisecond with `edge: 'end'` (a `valid_until` date includes the
 * whole day).
 */
export function isoToMs(value: string, edge: 'start' | 'end' = 'start'): number | undefined {
  if (!isIsoDate(value)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    return edge === 'end' ? ms + DAY_MS - 1 : ms;
  }
  let s = value.replace(' ', 'T').replace(/\.(\d{1,3})\d*/, '.$1');
  if (/[+-]\d{4}$/.test(s)) s = `${s.slice(0, -2)}:${s.slice(-2)}`;
  else if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(s)) s += 'Z';
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

export interface Visibility {
  /** Listed statuses: only these, and hiding because of a listed status is lifted. */
  statuses?: readonly string[];
  includeSuperseded: boolean;
  includeArchived: boolean;
  /** Show journal entries past `expires` (Phase 9; default hidden). */
  includeExpired?: boolean;
  /** The `as_of` argument, when given. */
  asOf?: number;
  /** Now; the validity window is evaluated at `asOf ?? now`. */
  now: number;
}

/**
 * Status a result reports: the frontmatter value, or `accepted` for a
 * curated/reference note without one. A visible note in `_inbox/` is a
 * proposal whatever it claims (Phase 8): no status, or a claimed `accepted`,
 * reports `proposed`.
 */
export function effectiveStatus(row: Pick<NoteRow, 'status' | 'folder_class'> & Partial<Pick<NoteRow, 'folder_hidden'>>): string | null {
  if (row.folder_class === 'inbox' && row.folder_hidden !== 1 && (row.status === null || row.status === 'accepted')) return 'proposed';
  if (row.status !== null) return row.status;
  return row.folder_class === 'curated' || row.folder_class === 'reference' ? 'accepted' : null;
}

/** Header notice on any result list that contains inbox proposals (Phase 8). */
export const PROPOSED_NOTICE =
  'Results with folder_class "inbox" (status "proposed") are unreviewed proposals, not established facts; do not present them as such.';

/** Header notice on any result list that contains agent journal entries (Phase 9). */
export const JOURNAL_NOTICE =
  'Results labeled "agent-journal" were recorded by an agent without human review; "untrusted_origin" marks text derived from ' +
  'untrusted content. Neither is established fact or authority.';

/** Header notice on any result list that contains raw archive transcripts (Phase 10). */
export const RAW_NOTICE =
  'Results labeled "raw-archive" (kind "raw") are imported conversation transcripts, ranked below curated notes; they record what was said, ' +
  'not established facts.';

/** Header notice on any result list that contains reference-book passages (Phase 11). */
export const REFS_NOTICE =
  'Results with source "ref" are short excerpts of reference books the owner added; cite them by their ref: citation and read more ' +
  'with read_ref_chunk. They are reference material, not the owner\'s own notes.';

/** `{notice}` when any listed row lives in the inbox, the journal, or the raw archive (or `refs`: book passages are listed), else nothing. */
function proposedNotice(rows: readonly Pick<NoteRow, 'folder_class'>[], refs = false): Record<string, unknown> {
  const notices: string[] = [];
  if (rows.some((r) => r.folder_class === 'inbox')) notices.push(PROPOSED_NOTICE);
  if (rows.some((r) => r.folder_class === 'journal')) notices.push(JOURNAL_NOTICE);
  if (rows.some((r) => r.folder_class === 'raw')) notices.push(RAW_NOTICE);
  if (refs) notices.push(REFS_NOTICE);
  return notices.length === 0 ? {} : { notice: notices.join(' ') };
}

/** True for a journal entry whose `expires` lies before `at` (a bare date covers its whole day). */
export function isExpired(row: Pick<NoteRow, 'folder_class' | 'expires'>, at: number): boolean {
  if (row.folder_class !== 'journal' || row.expires === null) return false;
  const ms = isoToMs(row.expires, 'end');
  return ms !== undefined && ms < at;
}

/**
 * Result labels: `agent-journal` for journal entries, `raw-archive` for raw
 * archive transcripts, `untrusted_origin` where the note says so.
 */
export function labelsOf(row: Pick<NoteRow, 'folder_class' | 'untrusted_origin'> & { path?: string }): string[] {
  const labels: string[] = [];
  const journalArchive = row.folder_class === 'archive' && row.path !== undefined && /^journal\/_archive\//i.test(row.path);
  if (row.folder_class === 'journal' || journalArchive) labels.push('agent-journal');
  if (row.folder_class === 'raw') labels.push('raw-archive');
  if (row.untrusted_origin === 1) labels.push('untrusted_origin');
  return labels;
}

function sourcesOf(row: NoteRow): unknown[] {
  try {
    const v = JSON.parse(row.sources) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function tierOfRow(row: NoteRow): TierOrHidden {
  return effectiveTier(row.folder_class as FolderClass, row.status, {
    statusKnown: row.status_known === 1,
    folderHidden: row.folder_hidden === 1,
    kind: row.kind,
    sources: sourcesOf(row),
  });
}

function laterThan(value: string | null, asOf: number | undefined): boolean {
  if (value === null || asOf === undefined) return false;
  const ms = isoToMs(value);
  return ms !== undefined && ms > asOf;
}

/**
 * Whether a note is visible under the filters:
 *  - excluded when `valid_until` < at or `valid_from` > at (at = as_of, default now);
 *  - with `status`, only notes whose effective status is listed;
 *  - a note hidden by default (Phase 4) is shown only when every reason it is
 *    hidden is lifted: status `superseded` by `include_superseded`, a listed
 *    status, or (with `as_of`) `superseded_at` later than as_of; status
 *    `archived` and archive folders by `include_archived`, listing
 *    `archived`, or (with `as_of`) `archived_at` later than as_of; status
 *    `rejected` and `_inbox/_rejected|_applied/` only by a listed status.
 */
export function isVisible(row: NoteRow, v: Visibility): boolean {
  const at = v.asOf ?? v.now;
  if (row.valid_until !== null) {
    const until = isoToMs(row.valid_until, 'end');
    if (until !== undefined && until < at) return false;
  }
  if (row.valid_from !== null) {
    const from = isoToMs(row.valid_from, 'start');
    if (from !== undefined && from > at) return false;
  }
  const status = effectiveStatus(row);
  const listed = (s: string | null) => s !== null && v.statuses !== undefined && v.statuses.includes(s);
  if (v.statuses !== undefined && !listed(status)) return false;
  if (v.includeExpired !== true && isExpired(row, at)) return false;
  if (tierOfRow(row) !== 'hidden') return true;

  const statusHidden = row.status_known === 1 && row.status !== null && HIDDEN_STATUSES.includes(row.status);
  if (statusHidden) {
    const lifted =
      listed(row.status) ||
      (row.status === 'superseded' && (v.includeSuperseded || laterThan(row.superseded_at, v.asOf))) ||
      (row.status === 'archived' && (v.includeArchived || laterThan(row.archived_at, v.asOf)));
    if (!lifted) return false;
  }
  if (row.folder_class === 'archive') {
    if (!(v.includeArchived || listed('archived') || laterThan(row.archived_at, v.asOf))) return false;
  } else if (row.folder_hidden === 1 && !listed(status)) {
    return false;
  }
  return true;
}

// ---- result fields ----

/** The note citation, pinned to the revision, with an optional heading fragment (dropped if not citable). */
export function citationFor(row: Pick<NoteRow, 'id' | 'rev'>, heading?: string): string {
  const base: NoteCitation = { kind: 'note', id: row.id, rev: row.rev };
  if (heading !== undefined && heading !== '') {
    try {
      return formatCitation({ ...base, heading });
    } catch {
      // A heading the grammar refuses (control characters, too long): cite the note.
    }
  }
  return formatCitation(base);
}

/** The fields every note-bearing result carries. */
export function noteFields(row: NoteRow, tier?: TierOrHidden): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    provisional: row.provisional === 1,
    rev: row.rev,
    status: effectiveStatus(row),
    kind: row.kind,
    occurred: row.occurred,
    folder_class: row.folder_class,
    path: row.path,
  };
  if (tier !== undefined) out['tier'] = tier;
  const labels = labelsOf(row);
  if (labels.length > 0) {
    out['labels'] = labels;
    if (row.untrusted_origin === 1) out['untrusted_origin'] = true;
    if (labels.includes('agent-journal')) Object.assign(out, { author: row.author, expires: row.expires });
  }
  return out;
}

export function rankItem<T extends { row: NoteRow; ordinal?: number; bm25?: number }>(x: T): T & RankItem {
  const r = x.row;
  return {
    ...x,
    path: r.path,
    ordinal: x.ordinal ?? 0,
    folderClass: r.folder_class as FolderClass,
    status: r.status,
    statusKnown: r.status_known === 1,
    folderHidden: r.folder_hidden === 1,
    kind: r.kind,
    sources: sourcesOf(r),
    source: 'note',
    created: r.created,
  };
}

// ---- argument helpers ----

function formatArg(args: Record<string, unknown>): Format {
  return args['format'] === 'compact' ? 'compact' : 'full';
}

function limitArg(args: Record<string, unknown>, l: { default: number }): number {
  return typeof args['limit'] === 'number' ? args['limit'] : l.default;
}

function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function visibilityArgs(args: Record<string, unknown>, env: ReadToolEnv): Visibility {
  const v: Visibility = {
    includeSuperseded: bool(args, 'include_superseded'),
    includeArchived: bool(args, 'include_archived'),
    includeExpired: bool(args, 'include_expired'),
    now: (env.now ?? (() => new Date()))().getTime(),
  };
  const status = args['status'];
  if (typeof status === 'string') v.statuses = [status];
  else if (Array.isArray(status)) v.statuses = status as string[];
  if (typeof args['as_of'] === 'string') {
    const ms = isoToMs(args['as_of']);
    if (ms === undefined) throw new ToolRejection({ type: 'invalid', detail: 'argument "as_of" must be an ISO 8601 date or date-time' });
    v.asOf = ms;
  }
  return v;
}

function safePathRejection(err: unknown): never {
  if (err instanceof SafePathError) {
    const why = err.code === 'escape' ? 'it resolves outside the vault' : err.code === 'symlink' ? 'it is an unusable symlink' : 'it is not a valid vault-relative path';
    throw new ToolRejection({ type: 'invalid', detail: `path rejected: ${why}` });
  }
  throw err;
}

/** Validate a vault-relative path argument through safe-path (I1); returns it unchanged. */
function vaultPathArg(env: ReadToolEnv, value: string): string {
  try {
    resolveInVault(env.vaultPath, value);
  } catch (err) {
    safePathRejection(err);
  }
  return value;
}

/** A folder filter: validated through safe-path, as an NFC prefix ending in `/`. */
function folderArg(env: ReadToolEnv, args: Record<string, unknown>): string | undefined {
  const raw = args['folder'];
  if (typeof raw !== 'string') return undefined;
  const folder = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  vaultPathArg(env, folder);
  return `${nfc(folder)}/`;
}

function inFolder(path: string, prefix: string | undefined): boolean {
  return prefix === undefined || nfc(path).startsWith(prefix);
}

/** Tag text as the index stores it (NFC, no leading `#`, lowercase). */
export function normalizeTag(tag: string): string {
  return nfc(tag.trim().replace(/^#+/, '')).toLowerCase();
}

function refreshed(env: ReadToolEnv): IndexHandle {
  refreshIndex(env.index);
  return env.index;
}

// ---- output ----

function measure(lines: readonly string[], source: string | undefined): number {
  return fence(lines.join('\n'), source === undefined ? {} : { source })!.text.length;
}

/**
 * Build the response: a header text part and the fitted results as one
 * fenced JSON Lines data part. Results are added in order while the whole
 * response stays within `maxChars`; a result that does not fit ends the list
 * (the first one has its excerpt shortened rather than dropped when possible).
 */
export function listResponse(
  tool: string,
  format: Format,
  items: readonly { fields: Record<string, unknown>; excerpt?: string; returned?: ReturnedNote }[],
  maxChars: number,
  extra: Record<string, unknown> = {},
): ToolResult {
  const recall_id = ulid();
  const header = (included: number) =>
    JSON.stringify({ tool, recall_id, format, ...extra, count: included, omitted: items.length - included });
  // Budget for the data part: the cap less the widest header and the joining newline.
  const budget = maxChars - header(items.length).length - String(items.length).length - 1;
  const lines: string[] = [];
  const returned: ReturnedNote[] = [];
  const seen = new Set<string>();
  const line = (it: { fields: Record<string, unknown>; excerpt?: string }, excerpt?: string) =>
    JSON.stringify(excerpt === undefined ? it.fields : { ...it.fields, excerpt });
  for (const it of items) {
    let next = line(it, it.excerpt);
    if (measure([...lines, next], undefined) > budget) {
      if (lines.length > 0 || it.excerpt === undefined) break;
      // Shorten the first result's excerpt until it fits (JSON escaping makes this approximate).
      let excerpt = it.excerpt;
      let fitted = false;
      for (let i = 0; i < 8 && excerpt !== ''; i++) {
        const over = measure([line(it, excerpt)], undefined) - budget;
        excerpt = truncateText(excerpt, excerpt.length - Math.max(over, 1) - 8);
        if (measure([line(it, excerpt)], undefined) <= budget) {
          fitted = true;
          break;
        }
      }
      if (!fitted) break;
      next = line(it, excerpt);
    }
    lines.push(next);
    const id = it.returned?.id ?? String(it.fields['id']);
    const rev = it.returned?.rev ?? String(it.fields['rev']);
    if (!seen.has(`${id}@${rev}`)) {
      seen.add(`${id}@${rev}`);
      returned.push({ id, rev });
    }
  }
  const content: ToolResult['content'] =
    lines.length === 0
      ? [{ type: 'text', text: header(0) }]
      : [{ type: 'text', text: header(lines.length) }, { type: 'data', text: lines.join('\n') }];
  return { content, recall_id, returned, count: lines.length };
}

function excerptOf(text: string, format: Format, fullChars: number): string {
  return truncateText(text, format === 'compact' ? COMPACT_EXCERPT_CHARS : fullChars);
}

// ---- handlers ----

/** Reference-book matches as rank items (ordered among themselves as `reference` notes, after every note; rank.ts). */
function refCandidates(env: ReadToolEnv, match: string, advanced: boolean): (RankItem & { ref: RefHit })[] {
  if (env.refs === undefined) return [];
  const db = openRefsDbReadOnly(env.refs.stateDir);
  if (db === undefined) return [];
  try {
    let hits: RefHit[];
    try {
      hits = searchRefChunks(db, match);
    } catch (err) {
      if (advanced) throw new ToolRejection({ type: 'invalid', detail: 'advanced query is not valid FTS5 syntax' });
      throw err;
    }
    return hits.map((h) => ({
      ref: h,
      path: `${h.ref_id}/${String(h.chapter).padStart(10, '0')}`,
      ordinal: h.ordinal,
      folderClass: 'reference' as const,
      bm25: h.bm25,
      source: 'ref' as const,
    }));
  } finally {
    db.close();
  }
}

function refItem(h: RefHit, tier: TierOrHidden, format: Format, excerptChars: number) {
  const fields: Record<string, unknown> = {
    source: 'ref',
    ref_id: h.ref_id,
    chapter: h.chapter,
    ordinal: h.ordinal,
    tier,
    label: refLabel(h.title, h.chapter, h.chapter_heading),
    citation: refCitation(h.ref_id, h.chapter, h.ordinal),
  };
  if (h.heading !== null && h.heading !== h.chapter_heading) fields['heading'] = h.heading;
  if (format === 'full') Object.assign(fields, { title: h.title, book_author: h.author });
  const excerpt = truncateText(h.snippet, Math.min(excerptChars, format === 'compact' ? COMPACT_EXCERPT_CHARS : excerptChars));
  return { fields, excerpt, returned: { id: h.ref_id, rev: h.chunk_rev } };
}

function search(env: ReadToolEnv, args: Record<string, unknown>, maxChars: number): ToolResult {
  const format = formatArg(args);
  const scope = (typeof args['scope'] === 'string' ? args['scope'] : 'notes') as SearchScope;
  const vis = visibilityArgs(args, env);
  const folder = folderArg(env, args);
  const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]).map(normalizeTag) : [];
  const query = args['query'] as string;
  const advanced = bool(args, 'advanced');
  const limit = limitArg(args, SEARCH_LIMIT);
  const { db } = refreshed(env);

  const match = advanced ? query : ftsQuery(query);
  let hits: ReturnType<typeof searchChunks> = [];
  if (match !== undefined && scope !== 'refs') {
    try {
      hits = searchChunks(db, match);
    } catch (err) {
      if (advanced) throw new ToolRejection({ type: 'invalid', detail: 'advanced query is not valid FTS5 syntax' });
      throw err;
    }
  }
  const tagMap = tags.length > 0 ? tagsByPath(db) : undefined;
  const notes = hits
    .filter((h) => scope !== 'raw' || h.folder_class === 'raw')
    .filter((h) => inFolder(h.path, folder) && isVisible(h, vis))
    .filter((h) => tagMap === undefined || tags.every((t) => (tagMap.get(h.path) ?? []).includes(t)))
    .map((h) => rankItem({ row: h as NoteRow, hit: h, ordinal: h.ordinal, bm25: h.bm25 }));
  const refs = match !== undefined && (scope === 'refs' || scope === 'all') ? refCandidates(env, match, advanced) : [];
  // Notes first, then books (rank.ts); at most `limit` notes and min(limit, refs.maxHits) book passages.
  const ranked = rank<RankItem & { row?: NoteRow; hit?: (typeof hits)[number]; ref?: RefHit }>([...notes, ...refs], { includeHidden: true });
  const refLimit = Math.min(limit, env.refs?.maxHits ?? 0);
  const kept = [
    ...ranked.filter((r) => r.item.ref === undefined).slice(0, limit),
    ...ranked.filter((r) => r.item.ref !== undefined).slice(0, refLimit),
  ];
  const items = kept.map(({ item, tier }) => {
    if (item.ref !== undefined) return refItem(item.ref, tier, format, env.refs!.excerptChars);
    const row = item.row!;
    const hit = item.hit!;
    const headingPath = JSON.parse(hit.heading_path) as string[];
    const fields = {
      ...noteFields(row, tier),
      heading_path: headingPath,
      citation: citationFor(row, headingPath[headingPath.length - 1]),
    };
    if (format === 'full') Object.assign(fields, { title: row.title });
    const text = format === 'compact' ? hit.snippet : hit.text;
    return { fields, excerpt: excerptOf(text, format, SEARCH_EXCERPT_CHARS) };
  });
  const noteRows = kept.flatMap((r) => (r.item.row === undefined ? [] : [r.item.row]));
  const extra: Record<string, unknown> = { matched: notes.length + refs.length };
  if (scope !== 'notes') extra['scope'] = scope;
  return listResponse('search', format, items, maxChars, { ...extra, ...proposedNotice(noteRows, noteRows.length < kept.length) });
}

function readNote(env: ReadToolEnv, args: Record<string, unknown>, maxChars: number): ToolResult {
  const format = formatArg(args);
  const requested = vaultPathArg(env, args['path'] as string);
  const notFound = () => new ToolRejection({ type: 'invalid', detail: 'not found: no indexed note at that path' });
  let row: NoteRow | undefined;
  let text = '';
  // The note may change between the refresh and the read; retry once so the
  // returned rev matches the index.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { db } = refreshed(env);
    row = noteRowByPath(db, requested);
    if (row === undefined) throw notFound();
    let data: Buffer;
    try {
      data = readFileWithStatSafe(resolveInVault(env.vaultPath, row.path), { maxBytes: MAX_NOTE_BYTES }).data;
    } catch (err) {
      if (err instanceof SafePathError) safePathRejection(err);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound();
      throw err;
    }
    text = decodeNote(data).text;
    if (revOf(text) === row.rev) break;
    if (attempt === 1) row = { ...row, rev: revOf(text) };
  }
  const note = row!;
  const tags = tagsByPath(env.index.db).get(note.path) ?? [];
  const citation = citationFor(note);
  const meta: Record<string, unknown> = { ...noteFields(note), citation };
  if (format === 'compact') meta['excerpt'] = truncateText(text, COMPACT_EXCERPT_CHARS);
  else Object.assign(meta, { title: note.title, tags });
  const recall_id = ulid();
  const header = JSON.stringify({ tool: 'read_note', recall_id, format, count: 1 });
  const data = format === 'compact' ? JSON.stringify(meta) : `${JSON.stringify(meta)}\n\n${text}`;
  return {
    content: [{ type: 'text', text: header }, { type: 'data', text: data, source: citation }],
    recall_id,
    returned: [{ id: note.id, rev: note.rev }],
    count: 1,
  };
}

function listNotes(env: ReadToolEnv, args: Record<string, unknown>, maxChars: number): ToolResult {
  const format = formatArg(args);
  const vis = visibilityArgs(args, env);
  const folder = folderArg(env, args);
  const tag = typeof args['tag'] === 'string' ? normalizeTag(args['tag']) : undefined;
  const { db } = refreshed(env);
  const tagMap = tagsByPath(db);
  const candidates = allNoteRows(db)
    .filter((r) => inFolder(r.path, folder) && isVisible(r, vis))
    .filter((r) => tag === undefined || (tagMap.get(r.path) ?? []).includes(tag))
    .map((r) => rankItem({ row: r }));
  const ranked = rank(candidates, { includeHidden: true }).slice(0, limitArg(args, LIST_LIMIT));
  const items = ranked.map(({ item, tier }) => {
    const fields = { ...noteFields(item.row, tier), citation: citationFor(item.row) };
    if (format === 'full') Object.assign(fields, { title: item.row.title, tags: tagMap.get(item.row.path) ?? [] });
    return { fields, excerpt: excerptOf(firstChunkText(db, item.row.path), format, LIST_EXCERPT_CHARS) };
  });
  return listResponse('list_notes', format, items, maxChars, { matched: candidates.length, ...proposedNotice(ranked.map((r) => r.item.row)) });
}

type Relation = 'backlink' | 'outgoing' | 'shared_tag';

function related(env: ReadToolEnv, args: Record<string, unknown>, maxChars: number): ToolResult {
  const format = formatArg(args);
  const requested = vaultPathArg(env, args['path'] as string);
  const { db } = refreshed(env);
  const self = noteRowByPath(db, requested);
  if (self === undefined) throw new ToolRejection({ type: 'invalid', detail: 'not found: no indexed note at that path' });
  const vis: Visibility = { includeSuperseded: false, includeArchived: false, now: (env.now ?? (() => new Date()))().getTime() };
  const n = neighbours(db, self.path);
  const byPath = new Map<string, { row: NoteRow; relations: Relation[]; sharedTags: string[] }>();
  const add = (row: NoteRow, relation: Relation, tags: string[] = []) => {
    if (row.path === self.path || !isVisible(row, vis)) return;
    let e = byPath.get(row.path);
    if (e === undefined) {
      e = { row, relations: [], sharedTags: [] };
      byPath.set(row.path, e);
    }
    if (!e.relations.includes(relation)) e.relations.push(relation);
    e.sharedTags.push(...tags);
  };
  for (const r of n.backlinks) add(r, 'backlink');
  for (const r of n.outgoing) add(r, 'outgoing');
  for (const s of n.sharedTags) add(s.row, 'shared_tag', s.tags);
  const ranked = rank([...byPath.values()].map((e) => rankItem(e)), { includeHidden: true }).slice(0, limitArg(args, RELATED_LIMIT));
  const order: Relation[] = ['backlink', 'outgoing', 'shared_tag'];
  const items = ranked.map(({ item, tier }) => {
    const fields: Record<string, unknown> = {
      ...noteFields(item.row, tier),
      citation: citationFor(item.row),
      relations: order.filter((r) => item.relations.includes(r)),
    };
    if (item.sharedTags.length > 0) fields['shared_tags'] = item.sharedTags;
    if (format === 'full') fields['title'] = item.row.title;
    return { fields };
  });
  return listResponse('related', format, items, maxChars, {
    matched: byPath.size,
    note: citationFor(self),
    ...proposedNotice(ranked.map((r) => r.item.row)),
  });
}

/** Register the four read tools (every mode) into `registry`. */
export function registerReadTools(env: ReadToolEnv, registry: ToolRegistry): void {
  registerTool(
    {
      name: 'search',
      modes: MODES,
      description: 'Full-text (BM25) search over the vault. Returns ranked passages with path, heading_path, excerpt, and a revision-pinned citation.',
      schema: env.mode === 'journal' ? SEARCH_SCHEMA_JOURNAL : SEARCH_SCHEMA,
      auditArgs: { folder: 'path' },
      handler: (args, ctx) => search(env, args, ctx.maxChars),
    },
    registry,
  );
  registerTool(
    {
      name: 'read_note',
      modes: MODES,
      description: 'Read one note by vault-relative path.',
      schema: READ_NOTE_SCHEMA,
      auditArgs: { path: 'path' },
      handler: (args, ctx) => readNote(env, args, ctx.maxChars),
    },
    registry,
  );
  registerTool(
    {
      name: 'list_notes',
      modes: MODES,
      description: 'List notes, optionally by folder, tag, and status, in ranking order.',
      schema: env.mode === 'journal' ? LIST_NOTES_SCHEMA_JOURNAL : LIST_NOTES_SCHEMA,
      auditArgs: { folder: 'path' },
      handler: (args, ctx) => listNotes(env, args, ctx.maxChars),
    },
    registry,
  );
  registerTool(
    {
      name: 'related',
      modes: MODES,
      description: 'Notes structurally related to a note: backlinks, outgoing links, and notes sharing tags.',
      schema: RELATED_SCHEMA,
      auditArgs: { path: 'path' },
      handler: (args, ctx) => related(env, args, ctx.maxChars),
    },
    registry,
  );
}
