// Phase 4: the shared cross-process lock (src/lock.ts), exercised with real
// child processes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireLock, LockError, STALE_LOCK_MS, withLock } from '../src/lock.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { mode, realTmpDir, rmrf } from './helpers.js';

const run = promisify(execFile);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lock-worker.js');

function stateDir() {
  const base = realTmpDir();
  return { base, state: ensurePrivateDir(path.join(base, 'state')) };
}

describe('lock', () => {
  it('serializes two processes (no lost updates)', async () => {
    const { base, state } = stateDir();
    try {
      const counter = path.join(base, 'counter');
      fs.writeFileSync(counter, '0');
      const rounds = 60;
      await Promise.all([1, 2].map(() => run(process.execPath, [WORKER, 'count', state, counter, String(rounds)])));
      assert.equal(fs.readFileSync(counter, 'utf8'), String(rounds * 2));
      assert.deepEqual(fs.readdirSync(path.join(state, 'locks')), [], 'locks released');
    } finally {
      rmrf(base);
    }
  });

  it('a lock held by another process times out after the bounded wait, then frees on release', async () => {
    const { base, state } = stateDir();
    try {
      const holder = spawn(process.execPath, [WORKER, 'hold', state, '1500'], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
      const start = Date.now();
      assert.throws(() => acquireLock(state, 'test', { waitMs: 200 }), (e) => e instanceof LockError && e.code === 'timeout');
      assert.ok(Date.now() - start >= 190, 'waited');
      const lockFile = path.join(state, 'locks', 'test.lock');
      const content = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; ts: number };
      assert.equal(content.pid, holder.pid);
      assert.equal(typeof content.ts, 'number');
      assert.equal(mode(lockFile), 0o600);
      assert.equal(mode(path.join(state, 'locks')), 0o700);
      // A waiter whose bound covers the hold gets the lock.
      const h = acquireLock(state, 'test', { waitMs: 10_000 });
      h.release();
      await new Promise((resolve) => holder.once('exit', resolve));
    } finally {
      rmrf(base);
    }
  });

  it(`recovers a lock abandoned for more than ${STALE_LOCK_MS / 1000} s`, async () => {
    const { base, state } = stateDir();
    try {
      fs.mkdirSync(path.join(state, 'locks'), { mode: 0o700 });
      const lockFile = path.join(state, 'locks', 'test.lock');
      const fresh = { pid: 999999, ts: Date.now(), token: 'other' };
      fs.writeFileSync(lockFile, JSON.stringify(fresh), { mode: 0o600 });
      const out1 = await run(process.execPath, [WORKER, 'try', state, '100']);
      assert.equal(out1.stdout.trim(), 'timeout', 'a fresh lock is respected');
      fs.writeFileSync(lockFile, JSON.stringify({ ...fresh, ts: Date.now() - STALE_LOCK_MS - 1000 }));
      const out2 = await run(process.execPath, [WORKER, 'try', state, '100']);
      assert.equal(out2.stdout.trim(), 'acquired', 'a stale lock is broken');
      assert.deepEqual(fs.readdirSync(path.join(state, 'locks')), []);
    } finally {
      rmrf(base);
    }
  });

  it('many processes racing to break one stale lock: exactly one holder at a time', async () => {
    const { base, state } = stateDir();
    try {
      fs.mkdirSync(path.join(state, 'locks'), { mode: 0o700 });
      fs.writeFileSync(path.join(state, 'locks', 'test.lock'), JSON.stringify({ pid: 999999, ts: 0, token: 'dead' }), { mode: 0o600 });
      const counter = path.join(base, 'counter');
      fs.writeFileSync(counter, '0');
      await Promise.all([1, 2, 3, 4].map(() => run(process.execPath, [WORKER, 'count', state, counter, '20'])));
      assert.equal(fs.readFileSync(counter, 'utf8'), '80');
      assert.deepEqual(fs.readdirSync(path.join(state, 'locks')), []);
    } finally {
      rmrf(base);
    }
  });

  it('unparseable lock content is aged from first sight; future timestamps count as stale', () => {
    const { base, state } = stateDir();
    try {
      fs.mkdirSync(path.join(state, 'locks'), { mode: 0o700 });
      const lockFile = path.join(state, 'locks', 'test.lock');
      fs.writeFileSync(lockFile, 'garbage');
      let clock = 1_000_000;
      const now = () => (clock += 20);
      assert.throws(() => acquireLock(state, 'test', { waitMs: 100, staleMs: 1000, now }), LockError);
      acquireLock(state, 'test', { waitMs: 5000, staleMs: 1000, now }).release();
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, ts: Date.now() + 10 * STALE_LOCK_MS, token: 'x' }));
      acquireLock(state, 'test', { waitMs: 0 }).release();
    } finally {
      rmrf(base);
    }
  });

  it('release never removes a lock someone else now holds; withLock releases on throw', () => {
    const { base, state } = stateDir();
    try {
      const h = acquireLock(state, 'test');
      const lockFile = path.join(state, 'locks', 'test.lock');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, ts: Date.now(), token: 'someone-else' }));
      h.release();
      assert.ok(fs.existsSync(lockFile));
      fs.unlinkSync(lockFile);
      assert.throws(() => withLock(state, 'test', () => { throw new Error('boom'); }), /boom/);
      assert.equal(withLock(state, 'test', () => 42, { waitMs: 0 }), 42);
    } finally {
      rmrf(base);
    }
  });

  it('rejects unsafe lock names', () => {
    const { base, state } = stateDir();
    try {
      for (const name of ['', '../x', 'a/b', 'A', '.hidden', '_x', 'x'.repeat(81)]) {
        assert.throws(() => acquireLock(state, name), (e) => e instanceof LockError && e.code === 'invalid', name);
      }
      // journal-<principal-id> (Phase 9): the longest principal id with underscores fits.
      withLock(state, `journal-${'a_'.repeat(32)}`, () => undefined, { waitMs: 0 });
    } finally {
      rmrf(base);
    }
  });
});
