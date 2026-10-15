// `ebrain ids assign [--folder <f>] [--dry-run]` (cognition Phase 1, G1).
// Owner CLI only. Gives every note that lacks an `id` a ULID `id:` (and
// `schema: 1` when there is no `schema` key) by inserting those lines at the
// top of the frontmatter (or a new frontmatter block before the first byte
// after any BOM). Nothing else in the file changes: the inserted bytes are
// the whole difference, and each edit is checked by re-parsing (same body,
// same other fields and unknown keys) before anything is written.
//
// The whole run is one undo operation (`ebrain undo <operation-id>`), each
// file a `rewrite` op whose raw SHA-256 is re-checked before publishing.
// Afterwards the index records each old provisional id as an alias of the
// new id until the next full rebuild (best effort; see src/index/identity.ts).
//
// Skipped (reported, never edited): notes with malformed frontmatter, an
// `id` key that is invalid or claimed by another note, frontmatter that is not
// a block mapping, and the raw conversation archive (`_raw/`, machine-written
// and re-imported by content).

import { isMap, parseDocument } from 'yaml';
import { recordIdAliases } from '../index/identity.js';
import { closeIndex, openIndex, refreshIndex, MAX_NOTE_BYTES } from '../index/indexer.js';
import { ulid } from '../mcp/ulid.js';
import { resolveInVault, readFileWithStatSafe, SafePathError, statSafe, type SafePath } from '../safe-path.js';
import { runOperation, sha256, type PlannedOp } from '../undo/store.js';
import { nfc } from '../vault/names.js';
import { canonicalJson, decodeNote, parseNote, splitFrontmatter } from '../vault/parse.js';

export const IDS_ASSIGN_COMMAND = 'ids assign';

export interface AssignOptions {
  vaultPath: string;
  stateDir: SafePath;
  /** Vault-relative folder to limit the run to. */
  folder?: string;
  dryRun?: boolean;
  now?: () => Date;
  /** Id generator (tests). */
  newId?: () => string;
}

export interface AssignResult {
  assigned: { path: string; id: string; previous: string }[];
  skipped: { path: string; reason: string }[];
  /** The undo operation (absent for a dry run or when nothing was assigned). */
  operationId?: string;
  aliases: number;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The note bytes with `id` (and `schema: 1` unless a `schema` key exists)
 * inserted, or a reason it cannot be done safely.
 */
export function insertId(data: Buffer, id: string): { ok: true; data: Buffer } | { ok: false; reason: string } {
  const before = parseNote('x.md', data);
  if (before.frontmatter === 'malformed') return { ok: false, reason: 'malformed frontmatter' };
  const split = splitFrontmatter(decodeNote(data).text);
  let hasSchema = false;
  if (split.yaml !== null) {
    const doc = parseDocument(split.yaml);
    if (doc.contents !== null) {
      if (!isMap(doc.contents) || doc.contents.flow) return { ok: false, reason: 'frontmatter is not a block mapping' };
      if (doc.contents.has('id')) return { ok: false, reason: 'has an id key that is invalid or duplicated' };
      hasSchema = doc.contents.has('schema');
    }
  }
  const start = data.subarray(0, 3).equals(BOM) ? 3 : 0;
  const head = data.subarray(start, start + 64).toString('latin1');
  let out: Buffer;
  if (split.yaml === null) {
    const eol = data.includes('\r\n') ? '\r\n' : '\n';
    const block = Buffer.from(`---${eol}id: ${id}${eol}schema: 1${eol}---${eol}`, 'utf8');
    out = Buffer.concat([data.subarray(0, start), block, data.subarray(start)]);
  } else {
    const m = /^---[ \t]*(\r\n|\n|\r)/.exec(head);
    if (m === null) return { ok: false, reason: 'unrecognized frontmatter opening' };
    const eol = m[1]!;
    const at = start + Buffer.byteLength(m[0], 'latin1');
    const lines = Buffer.from(`id: ${id}${eol}${hasSchema ? '' : `schema: 1${eol}`}`, 'utf8');
    out = Buffer.concat([data.subarray(0, at), lines, data.subarray(at)]);
  }
  const after = parseNote('x.md', out);
  const rest = (f: typeof before.fields) => canonicalJson({ ...f, id: null, schema: null });
  const same =
    after.frontmatter === 'ok' &&
    after.fields.id === id &&
    after.fields.schema === (hasSchema ? before.fields.schema : 1) &&
    after.body === before.body &&
    after.title === before.title &&
    canonicalJson([after.tags, after.aliases]) === canonicalJson([before.tags, before.aliases]) &&
    rest(after.fields) === rest(before.fields) &&
    canonicalJson(after.extra) === canonicalJson(before.extra) &&
    canonicalJson(after.problems) === canonicalJson(before.problems);
  if (!same) return { ok: false, reason: 'the edit would change other frontmatter; add the id by hand' };
  return { ok: true, data: out };
}

function folderPrefix(vaultPath: string, folder: string | undefined): string | undefined {
  if (folder === undefined) return undefined;
  const trimmed = folder.replace(/\/+$/, '');
  if (trimmed === '') return undefined;
  const st = statSafe(resolveInVault(vaultPath, trimmed));
  if (st === undefined || !st.isDirectory()) throw new SafePathError('invalid', `folder ${JSON.stringify(trimmed)} does not exist`);
  return nfc(trimmed);
}

export function assignIds(opts: AssignOptions): AssignResult {
  const prefix = folderPrefix(opts.vaultPath, opts.folder);
  const newId = opts.newId ?? (() => ulid((opts.now?.() ?? new Date()).getTime()));
  const h = openIndex({ vaultPath: opts.vaultPath, stateDir: opts.stateDir });
  try {
    refreshIndex(h);
    const rows = h.db.prepare(
      'SELECT path, prov_id, hash, folder_class FROM notes WHERE provisional = 1 ORDER BY path_nfc, path',
    ).all() as { path: string; prov_id: string; hash: string; folder_class: string }[];
    const taken = h.db.prepare('SELECT 1 FROM notes WHERE fm_id = ? OR id = ?');
    const result: AssignResult = { assigned: [], skipped: [], aliases: 0 };
    const planned: PlannedOp[] = [];
    const used = new Set<string>();
    for (const r of rows) {
      const p = nfc(r.path);
      if (prefix !== undefined && p !== prefix && !p.startsWith(`${prefix}/`)) continue;
      if (r.folder_class === 'raw') {
        result.skipped.push({ path: r.path, reason: 'raw conversation archive' });
        continue;
      }
      let data: Buffer;
      try {
        data = readFileWithStatSafe(resolveInVault(opts.vaultPath, r.path), { maxBytes: MAX_NOTE_BYTES }).data;
      } catch (err) {
        if (!(err instanceof SafePathError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        result.skipped.push({ path: r.path, reason: err instanceof Error ? err.message : 'unreadable' });
        continue;
      }
      let id = newId();
      while (used.has(id) || taken.get(id, id) !== undefined) id = newId();
      const edit = insertId(data, id);
      if (!edit.ok) {
        result.skipped.push({ path: r.path, reason: edit.reason });
        continue;
      }
      used.add(id);
      planned.push({ type: 'rewrite', path: r.path, data: edit.data, expectSha256: sha256(data) });
      result.assigned.push({ path: r.path, id, previous: r.prov_id });
    }
    if (opts.dryRun || planned.length === 0) return result;
    const manifest = runOperation(
      { vaultPath: opts.vaultPath, stateDir: opts.stateDir, ...(opts.now === undefined ? {} : { now: opts.now }) },
      IDS_ASSIGN_COMMAND,
      planned,
    );
    result.operationId = manifest!.operation_id;
    refreshIndex(h);
    result.aliases = recordIdAliases(
      h.db,
      result.assigned.map((a) => ({ alias: a.previous, id: a.id })),
      (opts.now?.() ?? new Date()).toISOString(),
    );
    return result;
  } finally {
    closeIndex(h);
  }
}
