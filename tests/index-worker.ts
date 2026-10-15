// Child process for the concurrency test (not a test file itself).
//   node index-worker.js reindex <vault> <stateDir> <minMs>
//   node index-worker.js refresh <vault> <stateDir> <minMs>
//   node index-worker.js query   <vault> <stateDir> <minMs> <expectedNotes>
// Repeats its operation for at least minMs (so concurrent workers overlap),
// then prints one JSON line {ok, rounds, start, end, errors} and exits 0 when
// every round succeeded.

import { closeIndex, openIndex, refreshIndex, reindex } from '../src/index/indexer.js';
import { listNotePaths, matchChunks } from '../src/index/query.js';
import { resolveInState, type SafePath } from '../src/safe-path.js';

const [role, vault, stateDirRaw, minMsRaw, expectedRaw] = process.argv.slice(2);
const stateDir = resolveInState(stateDirRaw!, '') as SafePath;
const minMs = Number(minMsRaw);
const errors: string[] = [];
const h = openIndex({ vaultPath: vault!, stateDir });
const start = Date.now();
let i = 0;
for (; i < 5 || Date.now() - start < minMs; i++) {
  try {
    if (role === 'reindex') reindex(h, { full: true });
    else if (role === 'refresh') refreshIndex(h);
    else {
      const read = h.db.transaction(() => ({ notes: listNotePaths(h.db).length, hits: matchChunks(h.db, 'zebrafinch').length }));
      const r = read();
      if (r.notes !== Number(expectedRaw) || r.hits !== 1) errors.push(`round ${i}: notes ${r.notes} hits ${r.hits}`);
    }
  } catch (err) {
    errors.push(`round ${i}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
closeIndex(h);
process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, rounds: i, start, end: Date.now(), errors: errors.slice(0, 5) })}\n`);
process.exitCode = errors.length === 0 ? 0 : 1;
