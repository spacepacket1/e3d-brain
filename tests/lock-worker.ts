// Child process for the lock test (not a test file itself).
//   node lock-worker.js count <stateDir> <counterFile> <rounds>
//     Increments a counter file non-atomically (read, pause, write) under the
//     lock `rounds` times; lost updates would show the lock failed.
//   node lock-worker.js hold <stateDir> <ms>
//     Takes the lock, prints "held", holds it for ms, releases, exits.
//   node lock-worker.js try <stateDir> <waitMs>
//     Prints "acquired" or "timeout".

import * as fs from 'node:fs';
import { acquireLock, LockError, withLock } from '../src/lock.js';
import { resolveInState } from '../src/safe-path.js';

const [role, stateDirRaw, a, b] = process.argv.slice(2);
const stateDir = resolveInState(stateDirRaw!, '');
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (role === 'count') {
  for (let i = 0; i < Number(b); i++) {
    withLock(stateDir, 'test', () => {
      const n = Number(fs.readFileSync(a!, 'utf8'));
      pause(1);
      fs.writeFileSync(a!, String(n + 1));
    }, { waitMs: 30_000 });
  }
} else if (role === 'hold') {
  const h = acquireLock(stateDir, 'test');
  process.stdout.write('held\n');
  pause(Number(a));
  h.release();
} else if (role === 'try') {
  try {
    acquireLock(stateDir, 'test', { waitMs: Number(a) }).release();
    process.stdout.write('acquired\n');
  } catch (err) {
    if (!(err instanceof LockError) || err.code !== 'timeout') throw err;
    process.stdout.write('timeout\n');
  }
}
