// The MCP read tools (Phase 6): search, read_note, list_notes, related.
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
import { readFileWithStatSafe, resolveInVault, SafePathError } from '../safe-path.js';
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

export interface ReadToolEnv {
  vaultPath: string;
  index: IndexHandle;
  /** Clock for the default `as_of` (tests inject one). */
  now?: () => Date;
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
    max_chars: MAX_CHARS_SCHEMA,
    format: FORMAT_SCHEMA,
  },
  required: ['query'],
};

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
  /** The `as_of` argument, when given. */
  asOf?: number;
  /** Now; the validity window is evaluated at `asOf ?? now`. */
  now: number;
}

/** Status a result reports: the frontmatter value, or `accepted` for a curated/reference note without one. */
export function effectiveStatus(row: Pick<NoteRow, 'status' | 'folder_class'>): string | null {
  if (row.status !== null) return row.status;
  return row.folder_class === 'curated' || row.folder_class === 'reference' ? 'accepted' : null;
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
  return out;
}

function rankItem<T extends { row: NoteRow; ordinal?: number; bm25?: number }>(x: T): T & RankItem {
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
  items: readonly { fields: Record<string, unknown>; excerpt?: string }[],
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
    const id = String(it.fields['id']);
    const rev = String(it.fields['rev']);
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

function search(env: ReadToolEnv, args: Record<string, unknown>, maxChars: number): ToolResult {
  const format = formatArg(args);
  const vis = visibilityArgs(args, env);
  const folder = folderArg(env, args);
  const tags = Array.isArray(args['tags']) ? (args['tags'] as string[]).map(normalizeTag) : [];
  const query = args['query'] as string;
  const advanced = bool(args, 'advanced');
  const { db } = refreshed(env);

  const match = advanced ? query : ftsQuery(query);
  let hits: ReturnType<typeof searchChunks> = [];
  if (match !== undefined) {
    try {
      hits = searchChunks(db, match);
    } catch (err) {
      if (advanced) throw new ToolRejection({ type: 'invalid', detail: 'advanced query is not valid FTS5 syntax' });
      throw err;
    }
  }
  const tagMap = tags.length > 0 ? tagsByPath(db) : undefined;
  const candidates = hits
    .filter((h) => inFolder(h.path, folder) && isVisible(h, vis))
    .filter((h) => tagMap === undefined || tags.every((t) => (tagMap.get(h.path) ?? []).includes(t)))
    .map((h) => rankItem({ row: h as NoteRow, hit: h, ordinal: h.ordinal, bm25: h.bm25 }));
  const ranked = rank(candidates, { includeHidden: true }).slice(0, limitArg(args, SEARCH_LIMIT));
  const items = ranked.map(({ item, tier }) => {
    const headingPath = JSON.parse(item.hit.heading_path) as string[];
    const fields = {
      ...noteFields(item.row, tier),
      heading_path: headingPath,
      citation: citationFor(item.row, headingPath[headingPath.length - 1]),
    };
    if (format === 'full') Object.assign(fields, { title: item.row.title });
    const text = format === 'compact' ? item.hit.snippet : item.hit.text;
    return { fields, excerpt: excerptOf(text, format, SEARCH_EXCERPT_CHARS) };
  });
  return listResponse('search', format, items, maxChars, { matched: candidates.length });
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
  return listResponse('list_notes', format, items, maxChars, { matched: candidates.length });
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
  return listResponse('related', format, items, maxChars, { matched: byPath.size, note: citationFor(self) });
}

/** Register the four read tools (every mode) into `registry`. */
export function registerReadTools(env: ReadToolEnv, registry: ToolRegistry): void {
  registerTool(
    {
      name: 'search',
      modes: MODES,
      description: 'Full-text (BM25) search over the vault. Returns ranked passages with path, heading_path, excerpt, and a revision-pinned citation.',
      schema: SEARCH_SCHEMA,
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
      schema: LIST_NOTES_SCHEMA,
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
