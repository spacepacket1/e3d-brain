// Child process for the journal race test (not a test file itself).
//   node journal-worker.js append <vault> <stateDir> <gateFile> <body>
//     Waits for <gateFile> to appear (so two workers start together), then
//     appends an entry named 20261014-120000-same.md and prints "ok" or the
//     refusal code.

import * as fs from 'node:fs';
import { DEFAULT_JOURNAL } from '../src/config.js';
import { toSlug } from '../src/inbox/note.js';
import { appendEntry, JournalRefusedError } from '../src/journal/store.js';
import { resolveInState } from '../src/safe-path.js';

const [role, vault, stateDirRaw, gate, body] = process.argv.slice(2);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (role === 'append') {
  const stateDir = resolveInState(stateDirRaw!, '');
  while (!fs.existsSync(gate!)) pause(2);
  try {
    appendEntry(
      { vaultPath: vault!, stateDir, limits: { ...DEFAULT_JOURNAL } },
      {
        principalId: 'racer', slug: toSlug('same'), when: new Date('2026-10-14T12:00:00Z'),
        text: `---\nstatus: journal\n---\n# same\n\n${body}\n`, body: body!, submittedChars: body!.length,
      },
    );
    process.stdout.write('ok\n');
  } catch (err) {
    if (!(err instanceof JournalRefusedError)) throw err;
    process.stdout.write(`${err.code}\n`);
  }
}
