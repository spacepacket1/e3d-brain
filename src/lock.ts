// The one cross-process lock (Phase 4). Audit segment rotation (Phase 5) and
// journal writes (Phase 9) use it; nothing else implements locking.
//
// A lock is a file `<stateDir>/locks/<name>.lock` created with O_EXCL and
// holding `{pid, ts, token}`. Waiters poll with a bounded wait. A lock older
// than STALE_LOCK_MS (its holder crashed) is broken: the breaker first takes
// a second O_EXCL file, `<name>.lock.break`, re-reads the lock, and removes it
// only if it is still the same stale lock, so two waiters can never both
// break it and one remove the other's fresh lock. Release removes the file
// only while it still holds this holder's token.
//
// The API is synchronous: callers hold the lock for a few filesystem
// operations, and the wait sleeps the thread with Atomics.wait.

import { randomBytes } from 'node:crypto';
import {
  createExclusive,
  mkdirSafe,
  readFileSafe,
  resolveInState,
  SafePathError,
  unlinkSafe,
  type SafePath,
} from './safe-path.js';

export const LOCKS_DIR = 'locks';
export const STALE_LOCK_MS = 60_000;
export const DEFAULT_LOCK_WAIT_MS = 10_000;
const POLL_MS = 10;
const LOCK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class LockError extends Error {
  constructor(
    readonly code: 'timeout' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'LockError';
  }
}

export interface LockOptions {
  /** Longest time to wait for the lock (default 10 s). 0 tries once. */
  waitMs?: number;
  /** Age after which a lock is treated as abandoned (default 60 s; tests lower it). */
  staleMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

interface LockContent {
  pid: number;
  ts: number;
  token: string;
}

export interface LockHandle {
  readonly name: string;
  readonly path: SafePath;
  readonly token: string;
  release(): void;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function lockPaths(stateDir: SafePath, name: string): { dir: SafePath; lock: SafePath; breaker: SafePath } {
  if (!LOCK_NAME_RE.test(name)) throw new LockError('invalid', 'lock name must be lowercase letters, digits, and dashes');
  const dir = resolveInState(stateDir, LOCKS_DIR);
  return {
    dir,
    lock: resolveInState(stateDir, `${LOCKS_DIR}/${name}.lock`),
    breaker: resolveInState(stateDir, `${LOCKS_DIR}/${name}.lock.break`),
  };
}

/** Create `p` exclusively; false when it already exists. */
function tryCreate(p: SafePath, content: LockContent): boolean {
  try {
    createExclusive(p, `${JSON.stringify(content)}\n`, { strategy: 'excl' });
    return true;
  } catch (err) {
    if (err instanceof SafePathError && err.code === 'exists') return false;
    throw err;
  }
}

/**
 * The raw text of a lock file, or undefined when it is gone. A partially
 * written or unparseable file is returned as text and judged by `parse`.
 */
function readRaw(p: SafePath): string | undefined {
  try {
    return readFileSafe(p, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw err;
  }
}

function parse(raw: string): LockContent | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockContent>;
    if (typeof v.pid === 'number' && typeof v.ts === 'number' && typeof v.token === 'string') return v as LockContent;
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Remove the lock at `lock` if it still has the stale content `seen`. A lock
 * whose content cannot be parsed is aged by the first sighting (the holder
 * may still be writing it), tracked by the caller in `seenAt`.
 */
function breakStale(paths: { lock: SafePath; breaker: SafePath }, seen: string, now: number, staleMs: number): void {
  const mine: LockContent = { pid: process.pid, ts: now, token: randomBytes(12).toString('hex') };
  if (!tryCreate(paths.breaker, mine)) {
    // Another waiter is breaking it. A breaker left by a crash is itself stale.
    const raw = readRaw(paths.breaker);
    const other = raw === undefined ? undefined : parse(raw);
    if (other !== undefined && now - other.ts > staleMs) unlinkSafe(paths.breaker);
    return;
  }
  try {
    if (readRaw(paths.lock) === seen) unlinkSafe(paths.lock);
  } finally {
    if (readRaw(paths.breaker) === `${JSON.stringify(mine)}\n`) unlinkSafe(paths.breaker);
  }
}

/** Acquire the named lock or throw LockError('timeout'). */
export function acquireLock(stateDir: SafePath, name: string, opts: LockOptions = {}): LockHandle {
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const paths = lockPaths(stateDir, name);
  mkdirSafe(paths.dir);
  const token = randomBytes(12).toString('hex');
  const deadline = now() + waitMs;
  // Unparseable content (a holder mid-write, or garbage) is aged from when it was first seen.
  let unparsed: { raw: string; since: number } | undefined;
  for (;;) {
    const t = now();
    if (tryCreate(paths.lock, { pid: process.pid, ts: t, token })) {
      return {
        name,
        path: paths.lock,
        token,
        release: () => {
          const raw = readRaw(paths.lock);
          if (raw !== undefined && parse(raw)?.token === token) unlinkSafe(paths.lock);
        },
      };
    }
    const raw = readRaw(paths.lock);
    if (raw !== undefined) {
      const held = parse(raw);
      let age: number;
      if (held !== undefined) {
        unparsed = undefined;
        age = t - held.ts;
      } else {
        if (unparsed?.raw !== raw) unparsed = { raw, since: t };
        age = t - unparsed.since;
      }
      // A timestamp far in the future (clock change) is as untrustworthy as an old one.
      if (Math.abs(age) > staleMs) {
        breakStale(paths, raw, t, staleMs);
        continue;
      }
    }
    if (t >= deadline) throw new LockError('timeout', `timed out waiting for lock "${name}"`);
    sleep(Math.min(POLL_MS, Math.max(1, deadline - t)));
  }
}

/** Run `fn` while holding the named lock; the lock is released even if `fn` throws. */
export function withLock<T>(stateDir: SafePath, name: string, fn: () => T, opts: LockOptions = {}): T {
  const handle = acquireLock(stateDir, name, opts);
  try {
    return fn();
  } finally {
    handle.release();
  }
}
