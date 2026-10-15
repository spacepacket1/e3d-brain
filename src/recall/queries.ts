// The query log (cognition Phase 8, G18): `<stateDir>/queries.jsonl`, opt-in
// (`queryLog.enabled`, default false). When on, each `search` appends one
// line `{ts, recall_id, principal, query, results, top_tier}`. The query text
// is scrubbed with strict rules first: a query with a credential is not
// logged at all, and anything else the scrubber finds is redacted. The file is
// 0600 in the state directory, never the vault. `ebrain queries prune`
// (owner CLI) drops records older than `queryLog.retentionDays`.
// The `gaps` job reads this file; nothing else does.

import { withLock } from '../lock.js';
import { appendSafe, readFileSafe, resolveInState, statSafe, writeAtomic, type SafePath } from '../safe-path.js';
import { scrub } from '../scrub/index.js';

export const QUERIES_FILE = 'queries.jsonl';
export const QUERIES_LOCK = 'queries';
/** Longer queries are cut to this many characters before scrubbing. */
export const MAX_LOGGED_QUERY_CHARS = 300;
const DAY_MS = 86_400_000;

export interface QueryRecord {
  ts: string;
  recall_id: string;
  principal: string;
  /** Scrubbed. */
  query: string;
  /** Results returned (notes and book passages). */
  results: number;
  /** Tier (1-8) of the first result; null with no results. */
  top_tier: number | null;
}

function queriesPath(stateDir: SafePath): SafePath {
  return resolveInState(stateDir, QUERIES_FILE);
}

/** The text to log for a query: strictly scrubbed, or undefined when it must not be logged (credential found, or nothing left). */
export function scrubQuery(query: string, extraPatterns: readonly string[] = []): string | undefined {
  const cut = query.length > MAX_LOGGED_QUERY_CHARS ? query.slice(0, MAX_LOGGED_QUERY_CHARS) : query;
  const r = scrub(cut, { strict: true, extraPatterns });
  if (!r.ok) return undefined;
  const text = r.text.replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

export interface QueryLogOptions {
  extraPatterns?: readonly string[];
  now?: () => Date;
}

/** Appends query records for one server process. */
export class QueryLog {
  private readonly extraPatterns: readonly string[];
  private readonly now: () => Date;

  constructor(readonly stateDir: SafePath, opts: QueryLogOptions = {}) {
    this.extraPatterns = opts.extraPatterns ?? [];
    this.now = opts.now ?? (() => new Date());
  }

  /** Returns whether a line was written (false: the scrubber refused the query). */
  append(input: { recall_id: string; principal: string; query: string; results: number; top_tier: number | null }): boolean {
    const query = scrubQuery(input.query, this.extraPatterns);
    if (query === undefined) return false;
    const record: QueryRecord = {
      ts: this.now().toISOString(), recall_id: input.recall_id, principal: input.principal, query, results: input.results, top_tier: input.top_tier,
    };
    withLock(this.stateDir, QUERIES_LOCK, () => appendSafe(queriesPath(this.stateDir), `${JSON.stringify(record)}\n`));
    return true;
  }
}

function parseRecord(line: string): QueryRecord | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r['ts'] !== 'string' || Number.isNaN(Date.parse(r['ts'])) || typeof r['recall_id'] !== 'string' || typeof r['principal'] !== 'string') return undefined;
  if (typeof r['query'] !== 'string' || typeof r['results'] !== 'number' || !Number.isInteger(r['results']) || r['results'] < 0) return undefined;
  const tier = r['top_tier'];
  if (tier !== null && (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 1 || tier > 9)) return undefined;
  return { ts: r['ts'], recall_id: r['recall_id'], principal: r['principal'], query: r['query'], results: r['results'], top_tier: tier };
}

function readLines(stateDir: SafePath): string[] {
  const file = queriesPath(stateDir);
  if (statSafe(file) === undefined) return [];
  return readFileSafe(file, 'utf8').split('\n').filter((l) => l !== '');
}

/** Every well-formed record, oldest first. Malformed lines are skipped. */
export function readQueries(stateDir: SafePath): QueryRecord[] {
  return readLines(stateDir).map(parseRecord).filter((r): r is QueryRecord => r !== undefined);
}

/** Drop records older than `retentionDays` (and malformed lines). Owner CLI only. */
export function pruneQueries(stateDir: SafePath, retentionDays: number, now: Date = new Date()): { kept: number; removed: number } {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retentionDays must be a positive integer');
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  return withLock(stateDir, QUERIES_LOCK, () => {
    const lines = readLines(stateDir);
    const kept = lines.filter((l) => {
      const r = parseRecord(l);
      return r !== undefined && Date.parse(r.ts) >= cutoff;
    });
    if (kept.length !== lines.length) writeAtomic(queriesPath(stateDir), kept.map((l) => `${l}\n`).join(''));
    return { kept: kept.length, removed: lines.length - kept.length };
  });
}
