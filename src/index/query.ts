// Minimal index queries. These return matches in listing order (path, then
// ordinal) only; relevance ranking belongs to src/index/rank.ts (Phase 4, I13).

import type { Db } from './db.js';

/** Question and glue words that carry no topic. Dropped from plain queries ("who accepts proposals" searches for "accepts proposals"). */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'by', 'as', 'from', 'about', 'who', 'what', 'when', 'where', 'why', 'how', 'which', 'that', 'this',
  'these', 'those', 'it', 'its', 'i', 'we', 'you', 'they', 'he', 'she', 'my', 'our', 'your', 'and', 'or', 'not', 'can',
  'could', 'should', 'would', 'will', 'has', 'have', 'had', 'there', 'if', 'then', 'so', 'than',
]);

/**
 * The searchable words of free text: NFC words, de-duplicated (case-insensitively), with stopwords removed.
 * A query made only of stopwords keeps them, so it still searches for something.
 */
export function searchTerms(text: string): string[] {
  const words = text.normalize('NFC').match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
  const seen = new Set<string>();
  const all: string[] = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      all.push(w);
    }
  }
  const content = all.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  return content.length > 0 ? content : all;
}

/**
 * Turn free text into a safe FTS5 query: every searchable word becomes a quoted term
 * (implicit AND), so FTS5 operators and syntax in user text are inert.
 * Returns undefined when the text has no searchable words.
 */
export function ftsQuery(text: string): string | undefined {
  const terms = searchTerms(text);
  if (terms.length === 0) return undefined;
  return terms.map((w) => `"${w}"`).join(' ');
}

/**
 * The looser form of `ftsQuery`: any word may match (quoted terms joined by OR), ranked by BM25. Used only as a
 * fallback when the strict query finds nothing visible. Undefined when there are fewer than two words (no looser form).
 */
export function ftsQueryAny(text: string): string | undefined {
  const terms = searchTerms(text);
  if (terms.length < 2) return undefined;
  return terms.map((w) => `"${w}"`).join(' OR ');
}

export interface ChunkMatch {
  path: string;
  ordinal: number;
  headingPath: string[];
}

/** Chunks whose text matches every word of `text`, in listing order. */
export function matchChunks(db: Db, text: string): ChunkMatch[] {
  const query = ftsQuery(text);
  if (query === undefined) return [];
  const rows = db
    .prepare(
      `SELECT c.note_path AS path, c.ordinal AS ordinal, c.heading_path AS heading_path
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN notes n ON n.path = c.note_path
       WHERE chunks_fts MATCH ? ORDER BY n.path_nfc, n.path, c.ordinal`,
    )
    .all(query) as { path: string; ordinal: number; heading_path: string }[];
  return rows.map((r) => ({ path: r.path, ordinal: r.ordinal, headingPath: JSON.parse(r.heading_path) as string[] }));
}

/** All indexed note paths in listing order. */
export function listNotePaths(db: Db): string[] {
  return (db.prepare('SELECT path FROM notes ORDER BY path_nfc, path').all() as { path: string }[]).map((r) => r.path);
}

// ---- read-tool queries (Phase 6) ----
// Unordered candidate sets: the MCP tools filter them and put them in their
// final order with rank() (I13).

/** The note columns every read-tool result is built from. */
export interface NoteRow {
  path: string;
  id: string;
  provisional: number;
  rev: string;
  title: string;
  folder_class: string;
  folder_hidden: number;
  status: string | null;
  status_known: number;
  kind: string | null;
  occurred: string | null;
  valid_from: string | null;
  valid_until: string | null;
  superseded_at: string | null;
  archived_at: string | null;
  /** JSON array. */
  sources: string;
  created: string | null;
  expires: string | null;
  author: string | null;
  /** 1, 0, or null when absent. */
  untrusted_origin: number | null;
}

const NOTE_SELECT = `n.path AS path, n.id AS id, n.provisional AS provisional, n.rev AS rev, n.title AS title,
  n.folder_class AS folder_class, n.folder_hidden AS folder_hidden, n.status AS status, n.status_known AS status_known,
  n.kind AS kind, n.occurred AS occurred, n.valid_from AS valid_from, n.valid_until AS valid_until,
  n.superseded_at AS superseded_at, n.archived_at AS archived_at, n.sources AS sources,
  n.created AS created, n.expires AS expires, n.author AS author, n.untrusted_origin AS untrusted_origin`;

export interface ChunkHit extends NoteRow {
  ordinal: number;
  /** JSON array of heading texts. */
  heading_path: string;
  text: string;
  snippet: string;
  /** FTS5 bm25(): lower is more relevant. */
  bm25: number;
}

/**
 * Every chunk matching an FTS5 query (already escaped by `ftsQuery`, or the
 * caller's own syntax in advanced mode), with its BM25 value and a short
 * snippet. Throws the SQLite error for invalid FTS syntax.
 */
export function searchChunks(db: Db, match: string): ChunkHit[] {
  return db
    .prepare(
      `SELECT ${NOTE_SELECT}, c.ordinal AS ordinal, c.heading_path AS heading_path, c.text AS text,
         snippet(chunks_fts, 0, '', '', '...', 32) AS snippet, bm25(chunks_fts) AS bm25
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN notes n ON n.path = c.note_path
       WHERE chunks_fts MATCH ?`,
    )
    .all(match) as ChunkHit[];
}

/** The chunks at the given (path, ordinal) keys, as hits without a BM25 value (vector-only results). */
export function chunkHitsByKeys(db: Db, keys: readonly { path: string; ordinal: number }[]): ChunkHit[] {
  const stmt = db.prepare(
    `SELECT ${NOTE_SELECT}, c.ordinal AS ordinal, c.heading_path AS heading_path, c.text AS text, substr(c.text, 1, 200) AS snippet, 0 AS bm25
     FROM chunks c JOIN notes n ON n.path = c.note_path WHERE c.note_path = ? AND c.ordinal = ?`,
  );
  const out: ChunkHit[] = [];
  for (const k of keys) {
    const row = stmt.get(k.path, k.ordinal) as ChunkHit | undefined;
    if (row !== undefined) out.push(row);
  }
  return out;
}

export function allNoteRows(db: Db): NoteRow[] {
  return db.prepare(`SELECT ${NOTE_SELECT} FROM notes n`).all() as NoteRow[];
}

/** The note at `path` exactly, else the single note whose NFC path equals NFC(`path`). */
export function noteRowByPath(db: Db, path: string): NoteRow | undefined {
  const exact = db.prepare(`SELECT ${NOTE_SELECT} FROM notes n WHERE n.path = ?`).get(path) as NoteRow | undefined;
  if (exact !== undefined) return exact;
  const byNfc = db.prepare(`SELECT ${NOTE_SELECT} FROM notes n WHERE n.path_nfc = ?`).all(path.normalize('NFC')) as NoteRow[];
  return byNfc.length === 1 ? byNfc[0] : undefined;
}

/** Tags of every note, keyed by path. */
export function tagsByPath(db: Db): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db.prepare('SELECT note_path, tag FROM tags ORDER BY tag').all() as { note_path: string; tag: string }[]) {
    const list = out.get(r.note_path);
    if (list === undefined) out.set(r.note_path, [r.tag]);
    else list.push(r.tag);
  }
  return out;
}

/** Text of a note's first chunk (for listing excerpts). */
export function firstChunkText(db: Db, path: string): string {
  const row = db.prepare('SELECT text FROM chunks WHERE note_path = ? AND ordinal = 0').get(path) as { text: string } | undefined;
  return row?.text ?? '';
}

/** Structural neighbours of a note: who links to it, what it links to, and notes sharing a tag (with the shared tags). */
export function neighbours(db: Db, path: string): { backlinks: NoteRow[]; outgoing: NoteRow[]; sharedTags: { row: NoteRow; tags: string[] }[] } {
  const backlinks = db
    .prepare(`SELECT ${NOTE_SELECT} FROM notes n WHERE n.path IN (SELECT note_path FROM links WHERE resolved_path = ? AND note_path <> ?)`)
    .all(path, path) as NoteRow[];
  const outgoing = db
    .prepare(`SELECT ${NOTE_SELECT} FROM notes n WHERE n.path IN (SELECT resolved_path FROM links WHERE note_path = ? AND resolved_path <> ?)`)
    .all(path, path) as NoteRow[];
  const shared = db
    .prepare('SELECT t2.note_path AS path, t2.tag AS tag FROM tags t1 JOIN tags t2 ON t2.tag = t1.tag AND t2.note_path <> t1.note_path WHERE t1.note_path = ? ORDER BY t2.tag')
    .all(path) as { path: string; tag: string }[];
  const tagsOf = new Map<string, string[]>();
  for (const s of shared) {
    const list = tagsOf.get(s.path);
    if (list === undefined) tagsOf.set(s.path, [s.tag]);
    else list.push(s.tag);
  }
  const rowStmt = db.prepare(`SELECT ${NOTE_SELECT} FROM notes n WHERE n.path = ?`);
  const sharedTags: { row: NoteRow; tags: string[] }[] = [];
  for (const [p, tags] of tagsOf) {
    const row = rowStmt.get(p) as NoteRow | undefined;
    if (row !== undefined) sharedTags.push({ row, tags });
  }
  return { backlinks, outgoing, sharedTags };
}

// ---- inbox review queries (Phase 8) ----

/** What `ebrain inbox` needs to know about a note. */
export interface ReviewRow {
  path: string;
  id: string;
  fm_id: string | null;
  provisional: number;
  rev: string;
  title: string;
  folder_class: string;
  folder_hidden: number;
  status: string | null;
  kind: string | null;
  created: string | null;
  author: string | null;
  frontmatter: string;
}

const REVIEW_SELECT = `path, id, fm_id, provisional, rev, title, folder_class, folder_hidden, status, kind, created, author, frontmatter`;

/** Every note whose effective id or frontmatter id is `id` (a crash between accept's two steps leaves two). */
export function reviewRowsById(db: Db, id: string): ReviewRow[] {
  return db.prepare(`SELECT ${REVIEW_SELECT} FROM notes WHERE id = ? OR fm_id = ?`).all(id, id) as ReviewRow[];
}

/** The review fields of one note. */
export function reviewRowByPath(db: Db, path: string): ReviewRow | undefined {
  return db.prepare(`SELECT ${REVIEW_SELECT} FROM notes WHERE path = ?`).get(path) as ReviewRow | undefined;
}
