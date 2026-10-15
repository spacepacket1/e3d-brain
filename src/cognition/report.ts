// Online metrics and kill criteria (cognition Phase 9, G17):
// `ebrain cognition report [--check]`. Everything is counted from review
// records, never from model output:
//
//   - which proposals a job created: the run records (`<stateDir>/runs/`,
//     `proposals`, so shadow and dry runs create none);
//   - what the owner did with each: the proposal file itself, found by id in
//     `_inbox/` (`proposed` = pending, `stale`), `_inbox/_applied/`
//     (`accepted`, with an `edited` stamp from `ebrain review edit` when it was
//     edited first), or `_inbox/_rejected/` (`rejected`, `rejected_reason`);
//     a recorded proposal whose file is gone is `missing`;
//   - time to review: the proposal's `created` to its `applied`/`rejected`
//     stamp.
//
// Acceptance rate = (accepted + edited-then-accepted) / reviewed, where
// reviewed = accepted + edited-then-accepted + rejected. `--check` applies the
// per-job kill criteria (KILL_CRITERIA, documented in docs/COGNITION-EVAL.md)
// to the job's current version: the last `window` reviewed proposals by
// review time; with fewer than `minReviewed` reviewed there is no verdict.
//
// Shadow proposals (`<stateDir>/shadow/`) are compared with what the owner
// later did by hand using the structural matcher in `outcomes.ts`. The report
// reads the vault and the state directory and writes nothing but the index.

import { parseDocument } from 'yaml';
import type { Config } from '../config.js';
import { INBOX_DIR } from '../inbox/writer.js';
import { refreshIndex, type IndexHandle } from '../index/indexer.js';
import { allNoteRows } from '../index/query.js';
import { parseProposal, ProposalError } from '../review/proposal.js';
import { readFileWithStatSafe, resolveInVault, type SafePath } from '../safe-path.js';
import { splitFrontmatter } from '../vault/parse.js';
import { matchProposal, noteFacts } from './outcomes.js';
import { listRunRecords, readShadowProposal } from './runs.js';

const APPLIED_PREFIX = `${INBOX_DIR}/_applied/`;
const REJECTED_PREFIX = `${INBOX_DIR}/_rejected/`;
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_REASON_CHARS = 200;
export const NO_REASON = '(no reason given)';

/** Below `minAcceptanceRate` over the last `window` reviewed proposals (with at least `minReviewed` of them), disable the job. */
export interface KillCriterion {
  minAcceptanceRate: number;
  window: number;
  minReviewed: number;
}

/** Per-job kill criteria (docs/COGNITION-EVAL.md states the same table; a test keeps them equal). Jobs not listed are never checked. */
export const KILL_CRITERIA: Readonly<Record<string, KillCriterion>> = {
  supersede: { minAcceptanceRate: 0.3, window: 50, minReviewed: 10 },
  consolidate: { minAcceptanceRate: 0.3, window: 50, minReviewed: 10 },
  reflect: { minAcceptanceRate: 0.25, window: 50, minReviewed: 10 },
  forget: { minAcceptanceRate: 0.3, window: 50, minReviewed: 10 },
  gaps: { minAcceptanceRate: 0.2, window: 50, minReviewed: 10 },
};

export type ReviewOutcome = 'pending' | 'accepted' | 'edited_accepted' | 'rejected' | 'stale' | 'missing';

interface ReviewRecord {
  outcome: ReviewOutcome;
  createdMs?: number;
  reviewedMs?: number;
  reason?: string;
}

export interface JobVersionStats {
  job: string;
  version: number;
  created: number;
  accepted: number;
  edited_accepted: number;
  rejected: number;
  stale: number;
  pending: number;
  missing: number;
  /** Median of created -> applied/rejected over reviewed proposals with both stamps, in ms; null when none. */
  median_review_ms: number | null;
  /** Rejection reasons (trimmed, whitespace collapsed, lowercased) -> count. */
  rejected_reasons: Record<string, number>;
}

export interface ShadowStats {
  job: string;
  version: number;
  runs: number;
  proposals: number;
  /** Shadow proposals the owner later carried out by hand (structural match on targets). */
  matched: number;
  /** Recorded shadow proposals whose file is gone or no longer parses. */
  unreadable: number;
}

export interface CheckResult {
  job: string;
  version: number;
  criterion: KillCriterion;
  reviewed: number;
  accepted: number;
  /** Null when fewer than `minReviewed` proposals were reviewed. */
  rate: number | null;
  verdict: 'ok' | 'below' | 'insufficient';
}

export interface CognitionReport {
  rows: JobVersionStats[];
  shadow: ShadowStats[];
  checks: CheckResult[];
}

export interface ReportOptions {
  config: Config;
  stateDir: SafePath;
  index: IndexHandle;
  /** Job name -> current version (the kill criteria apply to that version). */
  currentVersions: ReadonlyMap<string, number>;
  /** Override KILL_CRITERIA (tests). */
  criteria?: Readonly<Record<string, KillCriterion>>;
}

function stamp(fm: Record<string, unknown>, key: string): number | undefined {
  const v = fm[key];
  const t = typeof v === 'string' ? Date.parse(v) : v instanceof Date ? v.getTime() : NaN;
  return Number.isFinite(t) ? t : undefined;
}

export function normalizeReason(raw: unknown): string {
  if (typeof raw !== 'string') return NO_REASON;
  const r = raw.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_REASON_CHARS);
  return r === '' ? NO_REASON : r;
}

const RANK: Readonly<Record<ReviewOutcome, number>> = { accepted: 5, edited_accepted: 5, rejected: 4, stale: 3, pending: 2, missing: 0 };

/** Review records for every typed proposal file in `_inbox/` (open, applied, rejected), by proposal id. */
function reviewRecords(config: Config, index: IndexHandle): Map<string, ReviewRecord> {
  const out = new Map<string, ReviewRecord>();
  for (const r of allNoteRows(index.db)) {
    if (r.folder_class !== 'inbox' || r.kind !== 'proposal' || r.provisional === 1) continue;
    let fm: Record<string, unknown>;
    try {
      const { yaml } = splitFrontmatter(readFileWithStatSafe(resolveInVault(config.vaultPath, r.path), { maxBytes: MAX_PROPOSAL_BYTES }).data.toString('utf8'));
      if (yaml === null) continue;
      const v = parseDocument(yaml, { schema: 'core', prettyErrors: false }).toJS({ maxAliasCount: 0 }) as unknown;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
      fm = v as Record<string, unknown>;
    } catch {
      continue; // unreadable: not a review record
    }
    let rec: ReviewRecord;
    const createdMs = stamp(fm, 'created');
    const base = createdMs === undefined ? {} : { createdMs };
    if (r.path.startsWith(APPLIED_PREFIX) && fm['status'] === 'accepted') {
      const reviewedMs = stamp(fm, 'applied');
      rec = { outcome: fm['edited'] !== undefined ? 'edited_accepted' : 'accepted', ...base, ...(reviewedMs === undefined ? {} : { reviewedMs }) };
    } else if (r.path.startsWith(REJECTED_PREFIX) && fm['status'] === 'rejected') {
      const reviewedMs = stamp(fm, 'rejected');
      rec = { outcome: 'rejected', ...base, ...(reviewedMs === undefined ? {} : { reviewedMs }), reason: normalizeReason(fm['rejected_reason']) };
    } else if (r.folder_hidden === 0 && fm['status'] === 'stale') {
      rec = { outcome: 'stale', ...base };
    } else if (r.folder_hidden === 0 && fm['status'] === 'proposed') {
      rec = { outcome: 'pending', ...base };
    } else continue;
    const prev = out.get(r.id);
    if (prev === undefined || RANK[rec.outcome] > RANK[prev.outcome]) out.set(r.id, rec);
  }
  return out;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const cmpJobVersion = (a: { job: string; version: number }, b: { job: string; version: number }): number =>
  a.job < b.job ? -1 : a.job > b.job ? 1 : a.version - b.version;

/** Build the report (see the module comment). Refreshes the index; writes nothing else. */
export function buildReport(opts: ReportOptions): CognitionReport {
  const { config, stateDir, index } = opts;
  const criteria = opts.criteria ?? KILL_CRITERIA;
  refreshIndex(index);
  const records = reviewRecords(config, index);
  const runs = listRunRecords(stateDir);

  const rows = new Map<string, JobVersionStats & { review_ms: number[] }>();
  const reviewedByJob = new Map<string, { version: number; reviewedMs: number; accepted: boolean }[]>();
  const seen = new Set<string>();
  for (const run of runs) {
    for (const entry of run.proposals) {
      if (typeof entry?.id !== 'string' || seen.has(entry.id)) continue;
      seen.add(entry.id);
      const k = `${run.job}\u0000${run.job_version}`;
      let row = rows.get(k);
      if (row === undefined) {
        row = {
          job: run.job, version: run.job_version, created: 0, accepted: 0, edited_accepted: 0, rejected: 0, stale: 0, pending: 0, missing: 0,
          median_review_ms: null, rejected_reasons: {}, review_ms: [],
        };
        rows.set(k, row);
      }
      row.created++;
      const rec = records.get(entry.id) ?? { outcome: 'missing' as const };
      row[rec.outcome]++;
      if (rec.outcome === 'rejected') row.rejected_reasons[rec.reason ?? NO_REASON] = (row.rejected_reasons[rec.reason ?? NO_REASON] ?? 0) + 1;
      if (rec.outcome === 'accepted' || rec.outcome === 'edited_accepted' || rec.outcome === 'rejected') {
        if (rec.reviewedMs !== undefined && rec.createdMs !== undefined && rec.reviewedMs >= rec.createdMs) row.review_ms.push(rec.reviewedMs - rec.createdMs);
        const list = reviewedByJob.get(run.job) ?? [];
        list.push({ version: run.job_version, reviewedMs: rec.reviewedMs ?? rec.createdMs ?? 0, accepted: rec.outcome !== 'rejected' });
        reviewedByJob.set(run.job, list);
      }
    }
  }
  const outRows = [...rows.values()].map(({ review_ms, ...r }) => ({ ...r, median_review_ms: median(review_ms) })).sort(cmpJobVersion);

  // Shadow proposals against the owner's later hand-made changes.
  const facts = noteFacts(index.db);
  const shadow = new Map<string, ShadowStats>();
  for (const run of runs) {
    if (run.options?.shadow !== true || !Array.isArray(run.shadow_proposals)) continue;
    const k = `${run.job}\u0000${run.job_version}`;
    let s = shadow.get(k);
    if (s === undefined) {
      s = { job: run.job, version: run.job_version, runs: 0, proposals: 0, matched: 0, unreadable: 0 };
      shadow.set(k, s);
    }
    s.runs++;
    for (const entry of run.shadow_proposals) {
      if (typeof entry?.id !== 'string') continue;
      s.proposals++;
      const text = readShadowProposal(stateDir, run, entry.id);
      try {
        if (text === undefined) throw new ProposalError('gone');
        const p = parseProposal(text);
        if (matchProposal({ ...p.meta, ops: p.ops }, facts).length > 0) s.matched++;
      } catch (err) {
        if (!(err instanceof ProposalError)) throw err;
        s.unreadable++;
      }
    }
  }

  const checks: CheckResult[] = [];
  for (const [job, criterion] of Object.entries(criteria).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const version = opts.currentVersions.get(job);
    if (version === undefined) continue;
    const window = (reviewedByJob.get(job) ?? []).filter((x) => x.version === version).sort((a, b) => b.reviewedMs - a.reviewedMs).slice(0, criterion.window);
    const accepted = window.filter((x) => x.accepted).length;
    const enough = window.length >= criterion.minReviewed;
    const rate = enough ? accepted / window.length : null;
    checks.push({
      job, version, criterion, reviewed: window.length, accepted, rate,
      verdict: rate === null ? 'insufficient' : rate < criterion.minAcceptanceRate ? 'below' : 'ok',
    });
  }
  return { rows: outRows, shadow: [...shadow.values()].sort(cmpJobVersion), checks };
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'n/a';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** The report as text (`ebrain cognition report`). */
export function formatReport(r: CognitionReport, opts: { check: boolean }): string {
  const lines: string[] = ['cognition report (from review records: run records, _inbox/, _inbox/_applied/, _inbox/_rejected/)'];
  if (r.rows.length === 0) lines.push('no proposals recorded yet (run a job with: ebrain cognition run <job>)');
  for (const s of r.rows) {
    const reviewed = s.accepted + s.edited_accepted + s.rejected;
    lines.push(
      `${s.job} v${s.version}: ${s.created} created; ${s.accepted} accepted, ${s.edited_accepted} edited then accepted, ${s.rejected} rejected, ` +
        `${s.stale} stale, ${s.pending} pending, ${s.missing} missing; acceptance ${pct(s.accepted + s.edited_accepted, reviewed)} (${s.accepted + s.edited_accepted}/${reviewed} reviewed); ` +
        `median time to review ${formatDuration(s.median_review_ms)}`,
    );
    const reasons = Object.entries(s.rejected_reasons).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
    if (reasons.length > 0) lines.push(`  rejected reasons: ${reasons.slice(0, 10).map(([k, n]) => `${JSON.stringify(k)} ${n}`).join(', ')}${reasons.length > 10 ? `, ${reasons.length - 10} more` : ''}`);
  }
  if (r.shadow.length > 0) {
    lines.push('shadow runs (proposals in <stateDir>/shadow/, compared with what the owner later did by hand; structural match on targets):');
    for (const s of r.shadow) {
      lines.push(`  ${s.job} v${s.version}: ${s.runs} runs, ${s.proposals} proposals, ${s.matched} later done by hand (${pct(s.matched, s.proposals)})${s.unreadable > 0 ? `, ${s.unreadable} unreadable` : ''}`);
    }
  }
  if (opts.check) {
    lines.push('kill criteria (docs/COGNITION-EVAL.md; current job version, last reviewed proposals):');
    for (const c of r.checks) {
      const rule = `threshold ${Math.round(c.criterion.minAcceptanceRate * 100)}% over the last ${c.criterion.window}, at least ${c.criterion.minReviewed} reviewed`;
      const got = `${c.accepted}/${c.reviewed} accepted`;
      const verdict = c.verdict === 'below' ? 'BELOW THRESHOLD: disable this job' : c.verdict === 'ok' ? 'ok' : 'not enough reviews yet';
      lines.push(`  ${c.job} v${c.version}: ${got}${c.rate === null ? '' : ` (${pct(c.accepted, c.reviewed)})`}; ${rule}: ${verdict}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
