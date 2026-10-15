// The usage record (cognition Phase 8, G15): `<stateDir>/usage.jsonl`, one
// line per (recall_id, note_id) a client reported with `report_use`. It is the
// only state write MCP makes outside its mode's vault fence, and it never
// touches the vault. Every event is labeled `self_reported`: an agent's own
// word, which anyone with a tool call can invent. Self-reported events never
// affect ranking; only an event whose `outcome_ref` resolves against local
// evidence is counted as `evidence_linked`, and that is decided at rollup time
// (`usage-rollup.ts`), never here.
//
// `recordUsage` validates against `recalls.jsonl`: the recall must exist and
// belong to the reporting principal, and `note_ids` must be a subset of the ids
// that recall returned. A repeat of an already-recorded (recall_id, note_id)
// is ignored (first report wins); a repeated id inside one call is invalid.
// A call with no `note_ids` records one recall-level event (note_id null) that
// no per-note rollup counts. Reports are rate limited per principal and the
// file is size capped. Everything runs under the `usage` lock.

import { withLock } from '../lock.js';
import { appendSafe, readFileSafe, resolveInState, statSafe, type SafePath } from '../safe-path.js';
import { readRecalls } from './recalls.js';

export const USAGE_FILE = 'usage.jsonl';
export const USAGE_LOCK = 'usage';
/** Most note ids in one `report_use` call. */
export const MAX_USAGE_NOTE_IDS = 25;
/** Largest `usage.jsonl`; past it new reports are refused until the owner trims the file. */
export const MAX_USAGE_FILE_BYTES = 4 * 1024 * 1024;
/** Most events one principal may record per rate window. */
export const USAGE_RATE_LIMIT = 100;
export const USAGE_RATE_WINDOW_MS = 60_000;

export interface UsageEvent {
  ts: string;
  principal: string;
  recall_id: string;
  /** null: a recall-level event (no note ids given). */
  note_id: string | null;
  helpful?: boolean;
  outcome_ref?: string;
  label: 'self_reported';
}

export interface UsageInput {
  recall_id: string;
  note_ids?: readonly string[];
  outcome_ref?: string;
  helpful?: boolean;
}

/** A refusal; `detail` names the problem without echoing input. */
export class UsageError extends Error {
  constructor(readonly type: 'invalid' | 'limit', readonly detail: string, readonly code?: string) {
    super(`${type}: ${detail}`);
    this.name = 'UsageError';
  }
}

export interface UsageOptions {
  now?: () => Date;
  lockWaitMs?: number;
}

function usagePath(stateDir: SafePath): SafePath {
  return resolveInState(stateDir, USAGE_FILE);
}

function parseEvent(line: string): UsageEvent | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r['ts'] !== 'string' || Number.isNaN(Date.parse(r['ts'])) || typeof r['principal'] !== 'string' || typeof r['recall_id'] !== 'string') return undefined;
  if (r['note_id'] !== null && typeof r['note_id'] !== 'string') return undefined;
  const e: UsageEvent = { ts: r['ts'], principal: r['principal'], recall_id: r['recall_id'], note_id: r['note_id'] as string | null, label: 'self_reported' };
  if (typeof r['helpful'] === 'boolean') e.helpful = r['helpful'];
  if (typeof r['outcome_ref'] === 'string') e.outcome_ref = r['outcome_ref'];
  return e;
}

/** Every well-formed event, oldest first. Malformed lines are skipped. */
export function readUsage(stateDir: SafePath): UsageEvent[] {
  const file = usagePath(stateDir);
  if (statSafe(file) === undefined) return [];
  return readFileSafe(file, 'utf8').split('\n').filter((l) => l !== '').map(parseEvent).filter((e): e is UsageEvent => e !== undefined);
}

export interface UsageResult {
  recorded: number;
  ignored_duplicates: number;
}

/** Validate and append the events of one `report_use` call. Throws UsageError on a refusal. */
export function recordUsage(stateDir: SafePath, principal: string, input: UsageInput, opts: UsageOptions = {}): UsageResult {
  const now = (opts.now ?? (() => new Date()))();
  const noteIds = input.note_ids ?? [];
  if (noteIds.length > MAX_USAGE_NOTE_IDS) throw new UsageError('limit', `note_ids has more than ${MAX_USAGE_NOTE_IDS} entries`, 'batch-size');
  if (new Set(noteIds).size !== noteIds.length) throw new UsageError('invalid', 'note_ids lists the same id twice');
  return withLock(stateDir, USAGE_LOCK, () => {
    const recall = readRecalls(stateDir).find((r) => r.recall_id === input.recall_id && r.principal === principal);
    if (recall === undefined) throw new UsageError('invalid', 'unknown recall_id (no such recall for this principal)', 'unknown-recall');
    const returned = new Set(recall.ids.map((x) => x.id));
    if (!noteIds.every((id) => returned.has(id))) throw new UsageError('invalid', 'note_ids must all be ids returned by that recall', 'note-not-in-recall');

    const file = usagePath(stateDir);
    const size = statSafe(file)?.size ?? 0;
    if (size >= MAX_USAGE_FILE_BYTES) throw new UsageError('limit', 'usage log is full', 'usage-log-full');
    const events = readUsage(stateDir);
    const windowStart = now.getTime() - USAGE_RATE_WINDOW_MS;
    const recent = events.filter((e) => e.principal === principal && Date.parse(e.ts) > windowStart).length;
    const seen = new Set(events.filter((e) => e.recall_id === input.recall_id).map((e) => e.note_id));
    const targets: (string | null)[] = noteIds.length === 0 ? [null] : [...noteIds];
    const fresh = targets.filter((t) => !seen.has(t));
    if (recent + fresh.length > USAGE_RATE_LIMIT) throw new UsageError('limit', 'too many usage reports; slow down', 'rate');
    if (fresh.length === 0) return { recorded: 0, ignored_duplicates: targets.length };
    const lines = fresh.map((note_id) => {
      const e: UsageEvent = { ts: now.toISOString(), principal, recall_id: input.recall_id, note_id, label: 'self_reported' };
      if (input.helpful !== undefined) e.helpful = input.helpful;
      if (input.outcome_ref !== undefined) e.outcome_ref = input.outcome_ref;
      return `${JSON.stringify(e)}\n`;
    });
    appendSafe(file, lines.join(''));
    return { recorded: fresh.length, ignored_duplicates: targets.length - fresh.length };
  }, opts.lockWaitMs === undefined ? {} : { waitMs: opts.lockWaitMs });
}
