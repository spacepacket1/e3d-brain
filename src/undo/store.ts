// The undo store (cognition Phase 1, C9). Every owner-run command that
// rewrites, creates, or moves vault files does so through one undo
// operation, `<stateDir>/undo/<operation-id>/`:
//
//   manifest.json   {operation_id, created, command, status, ops}
//   done.jsonl      one line per op index once that op is published
//   files/<path>    the original bytes of every `rewrite` op, at its vault-relative path
//
// Everything is mode 0600/0700 in the private state directory, never in the
// vault (so undo data never reaches git or sync, and undo is machine-local).
//
// Protocol (`runOperation`, under the `apply` lock): save the originals and
// write the manifest with status `pending` and every planned op; for each op
// re-check the raw SHA-256 of what it replaces immediately before publishing
// (`writeAtomic` / `createExclusive` / `renameSafe`) and append its index to
// done.jsonl; then mark the manifest `committed`. A crash leaves a `pending`
// manifest; `recoverPending` rolls back every op done.jsonl records.
//
// `restore` reverses a committed operation only when every op's current
// state still has its `sha256_after` (nothing was edited since); a failure
// part-way re-applies what it had reversed, so the vault ends in the
// committed or the rolled-back state. A `create` is undone by removing the
// file the same operation created (the C10 undo exception); nothing else is
// ever removed. All paths go through safe-path (I1); operation ids are ULIDs
// and manifest paths are revalidated on load.

import { createHash } from 'node:crypto';
import { withLock } from '../lock.js';
import { ulid, ULID_RE } from '../mcp/ulid.js';
import {
  appendSafe,
  createExclusive,
  mkdirSafe,
  readDirSafe,
  readFileSafe,
  renameSafe,
  resolveInState,
  resolveInVault,
  SafePathError,
  statSafe,
  unlinkSafe,
  writeAtomic,
  type SafePath,
} from '../safe-path.js';

export const UNDO_DIR = 'undo';
/** The lock every apply, undo, and recovery holds (`<stateDir>/locks/apply.lock`). */
export const APPLY_LOCK = 'apply';
const MANIFEST = 'manifest.json';
const DONE_LOG = 'done.jsonl';
const FILES_DIR = 'files';
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMAND_RE = /^[a-z0-9][a-z0-9 :_-]{0,63}$/;

export type UndoStatus = 'pending' | 'committed' | 'rolled_back';

export type UndoOp =
  | { type: 'rewrite'; path: string; sha256_before: string; sha256_after: string; mode: number }
  | { type: 'create'; path: string; sha256_after: string }
  | { type: 'move'; path: string; from: string; sha256_before: string; sha256_after: string };

export interface UndoManifest {
  operation_id: string;
  created: string;
  /** Owner command that made the operation (`ids assign`, `review accept`, ...). */
  command: string;
  status: UndoStatus;
  ops: UndoOp[];
}

/** What a command asks for; `runOperation` turns it into recorded ops. */
export type PlannedOp =
  | { type: 'rewrite'; path: string; data: Uint8Array; /** Refuse unless the current bytes hash to this. */ expectSha256?: string }
  | { type: 'create'; path: string; data: Uint8Array }
  | { type: 'move'; from: string; path: string; expectSha256?: string };

export interface UndoEnv {
  vaultPath: string;
  stateDir: SafePath;
  now?: () => Date;
  /** Test hook: called after op `index` is published, before it is recorded done. */
  afterPublish?: (index: number) => void;
}

export type UndoErrorCode = 'invalid' | 'not-found' | 'conflict' | 'state';

export class UndoError extends Error {
  readonly code: UndoErrorCode;
  constructor(code: UndoErrorCode, message: string) {
    super(message);
    this.name = 'UndoError';
    this.code = code;
  }
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function fail(code: UndoErrorCode, message: string): never {
  throw new UndoError(code, message);
}

export function isOperationId(id: unknown): id is string {
  return typeof id === 'string' && ULID_RE.test(id);
}

function checkOperationId(id: unknown): string {
  if (!isOperationId(id)) fail('invalid', 'operation id must be a 26-character ULID');
  return id;
}

/** Resolve a vault-relative path from a command or a manifest (I1); SafePathError becomes UndoError('invalid'). */
function vaultFile(env: UndoEnv, rel: unknown): SafePath {
  if (typeof rel !== 'string' || rel === '') fail('invalid', 'op path must be a non-empty vault-relative path');
  try {
    return resolveInVault(env.vaultPath, rel);
  } catch (err) {
    if (err instanceof SafePathError) fail('invalid', `unsafe vault path ${JSON.stringify(rel.slice(0, 200))}: ${err.message}`);
    throw err;
  }
}

function opDir(env: UndoEnv, id: string): SafePath {
  return resolveInState(env.stateDir, `${UNDO_DIR}/${checkOperationId(id)}`);
}

function opFile(env: UndoEnv, id: string, name: string): SafePath {
  return resolveInState(env.stateDir, `${UNDO_DIR}/${checkOperationId(id)}/${name}`);
}

/** Where a rewrite op's original bytes are kept (state dir, same relative path). */
function savedOriginal(env: UndoEnv, id: string, rel: string): SafePath {
  vaultFile(env, rel); // the same name rules as the vault side
  return opFile(env, id, `${FILES_DIR}/${rel}`);
}

function readCurrent(p: SafePath): Buffer | undefined {
  const st = statSafe(p);
  if (st === undefined) return undefined;
  if (!st.isFile()) fail('conflict', 'target exists and is not a regular file');
  return readFileSafe(p);
}

/** Create the missing parent folders of a vault-relative path. */
function ensureParent(env: UndoEnv, rel: string): void {
  const slash = rel.lastIndexOf('/');
  if (slash > 0) mkdirSafe(vaultFile(env, rel.slice(0, slash)));
}

function writeManifest(env: UndoEnv, m: UndoManifest): void {
  writeAtomic(opFile(env, m.operation_id, MANIFEST), `${JSON.stringify(m, null, 2)}\n`);
}

// ---- manifest validation ----

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseOp(env: UndoEnv, raw: unknown): UndoOp {
  if (!isObject(raw)) fail('invalid', 'manifest op is not an object');
  const hash = (k: string): string => {
    const v = raw[k];
    if (typeof v !== 'string' || !SHA256_RE.test(v)) fail('invalid', `manifest op ${k} is not a SHA-256`);
    return v;
  };
  const path = raw['path'];
  vaultFile(env, path);
  switch (raw['type']) {
    case 'rewrite': {
      const mode = raw['mode'];
      if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) fail('invalid', 'manifest op mode is invalid');
      return { type: 'rewrite', path: path as string, sha256_before: hash('sha256_before'), sha256_after: hash('sha256_after'), mode };
    }
    case 'create':
      return { type: 'create', path: path as string, sha256_after: hash('sha256_after') };
    case 'move':
      vaultFile(env, raw['from']);
      return { type: 'move', path: path as string, from: raw['from'] as string, sha256_before: hash('sha256_before'), sha256_after: hash('sha256_after') };
    default:
      fail('invalid', 'manifest op has an unknown type');
  }
}

export function readManifest(env: UndoEnv, id: string): UndoManifest {
  const file = opFile(env, id, MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSafe(file, 'utf8'));
  } catch (err) {
    if (err instanceof SafePathError) fail('invalid', `undo manifest unreadable: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') fail('not-found', `no undo operation ${id}`);
    fail('invalid', 'undo manifest is not valid JSON');
  }
  if (!isObject(raw) || raw['operation_id'] !== id) fail('invalid', 'undo manifest does not match its operation id');
  const status = raw['status'];
  if (status !== 'pending' && status !== 'committed' && status !== 'rolled_back') fail('invalid', 'undo manifest has an unknown status');
  if (typeof raw['created'] !== 'string' || typeof raw['command'] !== 'string' || !Array.isArray(raw['ops'])) {
    fail('invalid', 'undo manifest is malformed');
  }
  return { operation_id: id, created: raw['created'], command: raw['command'], status, ops: raw['ops'].map((o) => parseOp(env, o)) };
}

function readDone(env: UndoEnv, m: UndoManifest): Set<number> {
  const file = opFile(env, m.operation_id, DONE_LOG);
  if (statSafe(file) === undefined) return new Set();
  const done = new Set<number>();
  for (const line of readFileSafe(file, 'utf8').split('\n')) {
    if (!/^[0-9]{1,9}$/.test(line)) continue; // a torn last line means that op was not recorded
    const i = Number(line);
    if (i < m.ops.length) done.add(i);
  }
  return done;
}

// ---- forward and reverse steps ----

// New bytes for rewrite/create ops while their operation runs (never persisted: the vault holds them once done).
const pendingData = new WeakMap<UndoOp, Uint8Array>();

/** Publish one op, re-checking the raw SHA-256 of what it replaces. */
function forward(env: UndoEnv, op: UndoOp): void {
  const target = vaultFile(env, op.path);
  if (op.type === 'rewrite') {
    const current = readCurrent(target);
    if (current === undefined || sha256(current) !== op.sha256_before) fail('conflict', `${op.path} changed before it could be rewritten`);
    writeAtomic(target, pendingData.get(op)!, { mode: op.mode });
  } else if (op.type === 'create') {
    ensureParent(env, op.path);
    createExclusive(target, pendingData.get(op)!);
  } else {
    const source = vaultFile(env, op.from);
    const current = readCurrent(source);
    if (current === undefined || sha256(current) !== op.sha256_before) fail('conflict', `${op.from} changed before it could be moved`);
    ensureParent(env, op.path);
    renameSafe(source, target);
  }
}

/** Undo one published op. */
function reverse(env: UndoEnv, id: string, op: UndoOp): void {
  const target = vaultFile(env, op.path);
  if (op.type === 'rewrite') {
    writeAtomic(target, readFileSafe(savedOriginal(env, id, op.path)), { mode: op.mode });
  } else if (op.type === 'create') {
    unlinkSafe(target);
  } else {
    const source = vaultFile(env, op.from);
    ensureParent(env, op.from);
    renameSafe(target, source);
  }
}

/** Re-publish an op that `restore` had reversed (when a later reversal failed). */
function reapply(env: UndoEnv, op: UndoOp, after: Map<UndoOp, Buffer>): void {
  const target = vaultFile(env, op.path);
  if (op.type === 'rewrite') writeAtomic(target, after.get(op)!, { mode: op.mode });
  else if (op.type === 'create') createExclusive(target, after.get(op)!);
  else renameSafe(vaultFile(env, op.from), target);
}

// ---- public API ----

/**
 * Run `planned` as one undo operation (see the module comment). Throws
 * UndoError('conflict') if any target is not as expected, after rolling back
 * the ops already published. An empty plan creates nothing.
 */
export function runOperation(env: UndoEnv, command: string, planned: readonly PlannedOp[]): UndoManifest | undefined {
  if (!COMMAND_RE.test(command)) fail('invalid', 'command label is invalid');
  if (planned.length === 0) return undefined;
  return withLock(env.stateDir, APPLY_LOCK, () => {
    recoverPendingLocked(env);
    const id = ulid((env.now?.() ?? new Date()).getTime());
    const created = (env.now?.() ?? new Date()).toISOString();
    const seen = new Set<string>();
    const claim = (rel: string) => {
      if (seen.has(rel)) fail('invalid', `${rel} appears in more than one op`);
      seen.add(rel);
    };
    // Validate and snapshot everything before writing anything.
    const ops: UndoOp[] = [];
    const originals: { rel: string; data: Buffer }[] = [];
    for (const p of planned) {
      const target = vaultFile(env, p.path);
      claim(p.path);
      if (p.type === 'rewrite') {
        const current = readCurrent(target);
        if (current === undefined) fail('conflict', `${p.path} does not exist`);
        const before = sha256(current);
        if (p.expectSha256 !== undefined && p.expectSha256 !== before) fail('conflict', `${p.path} changed since it was read`);
        const op: UndoOp = { type: 'rewrite', path: p.path, sha256_before: before, sha256_after: sha256(p.data), mode: statSafe(target)!.mode & 0o777 };
        pendingData.set(op, p.data);
        ops.push(op);
        originals.push({ rel: p.path, data: current });
      } else if (p.type === 'create') {
        if (statSafe(target) !== undefined) fail('conflict', `${p.path} already exists`);
        const op: UndoOp = { type: 'create', path: p.path, sha256_after: sha256(p.data) };
        pendingData.set(op, p.data);
        ops.push(op);
      } else {
        claim(p.from);
        const current = readCurrent(vaultFile(env, p.from));
        if (current === undefined) fail('conflict', `${p.from} does not exist`);
        const before = sha256(current);
        if (p.expectSha256 !== undefined && p.expectSha256 !== before) fail('conflict', `${p.from} changed since it was read`);
        if (statSafe(target) !== undefined) fail('conflict', `${p.path} already exists`);
        ops.push({ type: 'move', path: p.path, from: p.from, sha256_before: before, sha256_after: before });
      }
    }
    mkdirSafe(opDir(env, id));
    for (const o of originals) {
      const slash = o.rel.lastIndexOf('/');
      mkdirSafe(opFile(env, id, slash > 0 ? `${FILES_DIR}/${o.rel.slice(0, slash)}` : FILES_DIR));
      createExclusive(savedOriginal(env, id, o.rel), o.data);
    }
    const manifest: UndoManifest = { operation_id: id, created, command, status: 'pending', ops };
    writeManifest(env, manifest);
    const doneLog = opFile(env, id, DONE_LOG);
    for (let i = 0; i < ops.length; i++) {
      try {
        forward(env, ops[i]!);
        env.afterPublish?.(i);
        appendSafe(doneLog, `${i}\n`);
      } catch (err) {
        // A publish that happened but was not recorded (hook threw) is still rolled back below.
        if (!(err instanceof UndoError) && published(env, ops[i]!)) appendSafe(doneLog, `${i}\n`);
        rollBack(env, readManifest(env, id));
        throw err;
      }
    }
    manifest.status = 'committed';
    writeManifest(env, manifest);
    return manifest;
  });
}

/** Whether op's target now holds its `sha256_after` (it was published). */
function published(env: UndoEnv, op: UndoOp): boolean {
  try {
    const current = readCurrent(vaultFile(env, op.path));
    return current !== undefined && sha256(current) === op.sha256_after && (op.type !== 'move' || statSafe(vaultFile(env, op.from)) === undefined);
  } catch {
    return false;
  }
}

/** Roll back the done ops of a pending operation, newest first, and mark it rolled back. */
function rollBack(env: UndoEnv, m: UndoManifest): void {
  const done = readDone(env, m);
  for (let i = m.ops.length - 1; i >= 0; i--) {
    const op = m.ops[i]!;
    // An op not recorded done may still have been published just before a crash.
    if (done.has(i) || published(env, op)) reverse(env, m.operation_id, op);
  }
  m.status = 'rolled_back';
  writeManifest(env, m);
}

function recoverPendingLocked(env: UndoEnv): string[] {
  const recovered: string[] = [];
  for (const m of listOperations(env)) {
    if (m.status !== 'pending') continue;
    rollBack(env, m);
    recovered.push(m.operation_id);
  }
  return recovered;
}

/** Roll back every operation a crash left `pending`. Returns their ids. */
export function recoverPending(env: UndoEnv): string[] {
  return withLock(env.stateDir, APPLY_LOCK, () => recoverPendingLocked(env));
}

/** Every operation with a readable manifest, newest first. Unreadable entries are skipped. */
export function listOperations(env: UndoEnv): UndoManifest[] {
  const dir = resolveInState(env.stateDir, UNDO_DIR);
  if (statSafe(dir) === undefined) return [];
  const out: UndoManifest[] = [];
  for (const e of readDirSafe(dir)) {
    if (!e.isDirectory() || !isOperationId(e.name)) continue;
    try {
      out.push(readManifest(env, e.name));
    } catch (err) {
      if (!(err instanceof UndoError || err instanceof SafePathError)) throw err;
    }
  }
  return out.sort((a, b) => (a.operation_id < b.operation_id ? 1 : a.operation_id > b.operation_id ? -1 : 0));
}

/**
 * Reverse a committed operation. Refuses (UndoError('conflict'), nothing
 * changed) unless every op's current state equals its `sha256_after`.
 */
export function restore(env: UndoEnv, operationId: string): UndoManifest {
  checkOperationId(operationId);
  return withLock(env.stateDir, APPLY_LOCK, () => {
    recoverPendingLocked(env);
    const m = readManifest(env, operationId);
    if (m.status === 'rolled_back') fail('state', `operation ${operationId} was already undone`);
    if (m.status !== 'committed') fail('state', `operation ${operationId} is ${m.status}`);
    const after = new Map<UndoOp, Buffer>();
    for (const op of m.ops) {
      const current = readCurrent(vaultFile(env, op.path));
      if (current === undefined || sha256(current) !== op.sha256_after) {
        fail('conflict', `${op.path} was ${current === undefined ? 'removed' : 'edited'} after operation ${operationId}; refusing to undo`);
      }
      if (op.type === 'move' && statSafe(vaultFile(env, op.from)) !== undefined) {
        fail('conflict', `${op.from} exists again; refusing to undo operation ${operationId}`);
      }
      if (op.type === 'rewrite') {
        const saved = readFileSafe(savedOriginal(env, operationId, op.path));
        if (sha256(saved) !== op.sha256_before) fail('invalid', `saved original of ${op.path} is damaged`);
      }
      after.set(op, current);
    }
    const reversed: UndoOp[] = [];
    try {
      for (let i = m.ops.length - 1; i >= 0; i--) {
        reverse(env, operationId, m.ops[i]!);
        reversed.push(m.ops[i]!);
      }
    } catch (err) {
      for (const op of reversed.reverse()) reapply(env, op, after);
      throw err;
    }
    m.status = 'rolled_back';
    writeManifest(env, m);
    return m;
  });
}
