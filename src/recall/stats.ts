// `note_stats` (cognition Phase 7): the recall record (`recalls.jsonl`) rolled
// up per note id, `{recall_count, last_recalled}`, in the derived index. It is
// derived data (I7): `rebuildNoteStats` recomputes the whole table from the
// file, so deleting the table (or the index) loses nothing. `recall_count`
// is the number of records that returned the note, `last_recalled` the
// latest record time (UTC, ISO 8601). The first record's time is kept in
// `meta` as `recall_tracking_start`: before it, "never recalled" is unknown.

import { getMeta, setMeta, type Db } from '../index/db.js';
import type { SafePath } from '../safe-path.js';
import { readRecalls } from './recalls.js';

export const TRACKING_START_KEY = 'recall_tracking_start';

export interface NoteStat {
  id: string;
  recall_count: number;
  last_recalled: string;
}

const TABLE = 'CREATE TABLE IF NOT EXISTS note_stats (id TEXT PRIMARY KEY, recall_count INTEGER NOT NULL, last_recalled TEXT NOT NULL) STRICT';

/** Rebuild `note_stats` from `recalls.jsonl` (creating the table if it was deleted). Returns the number of notes with stats. */
export function rebuildNoteStats(db: Db, stateDir: SafePath): number {
  const stats = new Map<string, { n: number; last: number }>();
  let first = Number.POSITIVE_INFINITY;
  for (const r of readRecalls(stateDir)) {
    const t = Date.parse(r.ts);
    if (t < first) first = t;
    for (const id of new Set(r.ids.map((x) => x.id))) {
      const s = stats.get(id) ?? { n: 0, last: Number.NEGATIVE_INFINITY };
      s.n++;
      if (t > s.last) s.last = t;
      stats.set(id, s);
    }
  }
  db.transaction(() => {
    db.exec(TABLE);
    db.exec('DELETE FROM note_stats');
    const ins = db.prepare('INSERT INTO note_stats (id, recall_count, last_recalled) VALUES (?, ?, ?)');
    for (const [id, s] of stats) ins.run(id, s.n, new Date(s.last).toISOString());
    setMeta(db, TRACKING_START_KEY, Number.isFinite(first) ? new Date(first).toISOString() : '');
  }).immediate();
  return stats.size;
}

/** Stats of one note id, if it was ever recalled. */
export function noteStat(db: Db, id: string): NoteStat | undefined {
  return db.prepare('SELECT id, recall_count, last_recalled FROM note_stats WHERE id = ?').get(id) as NoteStat | undefined;
}

/** When the recall record starts (its earliest record), or undefined when it is empty. */
export function trackingStart(db: Db): string | undefined {
  const v = getMeta(db, TRACKING_START_KEY);
  return v === undefined || v === '' ? undefined : v;
}
