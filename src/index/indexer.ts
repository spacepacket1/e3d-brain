// Incremental indexing. Three modes share one code path:
//
// - `stat` (refreshIndex): compare each file's stat key (size, mtime_ns,
//   inode, ctime_ns) with the index; read and hash only files whose key
//   changed (or whose mtime was too recent to trust); re-parse only when the
//   content hash changed. Cheap enough to run before every read and after
//   every write.
// - `hash` (`ebrain reindex`): hash every file, re-parse those whose content
//   changed. Catches edits that preserved the stat key.
// - `full` (`ebrain reindex --full`): rebuild every row from scratch.
//
// Files are read and parsed outside the write transaction; the transaction
// re-checks each changed file's stat key and re-reads it if it moved again,
// so what commits reflects the vault at commit time. All changes land in one
// IMMEDIATE transaction: concurrent readers (WAL) see the old or the new
// index, never a mix. The vault is never written.

import { createHash } from 'node:crypto';
import { getMeta, indexExists, openIndexDb, setMeta, type Db } from './db.js';
import {
  assignNewIdentities, clearIdentityHistory, duplicateIds, finishIdentities, snapshotIds, type GoneNote,
} from './identity.js';
import { resolveAllLinks } from './resolve.js';
import { DEFAULT_MAX_CHUNK_CHARS } from '../vault/chunk.js';
import { findCollisions, folderClass, foldKey, nfc, noteBasename } from '../vault/names.js';
import { canonicalJson, explicitId, parseNote, revOf, type ParsedNote } from '../vault/parse.js';
import { sameStatKey, scanVault, statKeyOf, type ScanSkips, type StatKey } from '../vault/scan.js';
import { readFileWithStatSafe, resolveInVault, SafePathError, statBigSafe, type SafePath } from '../safe-path.js';

/** Bump when parsing or chunking output changes: the next refresh rebuilds. */
export const PARSER_VERSION = 2;
/** Notes larger than this are skipped and counted, never read. */
export const MAX_NOTE_BYTES = 8 * 1024 * 1024;
/** A file modified this close to when it was read may change again within the same timestamp tick. */
const RACY_WINDOW_NS = 3_000_000_000n;

export type IndexMode = 'stat' | 'hash' | 'full';

export interface IndexHandle {
  db: Db;
  vaultPath: string;
  stateDir: SafePath;
  maxChunkChars: number;
}

export interface OpenIndexOptions {
  vaultPath: string;
  stateDir: SafePath;
  maxChunkChars?: number;
  /** Fail instead of creating an empty index. */
  mustExist?: boolean;
}

export function openIndex(opts: OpenIndexOptions): IndexHandle {
  // Fail early (and before creating anything) if the vault is not usable.
  resolveInVault(opts.vaultPath, '');
  return {
    db: openIndexDb(opts.stateDir, { mustExist: opts.mustExist }),
    vaultPath: opts.vaultPath,
    stateDir: opts.stateDir,
    maxChunkChars: opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
  };
}

export function closeIndex(h: IndexHandle): void {
  h.db.close();
}

export { indexExists };

export interface RunSkips extends ScanSkips {
  tooLarge: number;
  unreadable: number;
}

export interface RefreshResult {
  mode: IndexMode;
  /** True when parser settings changed and the run was promoted to a full rebuild. */
  rebuilt: boolean;
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  skipped: RunSkips;
}

interface Prepared {
  relPath: string;
  stat: StatKey;
  racy: boolean;
  hash: string;
  parsed?: ParsedNote;
}

interface Row {
  path: string;
  size: string;
  mtime_ns: string;
  ino: string;
  ctime_ns: string;
  racy: number;
  hash: string;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function rowStat(r: Row): StatKey {
  return { size: r.size, mtimeNs: r.mtime_ns, ino: r.ino, ctimeNs: r.ctime_ns };
}

type ReadOutcome = { ok: true; value: Prepared } | { ok: false; reason: 'gone' | 'tooLarge' | 'unreadable' };

/** Read, hash, and (unless the hash matches `knownHash`) parse one file. */
function prepareFile(h: IndexHandle, abs: SafePath, relPath: string, knownHash: string | undefined): ReadOutcome {
  const readAt = nowNs();
  let read: ReturnType<typeof readFileWithStatSafe>;
  try {
    read = readFileWithStatSafe(abs, { maxBytes: MAX_NOTE_BYTES });
  } catch (err) {
    if (err instanceof SafePathError) return { ok: false, reason: err.code === 'too-large' ? 'tooLarge' : 'unreadable' };
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'gone' };
    if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') return { ok: false, reason: 'unreadable' };
    throw err;
  }
  const hash = createHash('sha256').update(read.data).digest('hex');
  const value: Prepared = {
    relPath,
    stat: statKeyOf(read.stat),
    racy: read.stat.mtimeNs + RACY_WINDOW_NS > readAt,
    hash,
  };
  if (hash !== knownHash) value.parsed = parseNote(relPath, read.data, { maxChunkChars: h.maxChunkChars });
  return { ok: true, value };
}

function deleteNote(db: Db, path: string): void {
  db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE note_path = ?)').run(path);
  for (const t of ['chunks', 'links', 'tags', 'aliases', 'headings', 'problems']) {
    db.prepare(`DELETE FROM ${t} WHERE note_path = ?`).run(path);
  }
  db.prepare('DELETE FROM cites WHERE from_path = ?').run(path);
  db.prepare('DELETE FROM notes WHERE path = ?').run(path);
}

const NOTE_COLUMNS = [
  'path', 'path_nfc', 'path_fold', 'basename_fold', 'size', 'mtime_ns', 'ino', 'ctime_ns', 'racy', 'hash', 'rev', 'id',
  'provisional', 'prov_id', 'title',
  'folder_class', 'folder_hidden', 'frontmatter', 'fm_id', 'status', 'status_known', 'pinned', 'kind', 'occurred',
  'valid_from', 'valid_until', 'created', 'expires', 'accepted', 'applied', 'superseded_at', 'archived_at', 'author',
  'origin', 'sources', 'untrusted_origin', 'superseded_by', 'supersedes', 'merged_into', 'derived_from',
  'schema_version', 'scrub_version', 'extra',
];

function boolInt(v: boolean | null): number | null {
  return v === null ? null : v ? 1 : 0;
}

/**
 * Insert a parsed note under its provisional identity `provId`. The effective
 * id starts as the explicit id (if valid) and is settled for duplicates by
 * `finishIdentities` in the same transaction.
 */
function insertNote(db: Db, p: Prepared, provId: string): void {
  const n = p.parsed!;
  const f = n.fields;
  const folder = folderClass(p.relPath);
  const explicit = explicitId(f.id);
  const values: unknown[] = [
    p.relPath, nfc(p.relPath), foldKey(p.relPath), foldKey(noteBasename(p.relPath)), p.stat.size, p.stat.mtimeNs,
    p.stat.ino, p.stat.ctimeNs, p.racy ? 1 : 0, p.hash, n.rev, explicit ?? provId, explicit === null ? 1 : 0, provId,
    n.title, folder.folderClass, folder.hidden ? 1 : 0,
    n.frontmatter, f.id, f.status, n.statusKnown ? 1 : 0, boolInt(f.pinned), f.kind, f.occurred, f.valid_from,
    f.valid_until, f.created, f.expires, f.accepted, f.applied, f.superseded_at, f.archived_at, f.author, f.origin,
    canonicalJson(f.sources), boolInt(f.untrusted_origin), f.superseded_by, canonicalJson(f.supersedes),
    f.merged_into, canonicalJson(f.derived_from), f.schema, f.scrubVersion, canonicalJson(n.extra),
  ];
  db.prepare(`INSERT INTO notes (${NOTE_COLUMNS.join(', ')}) VALUES (${NOTE_COLUMNS.map(() => '?').join(', ')})`).run(...values);

  const chunk = db.prepare('INSERT INTO chunks (note_path, ordinal, heading_path, text, chunk_rev) VALUES (?, ?, ?, ?, ?)');
  const fts = db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)');
  for (const c of n.chunks) {
    const info = chunk.run(p.relPath, c.ordinal, canonicalJson(c.headingPath), c.text, revOf(c.text));
    fts.run(info.lastInsertRowid, c.text);
  }
  const link = db.prepare(
    "INSERT INTO links (note_path, ordinal, line, target, anchor, alias, embed, resolved_path, resolution, candidates) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'unresolved', 0)",
  );
  n.links.forEach((l, i) => link.run(p.relPath, i, l.line, l.target, l.anchor, l.alias, l.embed ? 1 : 0));
  const tag = db.prepare('INSERT INTO tags (note_path, tag, source) VALUES (?, ?, ?)');
  for (const t of n.tags) tag.run(p.relPath, t.tag, t.source);
  const alias = db.prepare('INSERT INTO aliases (note_path, alias, alias_fold) VALUES (?, ?, ?)');
  for (const a of n.aliases) alias.run(p.relPath, a, foldKey(a));
  const heading = db.prepare('INSERT INTO headings (note_path, ordinal, level, text, line) VALUES (?, ?, ?, ?, ?)');
  n.headings.forEach((hd, i) => heading.run(p.relPath, i, hd.level, hd.text, hd.line));
  const problem = db.prepare('INSERT INTO problems (note_path, ordinal, kind, field, detail) VALUES (?, ?, ?, ?, ?)');
  n.problems.forEach((pr, i) => problem.run(p.relPath, i, pr.kind, pr.field, pr.detail));
}

function settingsKey(h: IndexHandle): string {
  return `parser=${PARSER_VERSION};maxChunkChars=${h.maxChunkChars}`;
}

/** Bring the index in line with the vault. See the module comment for modes. */
export function updateIndex(h: IndexHandle, mode: IndexMode): RefreshResult {
  const { db } = h;
  const settings = getMeta(db, 'settings');
  const rebuilt = mode !== 'full' && settings !== undefined && settings !== settingsKey(h);
  const full = mode === 'full' || settings !== settingsKey(h);
  const scan = scanVault(h.vaultPath);
  const skipped: RunSkips = { ...scan.skipped, tooLarge: 0, unreadable: 0 };
  const known = new Map<string, Row>();
  if (!full) {
    for (const r of db.prepare('SELECT path, size, mtime_ns, ino, ctime_ns, racy, hash FROM notes').all() as Row[]) {
      known.set(r.path, r);
    }
  }

  const present = new Set<string>();
  const changes: { abs: SafePath; prepared: Prepared }[] = [];
  let unchanged = 0;
  for (const file of scan.files) {
    const row = known.get(file.relPath);
    if (!full && mode === 'stat' && row && row.racy === 0 && sameStatKey(rowStat(row), file.stat)) {
      present.add(file.relPath);
      unchanged++;
      continue;
    }
    const out = prepareFile(h, file.abs, file.relPath, full ? undefined : row?.hash);
    if (!out.ok) {
      if (out.reason !== 'gone') skipped[out.reason]++;
      continue;
    }
    present.add(file.relPath);
    const p = out.value;
    if (row && !p.parsed) {
      // Same content: at most the stat key (or racy flag) needs updating.
      unchanged++;
      if (sameStatKey(rowStat(row), p.stat) && (row.racy === 1) === p.racy) continue;
    }
    changes.push({ abs: file.abs, prepared: p });
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  db.transaction(() => {
    const before = full ? undefined : snapshotIds(db);
    if (full) {
      for (const t of ['chunks_fts', 'chunks', 'links', 'tags', 'aliases', 'headings', 'problems', 'notes']) db.exec(`DELETE FROM ${t}`);
      clearIdentityHistory(db);
    }
    const current = db.prepare('SELECT hash, prov_id FROM notes WHERE path = ?');
    const statOnly = db.prepare('UPDATE notes SET size = ?, mtime_ns = ?, ino = ?, ctime_ns = ?, racy = ? WHERE path = ?');
    let contentChanged = full;
    // New paths wait until disappeared rows are gone, so renames can be matched.
    const appeared: Prepared[] = [];
    for (const { abs, prepared } of changes) {
      let p = prepared;
      // The file may have changed again since it was read: re-read it now, under the write lock.
      const st = statBigSafe(abs);
      if (st === undefined || !st.isFile()) continue; // gone; removed below unless another run re-adds it
      const existing = current.get(p.relPath) as { hash: string; prov_id: string } | undefined;
      if (!sameStatKey(statKeyOf(st), p.stat) || (!p.parsed && existing?.hash !== p.hash)) {
        const again = prepareFile(h, abs, p.relPath, existing?.hash);
        if (!again.ok) continue;
        p = again.value;
      }
      if (existing && existing.hash === p.hash) {
        statOnly.run(p.stat.size, p.stat.mtimeNs, p.stat.ino, p.stat.ctimeNs, p.racy ? 1 : 0, p.relPath);
        continue;
      }
      if (!p.parsed) continue;
      if (existing) {
        // Edited in place: same identity, new revision.
        deleteNote(db, p.relPath);
        insertNote(db, p, existing.prov_id);
        updated++;
        contentChanged = true;
      } else appeared.push(p);
    }
    const gone: GoneNote[] = [];
    if (!full) {
      const goneRow = db.prepare('SELECT hash, prov_id FROM notes WHERE path = ?');
      for (const path of known.keys()) {
        if (present.has(path)) continue;
        const row = goneRow.get(path) as { hash: string; prov_id: string } | undefined;
        if (row === undefined) continue; // already removed by a concurrent run
        gone.push({ path, hash: row.hash, provId: row.prov_id });
        deleteNote(db, path);
        removed++;
        contentChanged = true;
      }
    }
    const provIds = assignNewIdentities(db, appeared, gone);
    for (const p of appeared) {
      insertNote(db, p, provIds.get(p.relPath)!);
      added++;
      contentChanged = true;
    }
    if (contentChanged) {
      resolveAllLinks(db);
      finishIdentities(db, before, new Date().toISOString());
    }
    if (full) setMeta(db, 'settings', settingsKey(h));
  }).immediate();

  return { mode, rebuilt, scanned: scan.files.length, added, updated, removed, unchanged, skipped };
}

/** Stat-based refresh: call before reads and after writes so new notes are searchable at once. */
export function refreshIndex(h: IndexHandle): RefreshResult {
  return updateIndex(h, 'stat');
}

/** `ebrain reindex`: hash every file; `full` rebuilds from scratch. */
export function reindex(h: IndexHandle, opts: { full?: boolean } = {}): RefreshResult {
  return updateIndex(h, opts.full ? 'full' : 'hash');
}

export interface IndexTotals {
  notes: number;
  chunks: number;
  links: number;
  unresolvedLinks: number;
  tags: number;
  malformedFrontmatter: number;
  invalidDates: number;
  unknownStatuses: number;
  invalidFields: number;
  invalidUtf8: number;
  provisionalIds: number;
  duplicateIds: number;
  missingIds: number;
  cites: number;
  collisions: string[][];
}

export function indexTotals(db: Db): IndexTotals {
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const problems = (kind: string) => count('SELECT COUNT(*) AS n FROM problems WHERE kind = ?', kind);
  return db.transaction(() => ({
    notes: count('SELECT COUNT(*) AS n FROM notes'),
    chunks: count('SELECT COUNT(*) AS n FROM chunks'),
    links: count('SELECT COUNT(*) AS n FROM links'),
    unresolvedLinks: count("SELECT COUNT(*) AS n FROM links WHERE resolution = 'unresolved'"),
    tags: count('SELECT COUNT(DISTINCT tag) AS n FROM tags'),
    malformedFrontmatter: count("SELECT COUNT(*) AS n FROM notes WHERE frontmatter = 'malformed'"),
    invalidDates: problems('invalid_date'),
    unknownStatuses: problems('unknown_status'),
    invalidFields: problems('invalid_field'),
    invalidUtf8: problems('invalid_utf8'),
    provisionalIds: count('SELECT COUNT(*) AS n FROM notes WHERE provisional = 1'),
    duplicateIds: duplicateIds(db).length,
    missingIds: count('SELECT COUNT(*) AS n FROM missing_ids'),
    cites: count('SELECT COUNT(*) AS n FROM cites'),
    collisions: findCollisions((db.prepare('SELECT path FROM notes').all() as { path: string }[]).map((r) => r.path)),
  }))();
}
