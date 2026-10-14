// The owner's review gate (Phase 8): list, show, accept, and reject inbox
// proposals. CLI only: no MCP tool reaches this module (I2), and a scan test
// keeps src/mcp/ from importing it.
//
// accept: rewrite the proposal's frontmatter (`status: accepted`,
// `accepted: <ts>`, the `id` kept, or assigned when the note had none) into a
// new file in the destination folder with `createExclusive` (never
// overwriting; a name collision gets a numeric suffix), then unlink the
// source. If a crash leaves both, re-running accept with the same id finds
// the accepted copy and finishes by unlinking the source (`ebrain doctor`
// reports the duplicate id until then). reject does the same into
// `_inbox/_rejected/` with `status: rejected`. Both rewrite only notes the
// model proposed, so they are exempt from the undo store; the new `rev` makes
// citations pinned to the proposed revision `stale`, by design.

import * as path from 'node:path';
import { parseDocument } from 'yaml';
import { refreshIndex, MAX_NOTE_BYTES, type IndexHandle } from '../index/indexer.js';
import { allNoteRows, reviewRowByPath, reviewRowsById, type ReviewRow } from '../index/query.js';
import { rank } from '../index/rank.js';
import { ulid } from '../mcp/ulid.js';
import {
  createExclusive, mkdirSafe, readFileWithStatSafe, resolveInVault, SafePathError, statSafe, unlinkSafe, type SafePath,
} from '../safe-path.js';
import { foldKey, type FolderClass } from '../vault/names.js';
import { decodeNote, explicitId, splitFrontmatter } from '../vault/parse.js';
import { isoSeconds } from './note.js';
import { INBOX_DIR, inboxDir, MAX_NAME_ATTEMPTS } from './writer.js';

/** Default `accept` destination. */
export const DEFAULT_ACCEPT_FOLDER = 'notes';
/** Where `reject` keeps rejected proposals. */
export const REJECTED_DIR = `${INBOX_DIR}/_rejected`;
/** Top-level folders `accept --to` may not be (or be under). */
export const FORBIDDEN_DESTINATIONS: readonly string[] = ['_inbox', 'journal', '_raw', '_archive'];
const MAX_REASON_CHARS = 500;

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ReviewEnv {
  vaultPath: string;
  index: IndexHandle;
  now?: () => Date;
  /** Test hook: runs after the destination is written and before the source is unlinked (simulate a crash by throwing). */
  afterDestinationWrite?: () => void;
}

export interface ProposalSummary {
  id: string;
  provisional: boolean;
  path: string;
  title: string;
  kind: string | null;
  created: string | null;
  author: string | null;
}

/** A visible proposal: under `_inbox/` but not `_inbox/_rejected/` or `_inbox/_applied/`. */
function isOpenProposal(r: Pick<ReviewRow, 'folder_class' | 'folder_hidden'>): boolean {
  return r.folder_class === 'inbox' && r.folder_hidden === 0;
}

/** Open proposals in ranking order (all inbox tier, so oldest file name first). */
export function listProposals(env: ReviewEnv): ProposalSummary[] {
  refreshIndex(env.index);
  const { db } = env.index;
  const rows = allNoteRows(db).filter((r) => r.folder_class === 'inbox' && r.folder_hidden === 0);
  const ranked = rank(rows.map((r) => ({ path: r.path, folderClass: r.folder_class as FolderClass, folderHidden: false, row: r })), {
    includeHidden: true,
  });
  return ranked.flatMap(({ item }) => {
    const r = reviewRowByPath(db, item.path);
    if (r === undefined) return [];
    return [{ id: r.id, provisional: r.provisional === 1, path: r.path, title: r.title, kind: r.kind, created: r.created, author: r.author }];
  });
}

function readNoteText(env: ReviewEnv, relPath: string): string {
  return decodeNote(readFileWithStatSafe(resolveInVault(env.vaultPath, relPath), { maxBytes: MAX_NOTE_BYTES }).data).text;
}

function rowsFor(env: ReviewEnv, id: string): ReviewRow[] {
  if (!/^[A-Za-z0-9_]{1,128}$/.test(id)) throw new ReviewError('not a note id');
  refreshIndex(env.index);
  return reviewRowsById(env.index.db, id);
}

/** The note text of an inbox note (open, rejected, or applied) with this id. */
export function showProposal(env: ReviewEnv, id: string): { path: string; text: string } {
  const row = rowsFor(env, id).find((r) => r.folder_class === 'inbox');
  if (row === undefined) throw new ReviewError(`no inbox note with id ${id}`);
  return { path: row.path, text: readNoteText(env, row.path) };
}

/**
 * Set frontmatter keys on a note's text, preserving every other key, its
 * order, and the body byte for byte. A note without frontmatter gets one;
 * malformed frontmatter is refused (I10).
 */
export function setFrontmatter(text: string, set: Readonly<Record<string, unknown>>, ifMissing: Readonly<Record<string, unknown>> = {}): string {
  const split = splitFrontmatter(text);
  if (split.unclosed) throw new ReviewError('the note has an unclosed frontmatter block; fix it by hand first');
  const doc = parseDocument(split.yaml ?? '', { schema: 'core', prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) throw new ReviewError('the note has malformed frontmatter; fix it by hand first');
  const contents: unknown = doc.toJS({ maxAliasCount: 100 });
  if (contents !== null && contents !== undefined && (typeof contents !== 'object' || Array.isArray(contents))) {
    throw new ReviewError('the note frontmatter is not a mapping; fix it by hand first');
  }
  for (const [k, v] of Object.entries(ifMissing)) if (!doc.has(k)) doc.set(k, v);
  for (const [k, v] of Object.entries(set)) doc.set(k, v);
  const yaml = doc.toString({ lineWidth: 0 });
  return `---\n${yaml.endsWith('\n') ? yaml : `${yaml}\n`}---\n${split.body}`;
}

/** The id the rewritten note carries: its own valid id, or a new ULID when it had none. */
function idToKeep(row: ReviewRow): string {
  if (row.fm_id === null) return ulid();
  if (explicitId(row.fm_id) === null) throw new ReviewError('the note has an unusable id; fix it by hand first');
  return row.fm_id;
}

/**
 * Validate an `accept --to` folder: resolved through safe-path inside the
 * vault, not (and not under) `_inbox/`, `journal/`, `_raw/`, `_archive/`, or
 * a dot-directory, also after symlinks are resolved. Returns the vault-relative
 * folder (created 0700 if missing, unless `create: false`).
 */
export function resolveDestination(vaultPath: string, to: string, opts: { create?: boolean } = {}): { rel: string; dir: SafePath } {
  const rel = to.replace(/\/+$/, '');
  if (rel === '') throw new ReviewError('--to needs a folder inside the vault');
  const refuse = (segments: readonly string[]) => {
    const first = segments[0] === undefined ? '' : foldKey(segments[0]);
    if (FORBIDDEN_DESTINATIONS.includes(first)) throw new ReviewError(`--to may not be or be under ${segments[0]}/`);
    if (segments.some((s) => s.startsWith('.'))) throw new ReviewError('--to may not be or be under a dot-directory');
  };
  refuse(rel.split('/'));
  let dir: SafePath;
  try {
    dir = resolveInVault(vaultPath, rel);
  } catch (err) {
    if (err instanceof SafePathError) throw new ReviewError(`--to rejected: ${err.code === 'escape' ? 'it resolves outside the vault' : err.message}`);
    throw err;
  }
  const root = resolveInVault(vaultPath, '');
  const real = path.relative(root, dir);
  if (real === '') throw new ReviewError('--to may not be the vault root');
  refuse(real.split(path.sep));
  const st = statSafe(dir);
  if (st === undefined) {
    if (opts.create !== false) mkdirSafe(dir);
  } else if (!st.isDirectory()) throw new ReviewError('--to is not a folder');
  return { rel: real.split(path.sep).join('/'), dir };
}

/** File name stem in the destination: the inbox `<yyyymmdd-hhmmss>-` prefix is dropped. */
export function destinationStem(sourcePath: string, keepStamp = false): string {
  const base = path.posix.basename(sourcePath).replace(/\.md$/i, '');
  const stem = keepStamp ? base : base.replace(/^\d{8}-\d{6}-/, '');
  return stem === '' ? base : stem;
}

/** Create `<dirRel>/<stem>[-n].md` exclusively; returns its vault-relative path. */
function createInFolder(vaultPath: string, dirRel: string, dir: SafePath, stem: string, text: string): string {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const name = `${attempt === 0 ? stem : `${stem}-${attempt + 1}`}.md`;
    const target = resolveInVault(vaultPath, `${dirRel}/${name}`);
    if (path.dirname(target) !== dir) throw new SafePathError('escape', 'destination resolves outside its folder');
    try {
      createExclusive(target, text);
      return `${dirRel}/${name}`;
    } catch (err) {
      if (err instanceof SafePathError && err.code === 'exists') continue;
      throw err;
    }
  }
  throw new ReviewError('too many files with this name in the destination folder');
}

export interface MoveResult {
  outcome: 'moved' | 'recovered' | 'already';
  id: string;
  from: string;
  to: string;
}

interface MoveSpec {
  /** The completed copy of an interrupted earlier run, if this row is one. */
  isDone: (r: ReviewRow) => boolean;
  status: 'accepted' | 'rejected';
  stampKey: 'accepted' | 'rejected';
  extra: Record<string, unknown>;
  destination: () => { rel: string; dir: SafePath };
  keepStamp: boolean;
}

function moveProposal(env: ReviewEnv, id: string, spec: MoveSpec): MoveResult {
  const rows = rowsFor(env, id);
  const open = rows.filter(isOpenProposal);
  if (open.length > 1) throw new ReviewError(`id ${id} is shared by several proposals: ${open.map((r) => r.path).join(', ')}`);
  const source = open[0];
  const done = rows.filter((r) => !isOpenProposal(r) && r.fm_id === id && spec.isDone(r));
  const others = rows.filter((r) => !isOpenProposal(r) && !done.includes(r));

  if (source === undefined) {
    if (done[0] !== undefined) return { outcome: 'already', id, from: '', to: done[0].path };
    throw new ReviewError(`no proposal in ${INBOX_DIR}/ with id ${id}`);
  }
  const text = readNoteText(env, source.path);
  if (done[0] !== undefined) {
    // An earlier run wrote the destination and stopped before unlinking the source.
    if (source.fm_id !== id) throw new ReviewError(`${source.path} no longer carries id ${id}`);
    unlinkSafe(resolveInVault(env.vaultPath, source.path));
    refreshIndex(env.index);
    return { outcome: 'recovered', id, from: source.path, to: done[0].path };
  }
  if (others.length > 0) {
    throw new ReviewError(`id ${id} is also used by ${others.map((r) => r.path).join(', ')}; resolve the duplicate by hand`);
  }

  const keptId = idToKeep(source);
  const now = (env.now ?? (() => new Date()))();
  const rewritten = setFrontmatter(text, { id: keptId, status: spec.status, [spec.stampKey]: isoSeconds(now), ...spec.extra }, { schema: 1 });
  const dest = spec.destination();
  const to = createInFolder(env.vaultPath, dest.rel, dest.dir, destinationStem(source.path, spec.keepStamp), rewritten);
  env.afterDestinationWrite?.();
  unlinkSafe(resolveInVault(env.vaultPath, source.path));
  refreshIndex(env.index);
  return { outcome: 'moved', id: keptId, from: source.path, to };
}

/** `ebrain inbox accept <id> [--to <folder>]`. */
export function acceptProposal(env: ReviewEnv, id: string, opts: { to?: string } = {}): MoveResult {
  // Refuse a bad --to before anything else, even when there is nothing to move.
  resolveDestination(env.vaultPath, opts.to ?? DEFAULT_ACCEPT_FOLDER, { create: false });
  return moveProposal(env, id, {
    isDone: (r) => (r.folder_class === 'curated' || r.folder_class === 'reference') && r.status === 'accepted',
    status: 'accepted',
    stampKey: 'accepted',
    extra: {},
    destination: () => resolveDestination(env.vaultPath, opts.to ?? DEFAULT_ACCEPT_FOLDER),
    keepStamp: false,
  });
}

/** `ebrain inbox reject <id> [--reason <text>]`. */
export function rejectProposal(env: ReviewEnv, id: string, opts: { reason?: string } = {}): MoveResult {
  const extra: Record<string, unknown> = {};
  if (opts.reason !== undefined) {
    const reason = opts.reason.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, MAX_REASON_CHARS);
    if (reason !== '') extra['rejected_reason'] = reason;
  }
  return moveProposal(env, id, {
    isDone: (r) => r.folder_class === 'inbox' && r.folder_hidden === 1 && r.path.startsWith(`${REJECTED_DIR}/`) && r.status === 'rejected',
    status: 'rejected',
    stampKey: 'rejected',
    extra,
    destination: () => {
      inboxDir(env.vaultPath);
      const dir = resolveInVault(env.vaultPath, REJECTED_DIR);
      const st = statSafe(dir);
      if (st === undefined) mkdirSafe(dir);
      else if (st.isSymbolicLink() || !st.isDirectory()) throw new ReviewError(`${REJECTED_DIR}/ must be a real directory`);
      return { rel: REJECTED_DIR, dir };
    },
    keepStamp: true,
  });
}
