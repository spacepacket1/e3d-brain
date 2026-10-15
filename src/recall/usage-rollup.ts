// `note_usage` (cognition Phase 8): per note id, `recalls` (records that
// returned it), `reported_used` (distinct self-reported (recall, note) events
// not marked `helpful: false`), and `evidence_linked_good` / `_bad` (events
// whose `outcome_ref` resolves in local evidence to a record with a verdict).
// Derived data (I7): `rebuildNoteUsage` recomputes the whole table from
// `recalls.jsonl` and `usage.jsonl` (plus the evidence source), so deleting
// the table loses nothing; two rebuilds from the same inputs give identical rows.
//
// `recalls` counts come from recalls.jsonl, which has the full returned list;
// the audit line's `returned` may be truncated to fit the line cap.
//
// Evidence-linked means: the `outcome_ref` is a well-formed citation, resolves
// through the Phase 3 resolver to a `thesis:` or `outcome:` record, that record
// occurred at or after the recall (an outcome that predates the recall cannot
// be a consequence of it), and its attributes carry a verdict: `result` one of
// good/success/win/positive/profit or bad/failure/loss/negative, or a boolean
// `success`. A resolving record without a verdict links nothing. Self-reported
// events never move `evidence_linked_*`, and nothing but those two counters
// ever affects ranking.

import { resolveCitation } from '../cite/resolve.js';
import type { Db } from '../index/db.js';
import type { EvidenceSource } from '../evidence/source.js';
import type { SafePath } from '../safe-path.js';
import { readRecalls } from './recalls.js';
import { readUsage } from './usage.js';

export interface NoteUsage {
  id: string;
  recalls: number;
  reported_used: number;
  evidence_linked_good: number;
  evidence_linked_bad: number;
}

const GOOD = new Set(['good', 'success', 'win', 'positive', 'profit']);
const BAD = new Set(['bad', 'failure', 'loss', 'negative']);

const TABLE = `CREATE TABLE IF NOT EXISTS note_usage (
  id TEXT PRIMARY KEY, recalls INTEGER NOT NULL, reported_used INTEGER NOT NULL,
  evidence_linked_good INTEGER NOT NULL, evidence_linked_bad INTEGER NOT NULL
) STRICT`;

function verdictOf(attributes: Readonly<Record<string, unknown>>): 'good' | 'bad' | undefined {
  const result = attributes['result'];
  if (typeof result === 'string') {
    const r = result.toLowerCase();
    if (GOOD.has(r)) return 'good';
    if (BAD.has(r)) return 'bad';
  }
  const success = attributes['success'];
  if (typeof success === 'boolean') return success ? 'good' : 'bad';
  return undefined;
}

/** The rollup rows, sorted by id. Pure over the two logs and the evidence source. */
export function computeNoteUsage(stateDir: SafePath, evidence?: EvidenceSource): NoteUsage[] {
  const rows = new Map<string, NoteUsage>();
  const row = (id: string): NoteUsage => {
    let r = rows.get(id);
    if (r === undefined) rows.set(id, (r = { id, recalls: 0, reported_used: 0, evidence_linked_good: 0, evidence_linked_bad: 0 }));
    return r;
  };
  const recallTs = new Map<string, number>();
  for (const rec of readRecalls(stateDir)) {
    recallTs.set(`${rec.principal}\u0000${rec.recall_id}`, Date.parse(rec.ts));
    for (const id of new Set(rec.ids.map((x) => x.id))) row(id).recalls++;
  }
  const seen = new Set<string>();
  for (const e of readUsage(stateDir)) {
    const ts = recallTs.get(`${e.principal}\u0000${e.recall_id}`);
    if (e.note_id === null || ts === undefined) continue;
    const key = `${e.recall_id}\u0000${e.note_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = row(e.note_id);
    if (e.helpful !== false) r.reported_used++;
    if (e.outcome_ref === undefined || evidence === undefined) continue;
    const res = resolveCitation(e.outcome_ref, { evidence });
    if (res.status !== 'resolved' || res.evidence === undefined) continue;
    if (!(Date.parse(res.evidence.occurred) >= ts)) continue;
    const verdict = verdictOf(res.evidence.attributes);
    if (verdict === 'good') r.evidence_linked_good++;
    else if (verdict === 'bad') r.evidence_linked_bad++;
  }
  return [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Rebuild `note_usage` (creating the table if it was deleted). Returns the rows written. */
export function rebuildNoteUsage(db: Db, stateDir: SafePath, evidence?: EvidenceSource): NoteUsage[] {
  const rows = computeNoteUsage(stateDir, evidence);
  db.transaction(() => {
    db.exec(TABLE);
    db.exec('DELETE FROM note_usage');
    const ins = db.prepare('INSERT INTO note_usage (id, recalls, reported_used, evidence_linked_good, evidence_linked_bad) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.id, r.recalls, r.reported_used, r.evidence_linked_good, r.evidence_linked_bad);
  }).immediate();
  return rows;
}

/** All rows as last rebuilt (empty when the table is missing). Sorted by id. */
export function readNoteUsage(db: Db): NoteUsage[] {
  try {
    return db.prepare('SELECT id, recalls, reported_used, evidence_linked_good, evidence_linked_bad FROM note_usage ORDER BY id').all() as NoteUsage[];
  } catch {
    return [];
  }
}

/** Evidence-linked good minus bad per note id, nonzero entries only, from the last rebuild. Never reads self-reported counts. */
export function usageNetByNote(db: Db): Map<string, number> {
  const net = new Map<string, number>();
  for (const r of readNoteUsage(db)) {
    const n = r.evidence_linked_good - r.evidence_linked_bad;
    if (n !== 0) net.set(r.id, n);
  }
  return net;
}
