// The recall record (cognition Phase 1): `<stateDir>/recalls.jsonl`, one
// line per read tool call, `{recall_id, ts, principal, ids: [{id, rev}]}`,
// appended from `dispatch` next to the audit line. Unlike the audit
// `returned` list (which may be truncated to fit the audit line cap), a
// record keeps up to MAX_RECALL_IDS ids in result order; `forget` and
// `report_use` read this file, never the audit list. Ids and revisions only,
// never note text or query text. The file is 0600 in the state directory.
//
// Appends and the owner-run prune (`ebrain recalls prune`, keeping
// `recallLog.retentionDays`) both hold the `recalls` lock, so a prune never
// drops a record appended while it rewrites the file.

import { withLock } from '../lock.js';
import { appendSafe, readFileSafe, resolveInState, statSafe, writeAtomic, type SafePath } from '../safe-path.js';

export const RECALLS_FILE = 'recalls.jsonl';
export const RECALLS_LOCK = 'recalls';
/** Most `{id, rev}` pairs kept per record (the first ones, in result order). */
export const MAX_RECALL_IDS = 500;

const TOKEN_RE = /^[A-Za-z0-9_]{1,128}$/;
const DAY_MS = 86_400_000;

export interface RecallRecord {
  recall_id: string;
  ts: string;
  principal: string;
  ids: { id: string; rev: string }[];
}

export interface RecallLogOptions {
  now?: () => Date;
  lockWaitMs?: number;
}

function recallsPath(stateDir: SafePath): SafePath {
  return resolveInState(stateDir, RECALLS_FILE);
}

/** Build the record for one call: ids filtered to plain tokens, deduplicated, capped. */
export function recallRecord(
  input: { recall_id: string; principal: string; ids: readonly { id: string; rev: string }[] },
  now: Date,
): RecallRecord {
  const ids: { id: string; rev: string }[] = [];
  const seen = new Set<string>();
  for (const r of input.ids) {
    if (ids.length >= MAX_RECALL_IDS) break;
    if (!TOKEN_RE.test(r.id) || !TOKEN_RE.test(r.rev) || seen.has(`${r.id}@${r.rev}`)) continue;
    seen.add(`${r.id}@${r.rev}`);
    ids.push({ id: r.id, rev: r.rev });
  }
  return { recall_id: input.recall_id, ts: now.toISOString(), principal: input.principal, ids };
}

/** Appends recall records for one server process. */
export class RecallLog {
  readonly stateDir: SafePath;
  private readonly now: () => Date;
  private readonly lockWaitMs: number | undefined;

  constructor(stateDir: SafePath, opts: RecallLogOptions = {}) {
    this.stateDir = stateDir;
    this.now = opts.now ?? (() => new Date());
    this.lockWaitMs = opts.lockWaitMs;
  }

  append(input: { recall_id: string; principal: string; ids: readonly { id: string; rev: string }[] }): RecallRecord {
    if (!TOKEN_RE.test(input.recall_id)) throw new Error('recall_id must be a plain token');
    const record = recallRecord(input, this.now());
    const line = `${JSON.stringify(record)}\n`;
    withLock(this.stateDir, RECALLS_LOCK, () => appendSafe(recallsPath(this.stateDir), line), this.lockWaitMs === undefined ? {} : { waitMs: this.lockWaitMs });
    return record;
  }
}

function parseRecord(line: string): RecallRecord | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r['recall_id'] !== 'string' || typeof r['ts'] !== 'string' || typeof r['principal'] !== 'string' || !Array.isArray(r['ids'])) return undefined;
  if (Number.isNaN(Date.parse(r['ts']))) return undefined;
  const ids = (r['ids'] as unknown[]).filter(
    (x): x is { id: string; rev: string } =>
      typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string' && typeof (x as { rev?: unknown }).rev === 'string',
  );
  return { recall_id: r['recall_id'], ts: r['ts'], principal: r['principal'], ids: ids.map((x) => ({ id: x.id, rev: x.rev })) };
}

function readLines(stateDir: SafePath): string[] {
  const file = recallsPath(stateDir);
  if (statSafe(file) === undefined) return [];
  return readFileSafe(file, 'utf8').split('\n').filter((l) => l !== '');
}

/** Every well-formed record, oldest first. Malformed lines are skipped. */
export function readRecalls(stateDir: SafePath): RecallRecord[] {
  return readLines(stateDir).map(parseRecord).filter((r): r is RecallRecord => r !== undefined);
}

export interface RecallPruneResult {
  kept: number;
  removed: number;
}

/** Drop records older than `retentionDays` (and malformed lines). Owner CLI only. */
export function pruneRecalls(stateDir: SafePath, retentionDays: number, now: Date = new Date()): RecallPruneResult {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retentionDays must be a positive integer');
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  return withLock(stateDir, RECALLS_LOCK, () => {
    const lines = readLines(stateDir);
    const kept = lines.filter((l) => {
      const r = parseRecord(l);
      return r !== undefined && Date.parse(r.ts) >= cutoff;
    });
    if (kept.length !== lines.length) writeAtomic(recallsPath(stateDir), kept.map((l) => `${l}\n`).join(''));
    return { kept: kept.length, removed: lines.length - kept.length };
  });
}
