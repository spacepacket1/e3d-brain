// `forget` (cognition Phase 7, G14): "which notes have gone quiet?" Never
// deletes (C10): the proposals only demote (`status: stale`, still
// searchable, ranked below normal) or archive (C10 archive path, all content
// kept). No model is involved; every rule is a deterministic signal.
//
// Staleness signals, shown by value (never scored): age since the latest of
// `occurred`, `created`, and the file's modified time; `recall_count` and
// `last_recalled` from `note_stats` (rebuilt from `recalls.jsonl` at the start
// of every run); how many linked notes (either direction) are superseded or
// archived; and `expires`.
//
// Candidates: curated notes (not hidden, assigned id, no status, `accepted`,
// or `stale`) that are not `pinned`, whose kind is not exempt
// (`cognition.forget.exemptKinds`, default `decision` and `reference`: either
// is often the sole record of something), that are at least
// `cognition.forget.minAgeDays` old (default 90), that have no recall in the
// last `cognition.forget.windowDays` (default 180), and that no accepted
// curated note cites (the `cites` table: `sources` and `derived_from`).
// "Never recalled" is only known from when the recall record starts: with no
// record, or one that starts inside the window, a never-recalled note is not
// a candidate (counted as `skipped_no_history`).
//
// Ladder: an accepted note gets a `demote` proposal; a note already `stale`
// that still meets every rule gets an `archive` proposal (status `archived`,
// `archived_at`, move to `archiveDestination`).
//
// Journal expiry: only when `journal.pruneRequiresReview` is true, each
// journal entry whose `expires` has passed (any principal, as
// `ebrain journal prune` does) becomes an `archive` proposal to
// `journal/_archive/<principal>/...`. They come first, in `expires` order.
// With the default (false) this job leaves the journal alone and
// `journal prune` keeps archiving directly.
//
// Priority: oldest last recall first (never recalled counts as oldest), then
// the older reference date, then the vault path (bytewise).

import { formatCitation } from '../../cite/citation.js';
import type { Config } from '../../config.js';
import { isoSeconds } from '../../inbox/note.js';
import type { IndexHandle } from '../../index/indexer.js';
import { allNoteRows, type NoteRow } from '../../index/query.js';
import { isoToMs } from '../../mcp/tools.js';
import { rebuildNoteStats, trackingStart } from '../../recall/stats.js';
import { archiveDestination, type ChangeOp } from '../../review/proposal.js';
import type { SafePath } from '../../safe-path.js';
import { compareBytes } from '../../vault/names.js';
import type { CognitionJob, Draft, JobContext, JobOutput } from '../run.js';

const DAY_MS = 86_400_000;
const ELIGIBLE_STATUSES = new Set([null, 'accepted', 'stale']);

export interface ForgetSignals {
  /** The latest of occurred, created, and modified (UTC ISO). */
  reference: string;
  ageDays: number;
  recallCount: number;
  lastRecalled: string | null;
  /** Linked notes (either direction) that are superseded or archived. */
  linkedInactive: number;
  expires: string | null;
}

export interface ForgetCandidate {
  row: NoteRow;
  action: 'demote' | 'archive';
  signals: ForgetSignals;
  /** An expired journal entry (`journal.pruneRequiresReview`). */
  expiredJournal: boolean;
  cite: string;
}

export interface ForgetAnalysis {
  /** In priority order. */
  candidates: ForgetCandidate[];
  counts: Record<string, number>;
  trackingStart: string | undefined;
}

export interface ForgetInput {
  config: Config;
  index: IndexHandle;
  stateDir: SafePath;
  now: Date;
  /** Expired journal entries only (`ebrain journal prune` with review). */
  journalOnly?: boolean;
}

/** Compute the candidates and the skip counts. Rebuilds `note_stats` first. */
export function analyzeForget(input: ForgetInput): ForgetAnalysis {
  const { config, index, stateDir, now } = input;
  const { db } = index;
  const nowMs = now.getTime();
  const counts: Record<string, number> = {};
  const count = (k: string): void => void (counts[k] = (counts[k] ?? 0) + 1);
  rebuildNoteStats(db, stateDir);
  const start = trackingStart(db);
  const startMs = start === undefined ? undefined : Date.parse(start);
  const { windowDays, minAgeDays, exemptKinds } = config.cognition.forget;
  const windowStart = nowMs - windowDays * DAY_MS;
  const exempt = new Set(exemptKinds);

  const stats = new Map((db.prepare('SELECT id, recall_count, last_recalled FROM note_stats').all() as { id: string; recall_count: number; last_recalled: string }[]).map((s) => [s.id, s]));
  const mtimes = new Map((db.prepare('SELECT path, mtime_ns FROM notes').all() as { path: string; mtime_ns: string }[]).map((r) => [r.path, Number(BigInt(r.mtime_ns) / 1_000_000n)]));
  const pinned = new Set((db.prepare('SELECT path FROM notes WHERE pinned = 1').all() as { path: string }[]).map((r) => r.path));
  const citedStmt = db.prepare(
    `SELECT 1 FROM cites c JOIN notes f ON f.path = c.from_path
     WHERE c.to_id = ? AND c.from_id <> ? AND f.folder_class = 'curated' AND f.folder_hidden = 0 AND (f.status IS NULL OR f.status = 'accepted') LIMIT 1`,
  );
  const inactive = new Set((db.prepare(`SELECT path FROM notes WHERE status IN ('superseded', 'archived') OR folder_class = 'archive'`).all() as { path: string }[]).map((r) => r.path));
  const linked = new Map<string, Set<string>>();
  for (const l of db.prepare('SELECT DISTINCT note_path AS p, resolved_path AS q FROM links WHERE resolved_path IS NOT NULL AND note_path <> resolved_path').all() as { p: string; q: string }[]) {
    for (const [a, b] of [[l.p, l.q], [l.q, l.p]] as const) linked.set(a, (linked.get(a) ?? new Set()).add(b));
  }

  const signalsOf = (r: NoteRow, referenceMs: number): ForgetSignals => {
    const st = stats.get(r.id);
    return {
      reference: new Date(referenceMs).toISOString(),
      ageDays: Math.max(0, Math.floor((nowMs - referenceMs) / DAY_MS)),
      recallCount: st?.recall_count ?? 0,
      lastRecalled: st?.last_recalled ?? null,
      linkedInactive: [...(linked.get(r.path) ?? [])].filter((p) => inactive.has(p)).length,
      expires: r.expires,
    };
  };

  const journal: ForgetCandidate[] = [];
  const quiet: ForgetCandidate[] = [];
  for (const r of allNoteRows(db)) {
    if (r.folder_hidden !== 0 || r.status_known !== 1) continue;
    if (r.folder_class === 'journal') {
      if (!config.journal.pruneRequiresReview || r.provisional === 1) continue;
      const exp = r.expires === null ? undefined : isoToMs(r.expires, 'end');
      if (exp === undefined || exp >= nowMs) continue;
      count('expired_journal');
      journal.push({
        row: r, action: 'archive', expiredJournal: true, cite: formatCitation({ kind: 'note', id: r.id, rev: r.rev }),
        signals: signalsOf(r, Math.max(isoToMs(r.created ?? '') ?? 0, mtimes.get(r.path) ?? 0)),
      });
      continue;
    }
    if (input.journalOnly === true || r.folder_class !== 'curated' || !ELIGIBLE_STATUSES.has(r.status)) continue;
    count('eligible_notes');
    if (r.provisional === 1) {
      count('skipped_provisional');
      continue;
    }
    if (pinned.has(r.path)) {
      count('skipped_pinned');
      continue;
    }
    if (r.kind !== null && exempt.has(r.kind)) {
      count('skipped_exempt_kind');
      continue;
    }
    const referenceMs = Math.max(isoToMs(r.occurred ?? '') ?? 0, isoToMs(r.created ?? '') ?? 0, mtimes.get(r.path) ?? 0);
    if (referenceMs > nowMs - minAgeDays * DAY_MS) {
      count('skipped_young');
      continue;
    }
    const signals = signalsOf(r, referenceMs);
    if (signals.lastRecalled !== null) {
      if (Date.parse(signals.lastRecalled) >= windowStart) {
        count('skipped_recalled');
        continue;
      }
    } else if (startMs === undefined || startMs > windowStart) {
      count('skipped_no_history');
      continue;
    }
    if (citedStmt.get(r.id, r.id) !== undefined) {
      count('skipped_cited');
      continue;
    }
    quiet.push({ row: r, action: r.status === 'stale' ? 'archive' : 'demote', signals, expiredJournal: false, cite: formatCitation({ kind: 'note', id: r.id, rev: r.rev }) });
  }
  journal.sort((a, b) => compareBytes(a.row.expires ?? '', b.row.expires ?? '') || compareBytes(a.row.path, b.row.path));
  quiet.sort((a, b) => {
    const la = a.signals.lastRecalled === null ? Number.NEGATIVE_INFINITY : Date.parse(a.signals.lastRecalled);
    const lb = b.signals.lastRecalled === null ? Number.NEGATIVE_INFINITY : Date.parse(b.signals.lastRecalled);
    if (la !== lb) return la < lb ? -1 : 1;
    return compareBytes(a.signals.reference, b.signals.reference) || compareBytes(a.row.path, b.row.path);
  });
  counts['demote_candidates'] = quiet.filter((c) => c.action === 'demote').length;
  counts['archive_candidates'] = quiet.length - counts['demote_candidates'] + journal.length;
  return { candidates: [...journal, ...quiet], counts, trackingStart: start };
}

/** The signal values as one line (values, not scores). */
export function describeSignals(s: ForgetSignals): string {
  return [
    `age ${s.ageDays} days (latest of occurred/created/modified: ${s.reference.slice(0, 10)})`,
    `recalls ${s.recallCount}`,
    `last recalled ${s.lastRecalled === null ? 'never' : s.lastRecalled.slice(0, 10)}`,
    `${s.linkedInactive} linked note(s) superseded or archived`,
    ...(s.expires === null ? [] : [`expires ${s.expires}`]),
  ].join('; ');
}

function draftOf(c: ForgetCandidate, now: Date, windowDays: number): Draft {
  const r = c.row;
  const target = [{ id: r.id, rev: r.rev, path_at_proposal: r.path }];
  const sig = describeSignals(c.signals);
  if (c.action === 'demote') {
    return {
      proposal_type: 'demote',
      title: `Demote: ${r.title}`,
      rationale: [
        `\`${r.path}\` has not been recalled in ${windowDays} days, is not pinned, and no accepted note cites it. Accepting sets \`status: stale\`: it stays searchable but ranks below normal notes. \`ebrain review undo\` restores it.`,
        '',
        `Signals: ${sig}.`,
      ].join('\n'),
      targets: target,
      evidence: [c.cite],
      ops: [{ op: 'set_frontmatter', target: r.id, key: 'status', value: 'stale' }],
    };
  }
  const dest = archiveDestination(r.path);
  const ops: ChangeOp[] = [
    { op: 'set_frontmatter', target: r.id, key: 'status', value: 'archived' },
    { op: 'set_frontmatter', target: r.id, key: 'archived_at', value: isoSeconds(now) },
    { op: 'move_note', target: r.id, to: dest },
  ];
  return {
    proposal_type: 'archive',
    title: `Archive: ${r.title}`,
    rationale: [
      c.expiredJournal
        ? `Journal entry \`${r.path}\` expired on ${r.expires}.`
        : `\`${r.path}\` is already stale and still has no recall in ${windowDays} days, is not pinned, and no accepted note cites it.`,
      `Accepting moves it to \`${dest}\` with \`status: archived\` and \`archived_at\`; all content is kept and search hides it by default. Nothing is deleted; \`ebrain review undo\` restores it at \`${r.path}\`.`,
      '',
      `Signals: ${sig}.`,
    ].join('\n'),
    targets: target,
    evidence: [c.cite],
    ops,
  };
}

function generateWith(journalOnly: boolean): (ctx: JobContext) => Promise<JobOutput> {
  return (ctx) => {
    const a = analyzeForget({ config: ctx.config, index: ctx.index, stateDir: ctx.stateDir, now: ctx.now, journalOnly });
    for (const [k, n] of Object.entries(a.counts)) ctx.count(k, n);
    ctx.count('candidates', a.candidates.length);
    const drafts: Draft[] = [];
    for (const c of a.candidates) {
      ctx.input(c.row.id, c.row.rev);
      drafts.push(draftOf(c, ctx.now, ctx.config.cognition.forget.windowDays));
    }
    return Promise.resolve({ drafts });
  };
}

export const FORGET_JOB: CognitionJob = {
  name: 'forget',
  version: 1,
  description: 'propose demoting (status: stale) or archiving notes with no recent recall; never deletes (no model)',
  llm: 'never',
  generate: generateWith(false),
};

/** The `forget` mechanism restricted to expired journal entries: what `ebrain journal prune` runs when `journal.pruneRequiresReview` is true. Not registered as a job. */
export const JOURNAL_PRUNE_JOB: CognitionJob = { ...FORGET_JOB, generate: generateWith(true) };
