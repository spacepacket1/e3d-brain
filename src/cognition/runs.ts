// Run records (cognition Phase 2, G9): `<stateDir>/runs/<run-id>.json`, one
// per `ebrain cognition run`, rewritten atomically as the run progresses (so
// a crash leaves a `running` record that still authenticates every proposal
// it wrote). A proposal is recorded here (id, key, immutable digest) before
// its file is created; `ebrain review accept` applies only proposals found
// in a run record with a matching digest.
//
// Records hold ids, revs, hashes, counts, and settings only: never note
// bodies, query text, prompts, model output, or secrets (a scan test keeps
// it so). LLM requests are logged as SHA-256 hashes of their inputs and
// outputs.

import type { LlmRequestLog } from '../llm/session.js';
import { ulid, ULID_RE } from '../mcp/ulid.js';
import { mkdirSafe, readDirSafe, readFileSafe, resolveInState, statSafe, writeAtomic, type SafePath } from '../safe-path.js';

export const RUNS_DIR = 'runs';
const RUN_FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/;

export interface RunProposalEntry {
  id: string;
  proposal_key: string;
  /** `immutableDigest` of the proposal as written. */
  digest: string;
}

export interface RunRecord {
  run_id: string;
  job: string;
  job_version: number;
  prompt: { id: string; sha256: string } | null;
  provider: { provider: string; model: string } | null;
  started: string;
  finished: string | null;
  status: 'running' | 'finished' | 'failed';
  options: { since: string | null; max_proposals: number; dry_run: boolean; reconsider: boolean };
  budget: { max_llm_calls: number; max_input_chars: number; max_proposals: number; max_pending: number };
  /** Input notes by assigned id and rev, and a SHA-256 over the sorted list. */
  inputs: { count: number; sha256: string; notes: { id: string; rev: string }[] };
  counts: Record<string, number>;
  stop_reason: string | null;
  llm_requests: LlmRequestLog[];
  proposals: RunProposalEntry[];
}

export function newRunId(now: Date): string {
  return ulid(now.getTime());
}

function runFile(stateDir: SafePath, runId: string): SafePath {
  if (!ULID_RE.test(runId)) throw new Error('run id must be a ULID');
  return resolveInState(stateDir, `${RUNS_DIR}/${runId}.json`);
}

export function writeRunRecord(stateDir: SafePath, r: RunRecord): void {
  mkdirSafe(resolveInState(stateDir, RUNS_DIR));
  writeAtomic(runFile(stateDir, r.run_id), `${JSON.stringify(r, null, 2)}\n`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every readable run record, newest first. Unreadable or foreign files are skipped. */
export function listRunRecords(stateDir: SafePath): RunRecord[] {
  const dir = resolveInState(stateDir, RUNS_DIR);
  if (statSafe(dir) === undefined) return [];
  const out: RunRecord[] = [];
  for (const e of readDirSafe(dir)) {
    const m = RUN_FILE_RE.exec(e.name);
    if (!e.isFile() || m === null) continue;
    try {
      const r = JSON.parse(readFileSafe(runFile(stateDir, m[1]!), 'utf8')) as unknown;
      if (isObject(r) && r['run_id'] === m[1] && typeof r['job'] === 'string' && Array.isArray(r['proposals'])) out.push(r as unknown as RunRecord);
    } catch {
      // torn or foreign: not a record
    }
  }
  return out.sort((a, b) => (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0));
}

/** The run that wrote proposal `id`, with its recorded entry, or undefined. */
export function findProposalRun(stateDir: SafePath, id: string): { run: RunRecord; entry: RunProposalEntry } | undefined {
  for (const run of listRunRecords(stateDir)) {
    for (const entry of run.proposals) {
      if (isObject(entry) && entry.id === id && typeof entry.digest === 'string') return { run, entry };
    }
  }
  return undefined;
}
