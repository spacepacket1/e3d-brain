// Minimal index queries. These return matches in listing order (path, then
// ordinal) only; relevance ranking belongs to src/index/rank.ts (Phase 4, I13).

import type { Db } from './db.js';

/**
 * Turn free text into a safe FTS5 query: every word becomes a quoted term
 * (implicit AND), so FTS5 operators and syntax in user text are inert.
 * Returns undefined when the text has no searchable words.
 */
export function ftsQuery(text: string): string | undefined {
  const words = text.normalize('NFC').match(/[\p{L}\p{N}\p{M}_]+/gu);
  if (!words || words.length === 0) return undefined;
  return words.map((w) => `"${w}"`).join(' ');
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
