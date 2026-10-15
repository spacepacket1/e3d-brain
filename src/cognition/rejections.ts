// Rejection memory (cognition Phase 2, G10): `<stateDir>/rejections.json`
// maps each rejected `proposal_key` to when and what was rejected (no
// reasons or text; the reason stays on the rejected proposal note). Jobs skip
// proposals whose key is here unless the owner passes `--reconsider`.
// Read-modify-write happens under the `rejections` lock (`src/lock.ts`).

import { withLock } from '../lock.js';
import { readFileSafe, resolveInState, statSafe, writeAtomic, type SafePath } from '../safe-path.js';
import { PROPOSAL_KEY_RE } from '../review/proposal.js';

export const REJECTIONS_FILE = 'rejections.json';
export const REJECTIONS_LOCK = 'rejections';

export interface RejectionEntry {
  rejected: string;
  job: string;
  proposal_type: string;
  proposal_id: string;
}

interface RejectionsFile {
  version: 1;
  rejected: Record<string, RejectionEntry>;
}

function read(stateDir: SafePath): RejectionsFile {
  const file = resolveInState(stateDir, REJECTIONS_FILE);
  if (statSafe(file) === undefined) return { version: 1, rejected: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSafe(file, 'utf8'));
  } catch {
    throw new Error(`${REJECTIONS_FILE} is not valid JSON; fix or remove it`);
  }
  const rejected = (raw as { rejected?: unknown } | null)?.rejected;
  if (typeof rejected !== 'object' || rejected === null || Array.isArray(rejected)) throw new Error(`${REJECTIONS_FILE} is malformed`);
  const out: Record<string, RejectionEntry> = {};
  for (const [k, v] of Object.entries(rejected)) if (PROPOSAL_KEY_RE.test(k)) out[k] = v as RejectionEntry;
  return { version: 1, rejected: out };
}

/** Every rejected proposal key. */
export function rejectedKeys(stateDir: SafePath): Set<string> {
  return new Set(Object.keys(read(stateDir).rejected));
}

/** Record a rejected key (idempotent; the first rejection's entry is kept). */
export function recordRejection(stateDir: SafePath, key: string, entry: RejectionEntry): void {
  if (!PROPOSAL_KEY_RE.test(key)) throw new Error('not a proposal key');
  withLock(stateDir, REJECTIONS_LOCK, () => {
    const f = read(stateDir);
    if (f.rejected[key] !== undefined) return;
    f.rejected[key] = entry;
    writeAtomic(resolveInState(stateDir, REJECTIONS_FILE), `${JSON.stringify(f, null, 2)}\n`);
  });
}
