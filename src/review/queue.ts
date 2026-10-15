// The review queue for typed proposals (cognition Phase 2, G6, G20, C9):
// `ebrain review list|show|diff|accept|edit|reject|undo|recover`. Owner CLI
// only: no MCP tool reaches this module (a scan test keeps src/mcp/ from
// importing it).
//
// accept (C9), under the Phase 1 undo store's `apply` lock:
//   1. validate: the proposal parses, is `proposed`, and is authenticated
//      (its id and immutable digest appear in a run record under
//      `<stateDir>/runs/`; frontmatter claims are never trusted on their
//      own); every target still has the pinned `rev` and every cited note
//      revision is current, else the proposal is marked `stale` and refused;
//   2-4. `runOperation` saves the originals, writes the `pending` manifest,
//      re-checks each file's raw SHA-256 immediately before publishing, and
//      marks it `committed` (command `review accept <id>`);
//   5. only then the proposal is finalized: `status: accepted`, `applied`,
//      moved to `_inbox/_applied/`.
// A crash before step 5 leaves a committed operation and an open proposal;
// the next accept or `review recover` finishes step 5. A crash inside the
// operation leaves a `pending` manifest that the next apply rolls back.
//
// undo restores the operation (refusing if any file changed since apply)
// and returns the proposal to `_inbox/` as `proposed` (marked `undone`).
// Proposal files themselves are rewritten outside the undo store, like the
// memory-layer `inbox accept/reject` (they are notes the job proposed).

import * as path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { checkNoteCitation, parseCitation } from '../cite/citation.js';
import { findProposalRun, type RunRecord } from '../cognition/runs.js';
import { recordRejection } from '../cognition/rejections.js';
import { openInEditor } from '../exec/editor.js';
import { rejectProposal, ReviewError } from '../inbox/review.js';
import { isoSeconds } from '../inbox/note.js';
import { INBOX_DIR, inboxDir, MAX_NAME_ATTEMPTS } from '../inbox/writer.js';
import { noteIdentityById, noteLookup } from '../index/identity.js';
import { MAX_NOTE_BYTES, refreshIndex, type IndexHandle } from '../index/indexer.js';
import { allNoteRows, reviewRowsById, type ReviewRow } from '../index/query.js';
import {
  createExclusive, mkdirSafe, readFileSafe, readFileWithStatSafe, resolveInState, resolveInVault, SafePathError, statSafe, unlinkSafe,
  writeAtomic, type SafePath,
} from '../safe-path.js';
import { listOperations, recoverPending, restore, runOperation, sha256, UndoError, type PlannedOp, type UndoEnv, type UndoManifest } from '../undo/store.js';
import { folderClass } from '../vault/names.js';
import { canonicalJson, decodeNote, revOf, splitFrontmatter } from '../vault/parse.js';
import { archiveDestination, immutableDigest, parseProposal, ProposalError, type ChangeOp, type ParsedProposal } from './proposal.js';

export const APPLIED_DIR = `${INBOX_DIR}/_applied`;
/** Scratch copies for `review edit` (state dir, never the vault). */
export const EDIT_DIR = 'review-edit';
const DIFF_CONTEXT = 3;
const MAX_DIFF_LINES = 400;

export interface ReviewQueueEnv {
  vaultPath: string;
  stateDir: SafePath;
  index: IndexHandle;
  now?: () => Date;
  /** Environment for `$VISUAL`/`$EDITOR` (review edit). */
  editorEnv?: NodeJS.ProcessEnv;
  /** Test hook passed to the undo store (called after each op is published). */
  afterPublish?: (index: number) => void;
  /** Test hook: runs after the operation commits and before the proposal is finalized (throw to simulate a crash). */
  afterCommit?: () => void;
}

const now = (env: ReviewQueueEnv): Date => (env.now ?? (() => new Date()))();
const undoEnv = (env: ReviewQueueEnv): UndoEnv => ({
  vaultPath: env.vaultPath, stateDir: env.stateDir, ...(env.now === undefined ? {} : { now: env.now }),
  ...(env.afterPublish === undefined ? {} : { afterPublish: env.afterPublish }),
});
const acceptCommand = (id: string): string => `review accept ${id.toLowerCase()}`;

// ---- locating and reading proposals ----

function isOpen(r: Pick<ReviewRow, 'folder_class' | 'folder_hidden'>): boolean {
  return r.folder_class === 'inbox' && r.folder_hidden === 0;
}

function isApplied(r: ReviewRow): boolean {
  return r.folder_class === 'inbox' && r.path.startsWith(`${APPLIED_DIR}/`);
}

function rowsFor(env: ReviewQueueEnv, id: string): ReviewRow[] {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new ReviewError('a proposal id is a 26-character ULID');
  refreshIndex(env.index);
  return reviewRowsById(env.index.db, id).filter((r) => r.fm_id === id);
}

interface Loaded {
  path: string;
  raw: Buffer;
  text: string;
}

function readVault(env: ReviewQueueEnv, rel: string): Loaded {
  const raw = readFileWithStatSafe(resolveInVault(env.vaultPath, rel), { maxBytes: MAX_NOTE_BYTES }).data;
  return { path: rel, raw, text: decodeNote(raw).text };
}

function openProposal(env: ReviewQueueEnv, id: string): Loaded {
  const open = rowsFor(env, id).filter(isOpen);
  if (open.length > 1) throw new ReviewError(`id ${id} is shared by several open proposals: ${open.map((r) => r.path).join(', ')}`);
  if (open[0] === undefined) throw new ReviewError(`no open proposal in ${INBOX_DIR}/ with id ${id}`);
  return readVault(env, open[0].path);
}

function parse(l: Loaded): ParsedProposal {
  try {
    return parseProposal(l.text);
  } catch (err) {
    if (err instanceof ProposalError) throw new ReviewError(`${l.path} is not a valid typed proposal: ${err.message}`);
    throw err;
  }
}

export type AuthResult = { ok: true; run: RunRecord } | { ok: false; reason: string };

/** Authenticate a proposal against the run records (never its frontmatter claims). */
export function authenticate(env: Pick<ReviewQueueEnv, 'stateDir'>, p: ParsedProposal): AuthResult {
  const found = findProposalRun(env.stateDir, p.meta.id);
  if (found === undefined) return { ok: false, reason: 'not written by a recorded cognition run (no run record lists this id)' };
  if (found.run.job !== p.meta.job) return { ok: false, reason: `the run record is for job ${found.run.job}, not ${p.meta.job}` };
  if (found.entry.digest !== immutableDigest(p.meta, p.ops)) {
    return { ok: false, reason: 'immutable fields (targets, evidence, proposal_key, proposal_type, job, or op targets) differ from the run record; reject it and re-run the job' };
  }
  return { ok: true, run: found.run };
}

// ---- frontmatter and text edits ----

/** Set and remove frontmatter keys, keeping every other key, its order, and the body. */
export function editFrontmatter(text: string, set: Readonly<Record<string, unknown>>, remove: readonly string[] = []): string {
  const split = splitFrontmatter(text);
  if (split.unclosed) throw new ReviewError('the note has an unclosed frontmatter block; fix it by hand first');
  const doc = parseDocument(split.yaml ?? '', { schema: 'core', prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) throw new ReviewError('the note has malformed frontmatter; fix it by hand first');
  const contents: unknown = doc.toJS({ maxAliasCount: 100 });
  if (contents !== null && contents !== undefined && (typeof contents !== 'object' || Array.isArray(contents))) {
    throw new ReviewError('the note frontmatter is not a mapping; fix it by hand first');
  }
  for (const k of remove) doc.delete(k);
  for (const [k, v] of Object.entries(set)) doc.set(k, v);
  const yaml = doc.toString({ lineWidth: 0 });
  return `---\n${yaml.endsWith('\n') ? yaml : `${yaml}\n`}---\n${split.body}`;
}

/**
 * Set one top-level frontmatter key with the smallest text change: the key's
 * existing lines are replaced (or one line is appended), every other byte is
 * kept. The result is re-parsed and must equal the old mapping with only that
 * key changed; otherwise the YAML-document edit is used instead.
 */
export function setFrontmatterKey(text: string, key: string, value: unknown): string {
  const all = text.split('\n');
  let close = -1;
  if (/^---[ \t]*$/.test(all[0] ?? '')) {
    for (let i = 1; i < all.length; i++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(all[i]!)) {
        close = i;
        break;
      }
    }
  }
  if (close < 0 || !/^[a-z_]+$/.test(key)) return editFrontmatter(text, { [key]: value });
  const yamlLines = all.slice(1, close);
  const toJs = (yaml: string): unknown => {
    const doc = parseDocument(yaml, { schema: 'core', prettyErrors: false, uniqueKeys: true });
    return doc.errors.length > 0 ? undefined : doc.toJS({ maxAliasCount: 100 });
  };
  const before = toJs(yamlLines.join('\n'));
  if (before !== null && (typeof before !== 'object' || Array.isArray(before))) return editFrontmatter(text, { [key]: value });
  const rendered = stringify({ [key]: value }, { lineWidth: 0 }).replace(/\n$/, '').split('\n');
  const at = yamlLines.findIndex((l) => new RegExp(`^${key}[ \t]*:`).test(l));
  let next: string[];
  if (at < 0) next = [...yamlLines, ...rendered];
  else {
    let end = at + 1;
    while (end < yamlLines.length && (/^[ \t]/.test(yamlLines[end]!) || /^-(?:[ \t]|$)/.test(yamlLines[end]!))) end++;
    next = [...yamlLines.slice(0, at), ...rendered, ...yamlLines.slice(end)];
  }
  const expected = { ...((before ?? {}) as Record<string, unknown>), [key]: value };
  if (canonicalJson(toJs(next.join('\n'))) !== canonicalJson(expected)) return editFrontmatter(text, { [key]: value });
  return [all[0]!, ...next, ...all.slice(close)].join('\n');
}

/** Re-encode edited text the way the original file was written (BOM, CRLF). */
function encodeLike(original: Buffer, text: string): Buffer {
  const bom = original.length >= 3 && original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf;
  const crlf = original.includes('\r\n');
  return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8')]);
}

function applyTextOps(text: string, ops: readonly ChangeOp[]): string {
  let out = text;
  for (const op of ops) {
    if (op.op === 'set_frontmatter') out = setFrontmatterKey(out, op.key, Array.isArray(op.value) ? [...op.value] : op.value);
    else if (op.op === 'append_section') out = `${out.endsWith('\n') || out === '' ? out : `${out}\n`}\n${op.text.replace(/\r\n?/g, '\n').trimEnd()}\n`;
  }
  return out;
}

// ---- planning ----

export interface PlannedChange {
  kind: 'rewrite' | 'move' | 'create';
  path: string;
  from?: string;
  before: string;
  after: string;
}

export interface Plan {
  /** Why the proposal is stale (empty when every target and cited note is current). */
  stale: string[];
  /** Problems that make it inapplicable regardless of freshness (missing target, unsafe target folder, occupied path). */
  blocked: string[];
  changes: PlannedChange[];
  ops: PlannedOp[];
}

function exists(env: ReviewQueueEnv, rel: string): boolean {
  return statSafe(resolveInVault(env.vaultPath, rel)) !== undefined;
}

/** `<dir>/<stem>.md`, else `<stem>-2.md`, `-3`, ... (C10 collision rule). */
function freeName(env: ReviewQueueEnv, rel: string, taken: Set<string>): string {
  const stem = rel.replace(/\.md$/, '');
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const cand = i === 0 ? rel : `${stem}-${i + 1}.md`;
    if (!taken.has(cand) && !exists(env, cand)) return cand;
  }
  throw new ReviewError(`too many files named like ${rel}`);
}

/** Compute the exact change against current note contents. Does not write. */
export function planProposal(env: ReviewQueueEnv, p: ParsedProposal): Plan {
  refreshIndex(env.index);
  const { db } = env.index;
  const plan: Plan = { stale: [], blocked: [], changes: [], ops: [] };
  const lookup = noteLookup(db);
  for (const c of p.meta.evidence) {
    const parsed = parseCitation(c);
    if (parsed.ok && parsed.citation.kind === 'note') {
      const f = checkNoteCitation(parsed.citation, lookup);
      if (f !== 'fresh') plan.stale.push(`evidence ${c} is ${f}`);
    }
  }
  const taken = new Set<string>();
  for (const t of p.meta.targets) {
    const ident = noteIdentityById(db, t.id);
    if (ident === undefined || ident.provisional || ident.id !== t.id) {
      plan.blocked.push(`target ${t.id} (${t.path_at_proposal}) no longer exists`);
      continue;
    }
    const fc = folderClass(ident.path).folderClass;
    if (fc === 'inbox' || fc === 'raw') {
      plan.blocked.push(`target ${t.id} is in ${fc === 'inbox' ? '_inbox/' : '_raw/'}, which proposals never change`);
      continue;
    }
    const cur = readVault(env, ident.path);
    if (decodeNote(cur.raw).invalidUtf8) {
      plan.blocked.push(`target ${ident.path} is not valid UTF-8; fix it by hand first`);
      continue;
    }
    const rev = revOf(cur.text);
    if (rev !== t.rev) plan.stale.push(`target ${t.id} (${ident.path}) changed: rev ${t.rev} -> ${rev}`);
    const mine = p.ops.filter((o) => o.op !== 'create_note' && o.target === t.id);
    if (mine.length === 0) continue;
    let after: string;
    try {
      after = applyTextOps(cur.text, mine);
    } catch (err) {
      if (err instanceof ReviewError) {
        plan.blocked.push(`target ${ident.path}: ${err.message}`);
        continue;
      }
      throw err;
    }
    const data = after === cur.text ? cur.raw : encodeLike(cur.raw, after);
    const move = mine.find((o) => o.op === 'move_note');
    const expectSha256 = sha256(cur.raw);
    if (move !== undefined && move.op === 'move_note') {
      const wanted = move.to === archiveDestination(t.path_at_proposal) ? archiveDestination(ident.path) : move.to;
      const to = freeName(env, wanted, taken);
      taken.add(to);
      plan.ops.push({ type: 'move', from: ident.path, path: to, expectSha256, data });
      plan.changes.push({ kind: 'move', path: to, from: ident.path, before: cur.text, after });
    } else if (after !== cur.text) {
      plan.ops.push({ type: 'rewrite', path: ident.path, data, expectSha256 });
      plan.changes.push({ kind: 'rewrite', path: ident.path, before: cur.text, after });
    }
  }
  for (const op of p.ops) {
    if (op.op !== 'create_note') continue;
    let occupied: boolean;
    try {
      occupied = exists(env, op.path) || taken.has(op.path);
    } catch (err) {
      if (err instanceof SafePathError) {
        plan.blocked.push(`create ${op.path}: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (occupied) {
      plan.blocked.push(`create ${op.path}: a file already exists there`);
      continue;
    }
    taken.add(op.path);
    const content = op.content.replace(/\r\n?/g, '\n');
    plan.ops.push({ type: 'create', path: op.path, data: Buffer.from(content, 'utf8') });
    plan.changes.push({ kind: 'create', path: op.path, before: '', after: content });
  }
  return plan;
}

// ---- rendering ----

function lines(s: string): string[] {
  if (s === '') return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** A minimal unified-style diff: common prefix and suffix trimmed, the changed middle shown with context. */
export function lineDiff(before: string, after: string): string[] {
  const a = lines(before);
  const b = lines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  if (pre === a.length && pre === b.length) return ['  (content unchanged)'];
  const from = Math.max(0, pre - DIFF_CONTEXT);
  const tail = Math.min(suf, DIFF_CONTEXT);
  const out: string[] = [`@@ -${from + 1},${a.length - suf + tail - from} +${from + 1},${b.length - suf + tail - from} @@`];
  for (let i = from; i < pre; i++) out.push(`  ${a[i]}`);
  for (let i = pre; i < a.length - suf; i++) out.push(`- ${a[i]}`);
  for (let i = pre; i < b.length - suf; i++) out.push(`+ ${b[i]}`);
  for (let i = b.length - suf; i < b.length - suf + tail; i++) out.push(`  ${b[i]}`);
  if (out.length > MAX_DIFF_LINES) return [...out.slice(0, MAX_DIFF_LINES), `  ... (${out.length - MAX_DIFF_LINES} more diff lines)`];
  return out;
}

export function renderPlan(plan: Plan): string {
  const out: string[] = [];
  for (const c of plan.changes) {
    if (c.kind === 'create') out.push(`create ${c.path}`);
    else if (c.kind === 'move') out.push(`move ${c.from} -> ${c.path}${c.before === c.after ? '' : ' (with the edits below)'}`);
    else out.push(`edit ${c.path}`);
    if (c.kind !== 'move' || c.before !== c.after) out.push(...lineDiff(c.before, c.after));
    out.push('');
  }
  if (plan.changes.length === 0) out.push('(no file changes)', '');
  return out.join('\n');
}

// ---- list, show, diff ----

export interface QueueItem {
  id: string;
  path: string;
  title: string;
  type: string;
  job: string;
  status: string;
  created: string;
  authenticated: boolean;
  untrusted: boolean;
  invalid?: string;
}

/** Open typed proposals (`kind: proposal` under `_inbox/`), oldest file first. */
export function listQueue(env: ReviewQueueEnv): QueueItem[] {
  refreshIndex(env.index);
  const rows = allNoteRows(env.index.db).filter((r) => isOpen(r) && r.kind === 'proposal').sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows.map((r) => {
    const base = { id: r.id, path: r.path, title: r.title, created: r.created ?? '', type: '-', job: '-', status: r.status ?? '-', authenticated: false, untrusted: false };
    try {
      const p = parseProposal(readVault(env, r.path).text);
      return { ...base, type: p.meta.proposal_type, job: p.meta.job, status: p.meta.status, authenticated: authenticate(env, p).ok, untrusted: p.meta.untrusted_origin };
    } catch (err) {
      if (err instanceof ProposalError) return { ...base, invalid: err.message };
      throw err;
    }
  });
}

/** The proposal with its authentication, freshness, taint banner, and the live diff. */
export function showQueued(env: ReviewQueueEnv, id: string, opts: { diffOnly?: boolean } = {}): string {
  const l = openProposal(env, id);
  const p = parse(l);
  const plan = planProposal(env, p);
  if (opts.diffOnly === true) return renderPlan(plan);
  const auth = authenticate(env, p);
  const out: string[] = [];
  if (p.meta.untrusted_origin) {
    out.push('!!! UNTRUSTED ORIGIN: derived from untrusted sources', `!!! taint sources: ${p.meta.taint_sources.join(', ') || '(none listed)'}`, '');
  }
  out.push(
    `id: ${p.meta.id}`,
    `path: ${l.path}`,
    `type: ${p.meta.proposal_type}   job: ${p.meta.job} v${p.meta.job_version}   status: ${p.meta.status}`,
    `authenticated: ${auth.ok ? `yes (run ${auth.run.run_id})` : `NO: ${auth.reason}`}`,
    `freshness: ${plan.stale.length === 0 ? 'current' : `STALE: ${plan.stale.join('; ')}`}`,
  );
  if (plan.blocked.length > 0) out.push(`blocked: ${plan.blocked.join('; ')}`);
  out.push(`targets: ${p.meta.targets.map((t) => `${t.id}@${t.rev} (${t.path_at_proposal})`).join(', ') || '(none)'}`);
  out.push(`evidence: ${p.meta.evidence.join(', ') || '(none)'}`, '');
  out.push('--- proposal ---', l.text.trimEnd(), '', '--- change against current notes ---', renderPlan(plan));
  return `${out.join('\n')}\n`;
}

// ---- accept ----

export type AcceptResult =
  | { outcome: 'applied' | 'recovered'; id: string; operationId: string; to: string; changes: PlannedChange[] }
  | { outcome: 'already'; id: string; to: string }
  | { outcome: 'stale'; id: string; reasons: string[] };

/**
 * The accept operation that counts for a proposal: a committed one if any
 * (at most one is live: a re-accept needs the previous one undone), else the
 * newest. Operation ids order by time only to the millisecond.
 */
function newestAcceptOp(env: ReviewQueueEnv, id: string): UndoManifest | undefined {
  const mine = listOperations(undoEnv(env)).filter((m) => m.command === acceptCommand(id));
  return mine.find((m) => m.status === 'committed') ?? mine[0];
}

/** Create `<dir>/<name>` exclusively (numeric suffix on collision); returns its path. */
function createIn(env: ReviewQueueEnv, dirRel: string, name: string, text: string): string {
  const dir = resolveInVault(env.vaultPath, dirRel);
  const st = statSafe(dir);
  if (st === undefined) mkdirSafe(dir);
  else if (st.isSymbolicLink() || !st.isDirectory()) throw new ReviewError(`${dirRel}/ must be a real directory`);
  const stem = name.replace(/\.md$/, '');
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const rel = `${dirRel}/${i === 0 ? stem : `${stem}-${i + 1}`}.md`;
    const target = resolveInVault(env.vaultPath, rel);
    if (path.dirname(target) !== dir) throw new SafePathError('escape', 'destination resolves outside its folder');
    try {
      createExclusive(target, text);
      return rel;
    } catch (err) {
      if (err instanceof SafePathError && err.code === 'exists') continue;
      throw err;
    }
  }
  throw new ReviewError(`too many files with this name in ${dirRel}/`);
}

/** Move a proposal file to `dirRel` with edited frontmatter (create the copy, then unlink the source). */
function relocate(env: ReviewQueueEnv, l: Loaded, dirRel: string, text: string): string {
  const to = createIn(env, dirRel, path.posix.basename(l.path), text);
  unlinkSafe(resolveInVault(env.vaultPath, l.path));
  refreshIndex(env.index);
  return to;
}

function finalize(env: ReviewQueueEnv, l: Loaded, operationId: string): string {
  inboxDir(env.vaultPath);
  const text = editFrontmatter(l.text, { status: 'accepted', applied: isoSeconds(now(env)), undo_operation: operationId }, ['undone']);
  return relocate(env, l, APPLIED_DIR, text);
}

function markStale(env: ReviewQueueEnv, l: Loaded): void {
  const current = readVault(env, l.path);
  if (!current.raw.equals(l.raw)) return; // edited meanwhile: leave it alone
  writeAtomic(resolveInVault(env.vaultPath, l.path), editFrontmatter(l.text, { status: 'stale' }));
  refreshIndex(env.index);
}

/** `ebrain review accept <id>` (see the module comment). */
export function acceptQueued(env: ReviewQueueEnv, id: string): AcceptResult {
  const rows = rowsFor(env, id);
  if (!rows.some(isOpen)) {
    const applied = rows.find(isApplied);
    if (applied !== undefined) return { outcome: 'already', id, to: applied.path };
  }
  const l = openProposal(env, id);
  const p = parse(l);
  const prior = newestAcceptOp(env, id);
  if (prior?.status === 'committed') {
    // An earlier accept committed its operation and stopped before finalizing.
    return { outcome: 'recovered', id, operationId: prior.operation_id, to: finalize(env, l, prior.operation_id), changes: [] };
  }
  const auth = authenticate(env, p);
  if (!auth.ok) throw new ReviewError(`refusing to apply proposal ${id}: ${auth.reason}`);
  if (p.meta.status === 'stale') return { outcome: 'stale', id, reasons: ['the proposal is already marked stale; reject it and re-run the job'] };
  if (p.meta.status !== 'proposed') throw new ReviewError(`proposal ${id} has status ${p.meta.status}`);
  const plan = planProposal(env, p);
  if (plan.stale.length > 0) {
    markStale(env, l);
    return { outcome: 'stale', id, reasons: plan.stale };
  }
  if (plan.blocked.length > 0) throw new ReviewError(`cannot apply proposal ${id}: ${plan.blocked.join('; ')}`);
  if (plan.ops.length === 0) {
    // A report (gap) changes nothing: accepting just files it.
    return { outcome: 'applied', id, operationId: '', to: relocate(env, l, APPLIED_DIR, editFrontmatter(l.text, { status: 'accepted', applied: isoSeconds(now(env)) })), changes: [] };
  }
  let m: UndoManifest;
  try {
    m = runOperation(undoEnv(env), acceptCommand(id), plan.ops)!;
  } catch (err) {
    if (err instanceof UndoError && err.code === 'conflict') {
      markStale(env, l);
      return { outcome: 'stale', id, reasons: [err.message] };
    }
    throw err;
  }
  env.afterCommit?.();
  return { outcome: 'applied', id, operationId: m.operation_id, to: finalize(env, l, m.operation_id), changes: plan.changes };
}

// ---- undo ----

export interface UndoResult {
  id: string;
  operationId: string;
  restored: number;
  to: string;
}

/** `ebrain review undo <id>`: restore the originals (refuses if anything changed since apply), reopen the proposal. */
export function undoQueued(env: ReviewQueueEnv, id: string): UndoResult {
  const applied = rowsFor(env, id).filter(isApplied);
  if (applied.length === 0) throw new ReviewError(`no applied proposal with id ${id} in ${APPLIED_DIR}/`);
  if (applied.length > 1) throw new ReviewError(`id ${id} appears more than once in ${APPLIED_DIR}/`);
  const l = readVault(env, applied[0]!.path);
  const op = newestAcceptOp(env, id);
  let restored = 0;
  let operationId = '';
  if (op !== undefined) {
    operationId = op.operation_id;
    if (op.status === 'committed') {
      try {
        restored = restore(undoEnv(env), op.operation_id).ops.length;
      } catch (err) {
        if (err instanceof UndoError && err.code === 'conflict') {
          throw new ReviewError(`cannot undo proposal ${id}: ${err.message}. Revert those edits by hand (or keep them); nothing was changed.`);
        }
        throw err;
      }
    } else if (op.status !== 'rolled_back') throw new ReviewError(`operation ${op.operation_id} is ${op.status}; run ebrain review recover`);
  }
  const text = editFrontmatter(l.text, { status: 'proposed', undone: isoSeconds(now(env)) }, ['applied', 'undo_operation']);
  const to = relocate(env, l, INBOX_DIR, text);
  return { id, operationId, restored, to };
}

// ---- reject ----

/** `ebrain review reject <id> [--reason]`: remember the key in rejections.json, then move to `_inbox/_rejected/`. */
export function rejectQueued(env: ReviewQueueEnv, id: string, reason?: string): { id: string; to: string; key: string } {
  const l = openProposal(env, id);
  const p = parse(l);
  const auth = authenticate(env, p);
  if (!auth.ok) throw new ReviewError(`proposal ${id} is ${auth.reason}; use ebrain inbox reject for ordinary notes`);
  recordRejection(env.stateDir, p.meta.proposal_key, {
    rejected: isoSeconds(now(env)), job: p.meta.job, proposal_type: p.meta.proposal_type, proposal_id: p.meta.id,
  });
  const r = rejectProposal({ vaultPath: env.vaultPath, index: env.index, ...(env.now === undefined ? {} : { now: env.now }) }, id, reason === undefined ? {} : { reason });
  return { id, to: r.to, key: p.meta.proposal_key };
}

// ---- edit ----

/**
 * `ebrain review edit <id>`: edit a copy in `$EDITOR`, re-validate the schema,
 * refuse if any immutable field changed, keep it `proposed`.
 */
export function editQueued(env: ReviewQueueEnv, id: string): { id: string; changed: boolean } {
  const l = openProposal(env, id);
  const p = parse(l);
  if (p.meta.status !== 'proposed') throw new ReviewError(`proposal ${id} has status ${p.meta.status}; only proposed proposals can be edited`);
  const auth = authenticate(env, p);
  if (!auth.ok) throw new ReviewError(`refusing to edit proposal ${id}: ${auth.reason}`);
  const digest = immutableDigest(p.meta, p.ops);
  mkdirSafe(resolveInState(env.stateDir, EDIT_DIR));
  const scratch = resolveInState(env.stateDir, `${EDIT_DIR}/${id}.md`);
  writeAtomic(scratch, l.text);
  try {
    const res = openInEditor(scratch, env.editorEnv ?? process.env);
    if ('error' in res) throw new ReviewError(res.error);
    if (res.status !== 0) throw new ReviewError(`the editor exited ${res.status}; nothing was changed`);
    const edited = decodeNote(readFileSafe(scratch)).text;
    if (edited === l.text) return { id, changed: false };
    let q: ParsedProposal;
    try {
      q = parseProposal(edited);
    } catch (err) {
      if (err instanceof ProposalError) throw new ReviewError(`the edited proposal is invalid (${err.message}); nothing was changed`);
      throw err;
    }
    if (q.meta.status !== 'proposed') throw new ReviewError('the edited proposal must keep status: proposed; nothing was changed');
    if (immutableDigest(q.meta, q.ops) !== digest) {
      throw new ReviewError('targets, evidence, proposal_key, proposal_type, job, id, and op targets are immutable; reject and re-run instead. Nothing was changed');
    }
    if (!readVault(env, l.path).raw.equals(l.raw)) throw new ReviewError(`${l.path} changed while it was being edited; nothing was changed`);
    writeAtomic(resolveInVault(env.vaultPath, l.path), edited);
    refreshIndex(env.index);
    return { id, changed: true };
  } finally {
    if (statSafe(scratch) !== undefined) unlinkSafe(scratch);
  }
}

// ---- recover ----

/** `ebrain review recover`: roll back pending operations, finish accepts that committed but were not finalized. */
export function recoverQueue(env: ReviewQueueEnv): { rolledBack: string[]; finalized: string[] } {
  const ue = undoEnv(env);
  const before = new Set(listOperations(ue).filter((m) => m.status === 'pending').map((m) => m.operation_id));
  // runOperation and restore also recover; an explicit pass reports what it did.
  const rolledBack = before.size === 0 ? [] : recoverPending(ue);
  const finalized: string[] = [];
  refreshIndex(env.index);
  for (const r of allNoteRows(env.index.db).filter((x) => isOpen(x) && x.kind === 'proposal')) {
    if (r.provisional === 1) continue;
    const id = r.id;
    const op = newestAcceptOp(env, id);
    if (op?.status === 'committed') {
      finalize(env, readVault(env, r.path), op.operation_id);
      finalized.push(id);
    }
  }
  return { rolledBack, finalized };
}

export { ReviewError };
