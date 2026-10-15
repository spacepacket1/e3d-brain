// Replay evaluation (cognition Phase 9, G17): `ebrain eval replay --job <job>
// --at <commit-or-date>`. "What would this job have proposed back then, and
// did the owner end up doing it?"
//
//   1. Preconditions (else ReplayUnavailable: only online metrics are
//      available): the vault is in a git repository with at least one
//      commit, the history is complete (not a shallow clone), and no tracked
//      file under the vault has uncommitted changes (the later actions are
//      read from HEAD).
//   2. `git archive` (src/exec/git.ts: argument array, never a shell string,
//      never `worktree`/`checkout`) extracts the vault at that commit and at
//      HEAD into a fresh private temporary directory; nothing in the owner's
//      repository or working tree is touched.
//   3. A temporary index and state directory are built there (never the
//      owner's `stateDir`). Recall records up to the commit time are copied
//      in, so `forget` sees the recall history it would have had; the
//      configured evidence files are read (not copied) when the job uses them.
//   4. The job runs in shadow mode with the clock set to the commit time.
//   5. Its proposals are matched (outcomes.ts, structural, never by text)
//      against the owner's later actions between the commit and HEAD; the
//      counts are precision/recall-style: matched proposals / proposals, and
//      matched actions / later actions of the kinds the job can propose.
//   6. The temporary directory is removed, whatever happened.

import type { Config } from '../config.js';
import type { CognitionJob } from '../cognition/run.js';
import { runJob } from '../cognition/run.js';
import { actionKey, JOB_ACTIONS, laterActions, matchProposal, noteFacts, type ActionKind, type LaterAction } from '../cognition/outcomes.js';
import { readShadowProposal, type RunRecord } from '../cognition/runs.js';
import { discoverEvidence, openEvidence, type OpenEvidence } from '../evidence/store.js';
import { archiveTree, commitAtDate, commitTime, dirtyPaths, GitError, repoInfo, resolveCommit, type GitOptions } from '../exec/git.js';
import { closeIndex, openIndex, refreshIndex, type IndexHandle } from '../index/indexer.js';
import type { ExtractionProvider } from '../llm/provider.js';
import { readRecalls, RECALLS_FILE } from '../recall/recalls.js';
import { parseProposal, ProposalError } from '../review/proposal.js';
import { createExclusive, makeTempDir, mkdirSafe, removeTempDir, resolveInRoot, type SafePath } from '../safe-path.js';
import { isIsoDate } from '../vault/parse.js';
import { extractTar } from './tar.js';

export const ONLINE_ONLY_HINT = 'only online metrics are available: ebrain cognition report';

/** Replay cannot run on this vault (no git, dirty tree, shallow history); the message ends with ONLINE_ONLY_HINT. */
export class ReplayUnavailable extends Error {
  constructor(reason: string) {
    super(`replay evaluation needs the vault in a git repository with a clean history (${reason}); ${ONLINE_ONLY_HINT}`);
    this.name = 'ReplayUnavailable';
  }
}

/** A bad request (unknown commit, date before the first commit). */
export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

export interface ReplayOptions {
  config: Config;
  job: CognitionJob;
  /** A commit-ish or an ISO 8601 date (the newest commit at or before it). */
  at: string;
  provider?: ExtractionProvider;
  maxProposals?: number;
  /** The owner's state directory, read only (recall records), when it exists. */
  ownerStateDir?: SafePath;
  git?: GitOptions;
}

export interface ReplayResult {
  commit: string;
  commitTime: string;
  head: string;
  job: string;
  version: number;
  record: RunRecord;
  proposals: number;
  /** Proposals that match at least one later action. */
  matchedProposals: number;
  /** Shadow proposals that did not parse back (should be 0). */
  unreadable: number;
  /** Later owner actions of the kinds this job proposes. */
  actions: LaterAction[];
  matchedActions: LaterAction[];
  /** Later actions of every kind, counted by kind (context). */
  allActions: Record<ActionKind, number>;
  copiedRecalls: number;
}

function preconditions(vault: string, git: GitOptions): string {
  let info: ReturnType<typeof repoInfo>;
  try {
    info = repoInfo(vault, git);
  } catch (err) {
    if (err instanceof GitError && (err.reason === 'not-repo' || err.reason === 'absent')) throw new ReplayUnavailable(err.message);
    throw err;
  }
  if (!info.hasHead) throw new ReplayUnavailable('the repository has no commits');
  if (info.shallow) throw new ReplayUnavailable('the repository is a shallow clone, so its history is incomplete');
  const dirty = dirtyPaths(vault, git);
  if (dirty.length > 0) throw new ReplayUnavailable(`${dirty.length} tracked file(s) under the vault have uncommitted changes; commit or stash them first`);
  return info.prefix;
}

function snapshot(tmp: SafePath, name: string, vault: string, commit: string, prefix: string, git: GitOptions): { vault: SafePath; state: SafePath } {
  const v = resolveInRoot(tmp, `${name}/vault`);
  const s = resolveInRoot(tmp, `${name}/state`);
  mkdirSafe(v);
  mkdirSafe(s);
  extractTar(archiveTree(vault, commit, prefix, git), v);
  return { vault: v, state: s };
}

/** Run a replay (see the module comment). */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { config, job } = opts;
  const git = opts.git ?? {};
  const vault = config.vaultPath;
  const prefix = preconditions(vault, git);
  const commit = isIsoDate(opts.at) ? commitAtDate(vault, opts.at, git) : resolveCommit(vault, opts.at, git);
  if (commit === undefined) {
    throw new ReplayError(isIsoDate(opts.at) ? `no commit at or before ${opts.at}` : `--at ${JSON.stringify(opts.at)} is not a commit in the vault's repository`);
  }
  const head = resolveCommit(vault, 'HEAD', git)!;
  const when = commitTime(vault, commit, git);
  const whenDate = new Date(when);
  if (!Number.isFinite(whenDate.getTime())) throw new ReplayError(`cannot read the commit time of ${commit}`);

  const tmp = makeTempDir('ebrain-replay-');
  let hAt: IndexHandle | undefined;
  let hHead: IndexHandle | undefined;
  let evidence: OpenEvidence | undefined;
  try {
    const at = snapshot(tmp, 'at', vault, commit, prefix, git);
    const now = snapshot(tmp, 'head', vault, head, prefix, git);

    // Recall history as of the commit (forget's signals).
    let copiedRecalls = 0;
    if (opts.ownerStateDir !== undefined) {
      const limit = whenDate.getTime();
      const kept = readRecalls(opts.ownerStateDir).filter((r) => Date.parse(r.ts) <= limit);
      if (kept.length > 0) createExclusive(resolveInRoot(at.state, RECALLS_FILE), kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
      copiedRecalls = kept.length;
    }

    const cfgAt: Config = { ...config, vaultPath: at.vault, stateDir: at.state };
    if (job.evidence !== undefined && discoverEvidence(cfgAt).some((f) => f.refused === undefined)) evidence = openEvidence({ config: cfgAt, stateDir: at.state });
    hAt = openIndex({ vaultPath: at.vault, stateDir: at.state });
    const r = await runJob({
      config: cfgAt, stateDir: at.state, index: hAt, job, shadow: true, now: () => whenDate,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(opts.maxProposals === undefined ? {} : { maxProposals: opts.maxProposals }),
    });
    refreshIndex(hAt);
    const before = noteFacts(hAt.db);
    hHead = openIndex({ vaultPath: now.vault, stateDir: now.state });
    refreshIndex(hHead);
    const after = noteFacts(hHead.db);

    const all = laterActions(before, after);
    const relevantKinds = new Set(JOB_ACTIONS[job.name] ?? []);
    const actions = all.filter((a) => relevantKinds.has(a.kind));
    const relevantKeys = new Set(actions.map(actionKey));
    const hit = new Set<string>();
    let matchedProposals = 0;
    let unreadable = 0;
    for (const entry of r.record.shadow_proposals ?? []) {
      const text = readShadowProposal(at.state, r.record, entry.id);
      try {
        if (text === undefined) throw new ProposalError('gone');
        const p = parseProposal(text);
        const m = matchProposal({ ...p.meta, ops: p.ops }, after, before);
        if (m.length > 0) matchedProposals++;
        for (const a of m) if (relevantKeys.has(actionKey(a))) hit.add(actionKey(a));
      } catch (err) {
        if (!(err instanceof ProposalError)) throw err;
        unreadable++;
      }
    }
    const allActions = { superseded: 0, merged: 0, archived: 0, demoted: 0, lesson: 0, summary: 0 } as Record<ActionKind, number>;
    for (const a of all) allActions[a.kind]++;
    return {
      commit, commitTime: when, head, job: job.name, version: job.version, record: r.record,
      proposals: r.record.shadow_proposals?.length ?? 0, matchedProposals, unreadable,
      actions, matchedActions: actions.filter((a) => hit.has(actionKey(a))), allActions, copiedRecalls,
    };
  } finally {
    evidence?.close();
    if (hAt !== undefined) closeIndex(hAt);
    if (hHead !== undefined) closeIndex(hHead);
    removeTempDir(tmp);
  }
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);

/** The replay result as text (`ebrain eval replay`). */
export function formatReplay(r: ReplayResult): string {
  const kinds = JOB_ACTIONS[r.job] ?? [];
  const lines = [
    `replay ${r.job} v${r.version} at ${r.commit.slice(0, 12)} (${r.commitTime}); later actions read from HEAD ${r.head.slice(0, 12)}`,
    `shadow run: ${r.proposals} proposals (stop: ${r.record.stop_reason ?? '-'})${r.copiedRecalls > 0 ? `; ${r.copiedRecalls} recall records up to the commit copied in` : ''}`,
    `later owner actions: ${Object.entries(r.allActions).map(([k, n]) => `${n} ${k}`).join(', ')}`,
    kinds.length === 0
      ? `${r.job} proposes no change that a later action could confirm; precision and recall do not apply`
      : `counted for ${r.job} (${kinds.join(', ')}): ${r.actions.length}`,
    `precision: ${r.matchedProposals} of ${r.proposals} proposals match a later action (${pct(r.matchedProposals, r.proposals)})`,
  ];
  if (kinds.length > 0) lines.push(`recall: ${r.matchedActions.length} of ${r.actions.length} later actions were proposed (${pct(r.matchedActions.length, r.actions.length)})`);
  if (r.unreadable > 0) lines.push(`${r.unreadable} shadow proposals could not be read back`);
  const missed = r.actions.filter((a) => !r.matchedActions.some((m) => m.kind === a.kind && m.id === a.id));
  for (const a of missed.slice(0, 10)) lines.push(`  missed: ${a.kind} ${a.path}`);
  lines.push('matching is structural (targets, created-note kind and citations), best effort; temporary copies were removed and the vault was not touched');
  return `${lines.join('\n')}\n`;
}
