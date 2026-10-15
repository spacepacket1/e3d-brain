// The derived SQLite index, `<stateDir>/index.db` (I7: rebuildable from the
// vault at any time). WAL mode plus a busy timeout lets the CLI and any number
// of MCP processes share it: readers never block, writers queue. The state dir
// must be on a local filesystem (WAL needs shared memory; see docs/SETUP.md).

import type BetterSqlite3 from 'better-sqlite3';
import { loadSqlite, NATIVE_BUILD_HINT } from './sqlite.js';
import { createExclusive, resolveInState, SafePathError, statSafe, type SafePath } from '../safe-path.js';

export type Db = BetterSqlite3.Database;

export const INDEX_FILE = 'index.db';
export const BUSY_TIMEOUT_MS = 10000;
/** Bump when the table layout changes: an index with another version is rebuilt. */
export const SCHEMA_VERSION = 7;

const TABLES = [
  'meta', 'notes', 'chunks', 'chunks_fts', 'links', 'tags', 'aliases', 'headings', 'problems', 'cites', 'note_revisions',
  'missing_ids', 'id_aliases', 'chunk_vectors', 'note_stats', 'note_usage',
];

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE notes (
  path TEXT PRIMARY KEY,          -- vault-relative, exactly as named on disk
  path_nfc TEXT NOT NULL,         -- listing order: bytewise (BINARY) on this, then on path
  path_fold TEXT NOT NULL,        -- NFC + case fold of the whole path (collisions)
  basename_fold TEXT NOT NULL,    -- NFC + case fold of the name without .md (links)
  size TEXT NOT NULL,
  mtime_ns TEXT NOT NULL,
  ino TEXT NOT NULL,
  ctime_ns TEXT NOT NULL,
  racy INTEGER NOT NULL,          -- mtime too close to the read time to trust the stat key
  hash TEXT NOT NULL,             -- SHA-256 of the raw file bytes
  rev TEXT NOT NULL,              -- note revision: 16 hex of SHA-256 of the normalized text
  id TEXT NOT NULL,               -- effective id: fm_id when valid and first in path order, else prov_id
  provisional INTEGER NOT NULL,   -- id is prov_id
  prov_id TEXT NOT NULL,          -- provisional identity; follows unambiguous renames and in-place edits
  title TEXT NOT NULL,
  folder_class TEXT NOT NULL,
  folder_hidden INTEGER NOT NULL,
  frontmatter TEXT NOT NULL,      -- none | ok | malformed
  fm_id TEXT,
  status TEXT,
  status_known INTEGER NOT NULL,
  pinned INTEGER,
  kind TEXT,
  occurred TEXT,
  valid_from TEXT,
  valid_until TEXT,
  created TEXT,
  expires TEXT,
  accepted TEXT,
  applied TEXT,
  superseded_at TEXT,
  archived_at TEXT,
  author TEXT,
  origin TEXT,
  sources TEXT NOT NULL,          -- JSON array
  untrusted_origin INTEGER,
  superseded_by TEXT,
  supersedes TEXT NOT NULL,       -- JSON array
  merged_into TEXT,
  derived_from TEXT NOT NULL,     -- JSON array
  schema_version INTEGER,
  scrub_version TEXT,
  extra TEXT NOT NULL             -- unknown frontmatter keys, canonical JSON object
) STRICT;
CREATE INDEX notes_order ON notes (path_nfc, path);
CREATE INDEX notes_fold ON notes (path_fold);
CREATE INDEX notes_basename ON notes (basename_fold);
CREATE INDEX notes_id ON notes (id);
CREATE UNIQUE INDEX notes_prov_id ON notes (prov_id);
CREATE INDEX notes_hash ON notes (hash);
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,         -- rowid shared with chunks_fts; not stable across rebuilds
  note_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading_path TEXT NOT NULL,     -- JSON array of heading texts
  text TEXT NOT NULL,
  chunk_rev TEXT NOT NULL,        -- same procedure as rev, over the chunk text
  UNIQUE (note_path, ordinal)
) STRICT;
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, tokenize = 'porter unicode61 remove_diacritics 2');
CREATE TABLE links (
  note_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  line INTEGER NOT NULL,
  target TEXT NOT NULL,
  anchor TEXT,
  alias TEXT,
  embed INTEGER NOT NULL,
  resolved_path TEXT,             -- NULL when unresolved
  resolution TEXT NOT NULL,       -- path | basename | alias | self | unresolved
  candidates INTEGER NOT NULL,    -- notes that matched at the deciding rule (>1: ambiguous)
  PRIMARY KEY (note_path, ordinal)
) STRICT;
CREATE INDEX links_resolved ON links (resolved_path);
CREATE TABLE tags (note_path TEXT NOT NULL, tag TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (note_path, tag)) STRICT;
CREATE INDEX tags_tag ON tags (tag);
CREATE TABLE aliases (note_path TEXT NOT NULL, alias TEXT NOT NULL, alias_fold TEXT NOT NULL, PRIMARY KEY (note_path, alias)) STRICT;
CREATE INDEX aliases_fold ON aliases (alias_fold);
CREATE TABLE headings (
  note_path TEXT NOT NULL, ordinal INTEGER NOT NULL, level INTEGER NOT NULL, text TEXT NOT NULL, line INTEGER NOT NULL,
  PRIMARY KEY (note_path, ordinal)
) STRICT;
-- Note-to-note citations from sources and derived_from (rebuilt with every content change).
CREATE TABLE cites (
  from_path TEXT NOT NULL, ordinal INTEGER NOT NULL, from_id TEXT NOT NULL, field TEXT NOT NULL,
  to_id TEXT NOT NULL, to_rev TEXT NOT NULL, citation TEXT NOT NULL,
  PRIMARY KEY (from_path, ordinal)
) STRICT;
CREATE INDEX cites_to ON cites (to_id);
-- Every (id, rev) pair seen. Hashes only, never content.
CREATE TABLE note_revisions (id TEXT NOT NULL, rev TEXT NOT NULL, first_seen TEXT NOT NULL, PRIMARY KEY (id, rev)) STRICT;
-- Identities that were indexed and are no longer present (rename history; cleared by a full rebuild).
CREATE TABLE missing_ids (
  id TEXT PRIMARY KEY, provisional INTEGER NOT NULL, last_path TEXT NOT NULL, last_rev TEXT NOT NULL, since TEXT NOT NULL
) STRICT;
-- Provisional ids replaced by assigned ids (\`ebrain ids assign\`): alias -> id. Best effort; cleared by a full rebuild.
CREATE TABLE id_aliases (alias TEXT PRIMARY KEY, id TEXT NOT NULL, since TEXT NOT NULL) STRICT;
CREATE INDEX id_aliases_id ON id_aliases (id);
-- Optional embeddings (Phase 12): one unit-length float32 vector per chunk, valid while chunk_rev and model match.
CREATE TABLE chunk_vectors (
  note_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  chunk_rev TEXT NOT NULL,        -- content hash of the chunk text the vector was made from
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (note_path, ordinal)
) STRICT;
-- Recall rollup (cognition Phase 7): derived from recalls.jsonl by src/recall/stats.ts, rebuilt from it at any time.
CREATE TABLE note_stats (id TEXT PRIMARY KEY, recall_count INTEGER NOT NULL, last_recalled TEXT NOT NULL) STRICT;
-- Usage rollup (cognition Phase 8): derived from recalls.jsonl and usage.jsonl by src/recall/usage-rollup.ts, rebuilt from them at any time.
CREATE TABLE note_usage (
  id TEXT PRIMARY KEY,
  recalls INTEGER NOT NULL,
  reported_used INTEGER NOT NULL,
  evidence_linked_good INTEGER NOT NULL,
  evidence_linked_bad INTEGER NOT NULL
) STRICT;
CREATE TABLE problems (
  note_path TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, field TEXT, detail TEXT NOT NULL,
  PRIMARY KEY (note_path, ordinal)
) STRICT;
`;

export class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexError';
  }
}

function loadDatabase(): typeof BetterSqlite3 {
  const loaded = loadSqlite();
  if (!loaded.ok) throw new IndexError(`better-sqlite3 failed to load: ${loaded.error}; ${NATIVE_BUILD_HINT}`);
  return loaded.Database;
}

export function indexPath(stateDir: SafePath): SafePath {
  return resolveInState(stateDir, INDEX_FILE);
}

export function indexExists(stateDir: SafePath): boolean {
  return statSafe(indexPath(stateDir)) !== undefined;
}

function createSchema(db: Db): void {
  db.exec(SCHEMA);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
}

function dropAll(db: Db): void {
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Switch to WAL. Two processes opening a fresh index at once (several MCP
 * servers starting together) can get SQLITE_BUSY from this pragma without the
 * busy handler being consulted, so it is retried for up to the busy timeout.
 */
function setWal(db: Db): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if ((code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') || Date.now() >= deadline) throw err;
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
}

/**
 * Open (creating if needed) the index. The file is pre-created 0600 (I8);
 * SQLite gives its -wal and -shm files the same mode. An index written by a
 * different schema version is dropped and recreated (it is derived data).
 */
export function openIndexDb(stateDir: SafePath, opts: { mustExist?: boolean } = {}): Db {
  const Database = loadDatabase();
  const file = indexPath(stateDir);
  if (statSafe(file) === undefined) {
    if (opts.mustExist) throw new IndexError(`index not built: ${file} (run \`ebrain reindex\`)`);
    try {
      createExclusive(file, '');
    } catch (err) {
      if (!(err instanceof SafePathError && err.code === 'exists')) throw err;
    }
  }
  let db: Db;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    setWal(db);
    db.pragma('synchronous = NORMAL');
  } catch (err) {
    throw new IndexError(`cannot open index ${file}: ${err instanceof Error ? err.message : String(err)}; ` +
      'it is derived data: delete it and run `ebrain reindex --full`');
  }
  const current = () =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined &&
    getMeta(db, 'schema_version') === String(SCHEMA_VERSION);
  try {
    // Check without the write lock first so opening never waits on a writer.
    if (!current()) {
      db.transaction(() => {
        if (current()) return;
        dropAll(db);
        createSchema(db);
      }).immediate();
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
