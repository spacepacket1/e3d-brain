// The reference library database, `<stateDir>/refs.db` (Phase 11). Book text
// lives here and nowhere else: not in the vault, and not in `index.db`, so
// `ebrain reindex` (I7 for the note index) never touches it. It is derived
// data too: `ebrain refs reindex` rebuilds it from the original source files
// (listed here and in the owner's `references/<slug>.md` notes).
//
// Rollback-journal mode (not WAL): only the owner's CLI writes, under the
// `refs` lock, and MCP servers open it read-only, which in WAL mode would
// need the -shm file to exist.

import type BetterSqlite3 from 'better-sqlite3';
import { loadSqlite, NATIVE_BUILD_HINT } from '../index/sqlite.js';
import { BUSY_TIMEOUT_MS } from '../index/db.js';
import { createExclusive, resolveInState, SafePathError, statSafe, type SafePath } from '../safe-path.js';

export type RefsDb = BetterSqlite3.Database;

export const REFS_FILE = 'refs.db';
/** Bump when the table layout changes: a refs.db with another version is dropped and must be rebuilt (`ebrain refs reindex`). */
export const REFS_SCHEMA_VERSION = 1;
/** `ref_` + 32 hex characters of the source file's SHA-256. */
export const REF_ID_RE = /^ref_[0-9a-f]{32}$/;

/** `Title, Chapter N (heading)`: the human label of a chapter. */
export function refLabel(title: string, chapter: number, heading: string | null | undefined): string {
  return `${title}, Chapter ${chapter}${heading ? ` (${heading})` : ''}`;
}

/** `ref:<ref_id>/<chapter>/<ordinal>` (Phase 3 grammar). */
export function refCitation(refId: string, chapter: number, ordinal: number): string {
  return `ref:${refId}/${chapter}/${ordinal}`;
}

const TABLES = ['meta', 'refs', 'refs_chapters', 'refs_chunks', 'refs_fts', 'removed_refs'];

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE refs (
  ref_id TEXT PRIMARY KEY,        -- ref_ + 32 hex of the source SHA-256
  title TEXT NOT NULL,
  author TEXT,
  format TEXT NOT NULL,           -- epub | md | txt | pdf
  source_path TEXT NOT NULL,      -- absolute realpath of the source file
  source_sha256 TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  note_path TEXT,                 -- the owner's vault note, references/<slug>.md
  added TEXT NOT NULL,
  chapters INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  scrub_version INTEGER NOT NULL,
  findings TEXT NOT NULL          -- JSON [{type, count}]; never matched text
) STRICT;
CREATE TABLE refs_chapters (
  ref_id TEXT NOT NULL, chapter INTEGER NOT NULL, heading TEXT,
  PRIMARY KEY (ref_id, chapter)
) STRICT;
CREATE TABLE refs_chunks (
  id INTEGER PRIMARY KEY,         -- rowid shared with refs_fts
  ref_id TEXT NOT NULL,
  chapter INTEGER NOT NULL,       -- 1-based
  ordinal INTEGER NOT NULL,       -- 0-based within the chapter
  heading TEXT,                   -- nearest heading at the chunk start
  text TEXT NOT NULL,             -- scrubbed
  chunk_rev TEXT NOT NULL,        -- 16 hex of SHA-256 of the text
  UNIQUE (ref_id, chapter, ordinal)
) STRICT;
CREATE VIRTUAL TABLE refs_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
-- Refs removed with \`ebrain refs remove\`: \`refs reindex\` does not bring them back from their vault notes.
CREATE TABLE removed_refs (ref_id TEXT PRIMARY KEY, removed TEXT NOT NULL) STRICT;
`;

export class RefsDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefsDbError';
  }
}

export function refsDbPath(stateDir: SafePath): SafePath {
  return resolveInState(stateDir, REFS_FILE);
}

export function refsDbExists(stateDir: SafePath): boolean {
  return statSafe(refsDbPath(stateDir)) !== undefined;
}

function database(): typeof BetterSqlite3 {
  const loaded = loadSqlite();
  if (!loaded.ok) throw new RefsDbError(`better-sqlite3 failed to load: ${loaded.error}; ${NATIVE_BUILD_HINT}`);
  return loaded.Database;
}

function current(db: RefsDb): boolean {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() === undefined) return false;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row?.value === String(REFS_SCHEMA_VERSION);
}

/** Open for writing (owner CLI), creating the file 0600 (I8) and the schema if needed. */
export function openRefsDb(stateDir: SafePath): RefsDb {
  const Database = database();
  const file = refsDbPath(stateDir);
  if (statSafe(file) === undefined) {
    try {
      createExclusive(file, '');
    } catch (err) {
      if (!(err instanceof SafePathError && err.code === 'exists')) throw err;
    }
  }
  let db: RefsDb;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (err) {
    throw new RefsDbError(`cannot open ${file}: ${err instanceof Error ? err.message : String(err)}; ` +
      'it is derived data: delete it and run `ebrain refs reindex`');
  }
  try {
    if (!current(db)) {
      db.transaction(() => {
        if (current(db)) return;
        for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
        db.exec(SCHEMA);
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(REFS_SCHEMA_VERSION));
      }).immediate();
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Open read-only (MCP tools); undefined when there is no usable refs.db (nothing added yet, or an old schema). */
export function openRefsDbReadOnly(stateDir: SafePath): RefsDb | undefined {
  const file = refsDbPath(stateDir);
  if (statSafe(file) === undefined) return undefined;
  const db = new (database())(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!current(db)) {
      db.close();
      return undefined;
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// ---- rows ----

export interface RefRow {
  ref_id: string;
  title: string;
  author: string | null;
  format: string;
  source_path: string;
  source_sha256: string;
  source_size: number;
  note_path: string | null;
  added: string;
  chapters: number;
  chunks: number;
  scrub_version: number;
  findings: string;
}

export interface RefChunkRow {
  ref_id: string;
  chapter: number;
  ordinal: number;
  heading: string | null;
  text: string;
  chunk_rev: string;
  title: string;
  author: string | null;
  chapter_heading: string | null;
}

export interface RefHit extends Omit<RefChunkRow, 'text'> {
  bm25: number;
  snippet: string;
}

export function refRow(db: RefsDb, refId: string): RefRow | undefined {
  return db.prepare('SELECT * FROM refs WHERE ref_id = ?').get(refId) as RefRow | undefined;
}

/** Every ref, in title then id order (a listing, not a ranking). */
export function allRefs(db: RefsDb): RefRow[] {
  return db.prepare('SELECT * FROM refs ORDER BY title, ref_id').all() as RefRow[];
}

export function isRemoved(db: RefsDb, refId: string): boolean {
  return db.prepare('SELECT 1 FROM removed_refs WHERE ref_id = ?').get(refId) !== undefined;
}

const CHUNK_SELECT = `c.ref_id AS ref_id, c.chapter AS chapter, c.ordinal AS ordinal, c.heading AS heading,
  c.chunk_rev AS chunk_rev, r.title AS title, r.author AS author, ch.heading AS chapter_heading`;
const CHUNK_JOIN = `JOIN refs r ON r.ref_id = c.ref_id
  LEFT JOIN refs_chapters ch ON ch.ref_id = c.ref_id AND ch.chapter = c.chapter`;

export function chunkRow(db: RefsDb, refId: string, chapter: number, ordinal: number): RefChunkRow | undefined {
  return db
    .prepare(`SELECT ${CHUNK_SELECT}, c.text AS text FROM refs_chunks c ${CHUNK_JOIN} WHERE c.ref_id = ? AND c.chapter = ? AND c.ordinal = ?`)
    .get(refId, chapter, ordinal) as RefChunkRow | undefined;
}

/** The chunk after (chapter, ordinal) in reading order, as a key; undefined at the end of the book. */
export function nextChunkKey(db: RefsDb, refId: string, chapter: number, ordinal: number): { chapter: number; ordinal: number } | undefined {
  return db
    .prepare(`SELECT chapter, ordinal FROM refs_chunks WHERE ref_id = ? AND (chapter > ? OR (chapter = ? AND ordinal > ?))
      ORDER BY chapter, ordinal LIMIT 1`)
    .get(refId, chapter, chapter, ordinal) as { chapter: number; ordinal: number } | undefined;
}

/** The chunk before (chapter, ordinal) in reading order; undefined at the start. */
export function prevChunkKey(db: RefsDb, refId: string, chapter: number, ordinal: number): { chapter: number; ordinal: number } | undefined {
  return db
    .prepare(`SELECT chapter, ordinal FROM refs_chunks WHERE ref_id = ? AND (chapter < ? OR (chapter = ? AND ordinal < ?))
      ORDER BY chapter DESC, ordinal DESC LIMIT 1`)
    .get(refId, chapter, chapter, ordinal) as { chapter: number; ordinal: number } | undefined;
}

/** Full-text matches with BM25 and a short snippet around the match, unordered (rank.ts orders them). */
export function searchRefChunks(db: RefsDb, match: string): RefHit[] {
  return db
    .prepare(
      `SELECT ${CHUNK_SELECT}, bm25(refs_fts) AS bm25, snippet(refs_fts, 0, '', '', '…', 48) AS snippet
       FROM refs_fts JOIN refs_chunks c ON c.id = refs_fts.rowid ${CHUNK_JOIN}
       WHERE refs_fts MATCH ?`,
    )
    .all(match) as RefHit[];
}

export interface RefContent {
  ref: Omit<RefRow, 'chapters' | 'chunks'>;
  chapters: { chapter: number; heading?: string; chunks: { ordinal: number; heading?: string; text: string; chunkRev: string }[] }[];
}

/** Replace every row of one ref (in one transaction; readers see the old or the new book). */
export function replaceRef(db: RefsDb, content: RefContent): { chapters: number; chunks: number } {
  const delFts = db.prepare('DELETE FROM refs_fts WHERE rowid IN (SELECT id FROM refs_chunks WHERE ref_id = ?)');
  const insChapter = db.prepare('INSERT INTO refs_chapters (ref_id, chapter, heading) VALUES (?, ?, ?)');
  const insChunk = db.prepare('INSERT INTO refs_chunks (ref_id, chapter, ordinal, heading, text, chunk_rev) VALUES (?, ?, ?, ?, ?, ?)');
  const insFts = db.prepare('INSERT INTO refs_fts (rowid, text) VALUES (?, ?)');
  let chunks = 0;
  db.transaction(() => {
    const id = content.ref.ref_id;
    delFts.run(id);
    db.prepare('DELETE FROM refs_chunks WHERE ref_id = ?').run(id);
    db.prepare('DELETE FROM refs_chapters WHERE ref_id = ?').run(id);
    db.prepare('DELETE FROM refs WHERE ref_id = ?').run(id);
    db.prepare('DELETE FROM removed_refs WHERE ref_id = ?').run(id);
    for (const ch of content.chapters) {
      insChapter.run(id, ch.chapter, ch.heading ?? null);
      for (const c of ch.chunks) {
        const info = insChunk.run(id, ch.chapter, c.ordinal, c.heading ?? null, c.text, c.chunkRev);
        insFts.run(info.lastInsertRowid, c.text);
        chunks++;
      }
    }
    const r = content.ref;
    db.prepare(
      `INSERT INTO refs (ref_id, title, author, format, source_path, source_sha256, source_size, note_path, added, chapters, chunks,
         scrub_version, findings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, r.title, r.author, r.format, r.source_path, r.source_sha256, r.source_size, r.note_path, r.added,
      content.chapters.length, chunks, r.scrub_version, r.findings);
  }).immediate();
  return { chapters: content.chapters.length, chunks };
}

/** Delete one ref's rows and remember the removal. Returns false when it was not there. */
export function deleteRef(db: RefsDb, refId: string, now: string): boolean {
  let found = false;
  db.transaction(() => {
    found = refRow(db, refId) !== undefined;
    db.prepare('DELETE FROM refs_fts WHERE rowid IN (SELECT id FROM refs_chunks WHERE ref_id = ?)').run(refId);
    db.prepare('DELETE FROM refs_chunks WHERE ref_id = ?').run(refId);
    db.prepare('DELETE FROM refs_chapters WHERE ref_id = ?').run(refId);
    db.prepare('DELETE FROM refs WHERE ref_id = ?').run(refId);
    if (found) db.prepare('INSERT OR REPLACE INTO removed_refs (ref_id, removed) VALUES (?, ?)').run(refId, now);
  }).immediate();
  return found;
}
