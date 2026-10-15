// Note identity (I12), revisions, and citation edges.
//
// Every note row carries a `prov_id`: its provisional identity, minted from
// the SHA-256 of the first-seen content hash plus the first-seen (NFC) vault
// path, kept while the note is edited in place, and carried across a rename
// only when the content hash makes the match unambiguous. The effective `id`
// is the frontmatter `id` when it is valid and the first note in path order
// to claim it; otherwise it is the `prov_id` (`provisional = 1`). A `prov_`
// id keeps resolving to its note after the note gains an explicit id, so
// citations made before `ids assign` report `stale`, not `missing`. `ids
// assign` also records each replaced provisional id in `id_aliases`, so it
// keeps resolving even after the note is later renamed and edited, until
// a full rebuild.
//
// Provisional ids, `missing_ids` (rename history), `id_aliases`, and provisional rows of
// `note_revisions` are best-effort: a full rebuild re-derives them from the
// current vault, and `ebrain index dump` leaves them out (I11).

import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { parseCitation, type NoteLookup } from '../cite/citation.js';
import { nfc } from '../vault/names.js';
import { explicitId, PROVISIONAL_PREFIX } from '../vault/parse.js';

/** Hex characters of the hash kept in a provisional id. */
const PROV_HEX = 20;

export interface IdentityCandidate {
  relPath: string;
  hash: string;
}

export interface GoneNote {
  path: string;
  hash: string;
  provId: string;
}

/** Snapshot of effective ids before a change, used to report identities that went missing. */
export type IdSnapshot = Map<string, { path: string; rev: string; provisional: boolean }>;

export function deriveProvisionalId(hash: string, relPath: string, attempt = 0): string {
  const input = attempt === 0 ? `${hash}\n${nfc(relPath)}` : `${hash}\n${nfc(relPath)}\n${attempt}`;
  return PROVISIONAL_PREFIX + createHash('sha256').update(input, 'utf8').digest('hex').slice(0, PROV_HEX);
}

export function isProvisionalId(id: string): boolean {
  return id.startsWith(PROVISIONAL_PREFIX);
}

/**
 * Choose a `prov_id` for each newly appeared file. A file inherits the
 * identity of a disappeared one only when their content hash is unambiguous:
 * exactly one file with that hash disappeared, exactly one appeared, and no
 * other indexed note has it. Anything else gets a freshly derived id.
 * Call after disappeared rows are deleted and before new rows are inserted.
 */
export function assignNewIdentities(db: Db, appeared: IdentityCandidate[], gone: GoneNote[]): Map<string, string> {
  const goneByHash = new Map<string, GoneNote[]>();
  for (const g of gone) goneByHash.set(g.hash, [...(goneByHash.get(g.hash) ?? []), g]);
  const appearedByHash = new Map<string, number>();
  for (const a of appeared) appearedByHash.set(a.hash, (appearedByHash.get(a.hash) ?? 0) + 1);
  const othersWithHash = db.prepare('SELECT COUNT(*) AS n FROM notes WHERE hash = ?');
  const inUse = db.prepare('SELECT 1 FROM notes WHERE prov_id = ?');

  const out = new Map<string, string>();
  const reserved = new Set<string>();
  for (const a of appeared) {
    const g = goneByHash.get(a.hash);
    if (g?.length === 1 && appearedByHash.get(a.hash) === 1 && (othersWithHash.get(a.hash) as { n: number }).n === 0) {
      out.set(a.relPath, g[0]!.provId);
      reserved.add(g[0]!.provId);
    }
  }
  for (const a of appeared) {
    if (out.has(a.relPath)) continue;
    let id: string;
    for (let attempt = 0; ; attempt++) {
      id = deriveProvisionalId(a.hash, a.relPath, attempt);
      if (!reserved.has(id) && inUse.get(id) === undefined) break;
    }
    out.set(a.relPath, id);
    reserved.add(id);
  }
  return out;
}

export function snapshotIds(db: Db): IdSnapshot {
  const rows = db.prepare('SELECT id, path, rev, provisional FROM notes').all() as
    { id: string; path: string; rev: string; provisional: number }[];
  return new Map(rows.map((r) => [r.id, { path: r.path, rev: r.rev, provisional: r.provisional === 1 }]));
}

/** Duplicate explicit ids: the first note in path order keeps the id, later ones fall back to their provisional id. */
function assignEffectiveIds(db: Db): void {
  const rows = db.prepare('SELECT path, fm_id, prov_id, id, provisional FROM notes ORDER BY path_nfc, path').all() as
    { path: string; fm_id: string | null; prov_id: string; id: string; provisional: number }[];
  const update = db.prepare('UPDATE notes SET id = ?, provisional = ? WHERE path = ?');
  const claimed = new Set<string>();
  for (const r of rows) {
    const explicit = explicitId(r.fm_id);
    const useExplicit = explicit !== null && !claimed.has(explicit);
    if (useExplicit) claimed.add(explicit);
    const id = useExplicit ? explicit : r.prov_id;
    const provisional = useExplicit ? 0 : 1;
    if (id !== r.id || provisional !== r.provisional) update.run(id, provisional, r.path);
  }
}

/** Rebuild `cites` from every note's `sources` and `derived_from`. */
function rebuildCites(db: Db): void {
  db.exec('DELETE FROM cites');
  const rows = db.prepare('SELECT path, id, sources, derived_from FROM notes').all() as
    { path: string; id: string; sources: string; derived_from: string }[];
  const insert = db.prepare(
    'INSERT INTO cites (from_path, ordinal, from_id, field, to_id, to_rev, citation) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    let ordinal = 0;
    for (const field of ['sources', 'derived_from'] as const) {
      for (const entry of JSON.parse(r[field]) as string[]) {
        const parsed = parseCitation(entry);
        if (!parsed.ok || parsed.citation.kind !== 'note') continue;
        insert.run(r.path, ordinal++, r.id, field, parsed.citation.id, parsed.citation.rev, entry);
      }
    }
  }
}

/**
 * After notes changed: settle effective ids, rebuild citation edges, record
 * new (id, rev) pairs, and update the missing-identity list against `before`
 * (`undefined` on a full rebuild, which has no history).
 */
export function finishIdentities(db: Db, before: IdSnapshot | undefined, now: string): void {
  assignEffectiveIds(db);
  rebuildCites(db);
  db.prepare('INSERT OR IGNORE INTO note_revisions (id, rev, first_seen) SELECT id, rev, ? FROM notes').run(now);
  if (before !== undefined) {
    const present = db.prepare(
      'SELECT 1 FROM notes WHERE id = ? OR prov_id = ? OR id IN (SELECT id FROM id_aliases WHERE alias = ?)',
    );
    const record = db.prepare(
      'INSERT OR REPLACE INTO missing_ids (id, provisional, last_path, last_rev, since) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [id, info] of before) {
      if (present.get(id, id, id) === undefined) record.run(id, info.provisional ? 1 : 0, info.path, info.rev, now);
    }
  }
  db.exec('DELETE FROM missing_ids WHERE id IN (SELECT id FROM notes) OR id IN (SELECT prov_id FROM notes)');
  db.exec('DELETE FROM missing_ids WHERE id IN (SELECT a.alias FROM id_aliases a JOIN notes n ON n.id = a.id)');
}

/**
 * Record that each provisional id now names the note with the assigned id
 * (`ebrain ids assign`). Pairs whose assigned id is not indexed are ignored.
 */
export function recordIdAliases(db: Db, pairs: readonly { alias: string; id: string }[], now: string): number {
  const exists = db.prepare('SELECT 1 FROM notes WHERE id = ? AND provisional = 0');
  const insert = db.prepare('INSERT OR REPLACE INTO id_aliases (alias, id, since) VALUES (?, ?, ?)');
  let n = 0;
  db.transaction(() => {
    for (const p of pairs) {
      if (!isProvisionalId(p.alias) || isProvisionalId(p.id) || exists.get(p.id) === undefined) continue;
      insert.run(p.alias, p.id, now);
      n++;
    }
    db.exec('DELETE FROM missing_ids WHERE id IN (SELECT a.alias FROM id_aliases a JOIN notes n ON n.id = a.id)');
  }).immediate();
  return n;
}

/** Forget best-effort identity history before a full rebuild. Explicit-id revisions are kept. */
export function clearIdentityHistory(db: Db): void {
  db.exec('DELETE FROM missing_ids');
  db.exec('DELETE FROM id_aliases');
  db.exec('DELETE FROM cites');
  db.prepare("DELETE FROM note_revisions WHERE id LIKE ? ESCAPE '\\'").run(`${PROVISIONAL_PREFIX.replace(/_/g, '\\_')}%`);
}

// ---- queries ----

export interface NoteIdentity {
  path: string;
  id: string;
  provisional: boolean;
  rev: string;
}

function toIdentity(r: { path: string; id: string; provisional: number; rev: string } | undefined): NoteIdentity | undefined {
  return r && { path: r.path, id: r.id, provisional: r.provisional === 1, rev: r.rev };
}

export function noteIdentityByPath(db: Db, path: string): NoteIdentity | undefined {
  return toIdentity(db.prepare('SELECT path, id, provisional, rev FROM notes WHERE path = ?').get(path) as never);
}

/** Column an id is looked up by: explicit ids by `id`, `prov_` ids by `prov_id` (see the module comment). */
function idColumn(id: string): 'id' | 'prov_id' {
  return isProvisionalId(id) ? 'prov_id' : 'id';
}

/**
 * Rows for an id: explicit ids by `id`; `prov_` ids by `prov_id`, then
 * through `id_aliases` to the assigned id that replaced them.
 */
function noteSql(cols: string, id: string): string {
  return idColumn(id) === 'id'
    ? `SELECT ${cols} FROM notes WHERE id = @id`
    : `SELECT ${cols} FROM (SELECT ${cols}, 0 AS via FROM notes WHERE prov_id = @id UNION ALL ` +
        `SELECT ${cols}, 1 AS via FROM notes WHERE provisional = 0 AND id = (SELECT id FROM id_aliases WHERE alias = @id)) ORDER BY via LIMIT 1`;
}

/** The note `id` refers to; its current `id` may differ when a provisional id was superseded by an explicit one. */
export function noteIdentityById(db: Db, id: string): NoteIdentity | undefined {
  return toIdentity(db.prepare(noteSql('path, id, provisional, rev', id)).get({ id }) as never);
}

/** The production `lookup` for `checkNoteCitation`. */
export function noteLookup(db: Db): NoteLookup {
  const byId = db.prepare(noteSql('rev', 'x'));
  const byProv = db.prepare(noteSql('rev', PROVISIONAL_PREFIX));
  return (id) => (idColumn(id) === 'id' ? byId : byProv).get({ id }) as { rev: string } | undefined;
}

export interface CitingNote {
  fromId: string;
  fromPath: string;
  provisional: boolean;
  field: 'sources' | 'derived_from';
  toRev: string;
  citation: string;
}

/**
 * Notes whose `sources` or `derived_from` cite the note `id` refers to (by
 * its current id, its provisional id, or `id` itself when it is an alias), in listing order.
 */
export function citingNotes(db: Db, id: string): CitingNote[] {
  const note = db.prepare(noteSql('id, prov_id', id)).get({ id }) as
    { id: string; prov_id: string } | undefined;
  const targets = note ? [note.id, note.prov_id, id] : [id, id, id];
  const rows = db.prepare(
    `SELECT c.from_id, c.from_path, n.provisional, c.field, c.to_rev, c.citation
       FROM cites c JOIN notes n ON n.path = c.from_path
      WHERE c.to_id IN (?, ?, ?) ORDER BY n.path_nfc, n.path, c.ordinal`,
  ).all(...targets) as { from_id: string; from_path: string; provisional: number; field: CitingNote['field']; to_rev: string; citation: string }[];
  return rows.map((r) => ({
    fromId: r.from_id, fromPath: r.from_path, provisional: r.provisional === 1, field: r.field, toRev: r.to_rev, citation: r.citation,
  }));
}

export function noteRevisions(db: Db, id: string): { rev: string; firstSeen: string }[] {
  return (db.prepare('SELECT rev, first_seen FROM note_revisions WHERE id = ? ORDER BY first_seen, rev').all(id) as
    { rev: string; first_seen: string }[]).map((r) => ({ rev: r.rev, firstSeen: r.first_seen }));
}

/** Explicit ids claimed by more than one note, with their paths in listing order. */
export function duplicateIds(db: Db): { id: string; paths: string[] }[] {
  const rows = db.prepare('SELECT path, fm_id FROM notes WHERE fm_id IS NOT NULL ORDER BY path_nfc, path').all() as
    { path: string; fm_id: string }[];
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const id = explicitId(r.fm_id);
    if (id !== null) groups.set(id, [...(groups.get(id) ?? []), r.path]);
  }
  return [...groups].filter(([, paths]) => paths.length > 1).map(([id, paths]) => ({ id, paths }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface MissingIdentity {
  id: string;
  provisional: boolean;
  lastPath: string;
  lastRev: string;
  since: string;
}

export function missingIdentities(db: Db): MissingIdentity[] {
  return (db.prepare('SELECT id, provisional, last_path, last_rev, since FROM missing_ids ORDER BY since, id').all() as
    { id: string; provisional: number; last_path: string; last_rev: string; since: string }[]).map((r) => ({
    id: r.id, provisional: r.provisional === 1, lastPath: r.last_path, lastRev: r.last_rev, since: r.since,
  }));
}
