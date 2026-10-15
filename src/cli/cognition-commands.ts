// `ebrain cognition run <job> [--since <date>] [--max-proposals N] [--dry-run]
// [--reconsider] [--i-understand-data-leaves-machine]` and `ebrain cognition
// runs [-n N]` (cognition Phase 2). Owner CLI only (C2): no MCP tool starts,
// schedules, or lists jobs. Works in every instance mode (C11): proposals go
// to `_inbox/` whatever the mode.

import { ConfigError, ensureStateDir, loadConfig, MAX_PROPOSALS_CEILING, type EnvOptions } from '../config.js';
import { analyzeForget, describeSignals } from '../cognition/jobs/forget.js';
import { findJob, JOBS } from '../cognition/jobs/index.js';
import { CognitionError, runJob } from '../cognition/run.js';
import { listRunRecords, type RunRecord } from '../cognition/runs.js';
import { PromptFileError } from '../cognition/prompts.js';
import { discoverEvidence, EvidenceError, openEvidence, type OpenEvidence } from '../evidence/store.js';
import { closeIndex, openIndex, refreshIndex } from '../index/indexer.js';
import { allNoteRows } from '../index/query.js';
import { rebuildNoteUsage } from '../recall/usage-rollup.js';
import { createProvider, DATA_LEAVES_MACHINE_FLAG, LlmRefusedError, type ExtractionProvider } from '../llm/provider.js';
import { SafePathError } from '../safe-path.js';
import { isIsoDate } from '../vault/parse.js';
import type { CommandResult } from './index-commands.js';

export const COGNITION_USAGE = `usage: ebrain cognition run <job> [--since <date>] [--max-proposals <n>] [--dry-run] [--reconsider] [${DATA_LEAVES_MACHINE_FLAG}]
       ebrain cognition runs [-n <count>]
       ebrain cognition stats forget | usage
jobs: ${JOBS.map((j) => `${j.name} (${j.description})`).join('; ')}`;

export interface CognitionCommandOptions extends EnvOptions {
  now?: () => Date;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain cognition: ${msg}\n${COGNITION_USAGE}\n` };
}

function fail(msg: string): CommandResult {
  return { code: 1, stdout: '', stderr: `ebrain cognition: ${msg}\n` };
}

function summarize(r: RunRecord, created: { id: string; path: string }[], maxPending: number): string {
  const c = (k: string) => r.counts[k] ?? 0;
  const lines = created.map((p) => `created ${p.id} ${p.path}`);
  lines.push(
    `cognition run ${r.job}: run ${r.run_id}${r.options.dry_run ? ' (dry run: nothing written to the vault)' : ''}`,
    `proposals: ${c('created')} created${r.options.dry_run ? `, ${c('would_create')} would be created` : ''}, ${c('duplicates')} already in _inbox/, ` +
      `${c('rejected_skipped')} previously rejected (skipped)${r.options.reconsider ? `, ${c('reconsidered')} reconsidered` : ''}, ` +
      `${c('invalid_drafts')} invalid, ${c('scrub_rejected')} refused by the scrubber`,
  );
  if (r.provider !== null) {
    lines.push(`llm: ${c('llm_calls')} calls (${c('llm_input_chars')} chars sent), ${c('llm_invalid_items')} invalid items and ${c('llm_invalid_responses')} malformed responses dropped`);
  }
  lines.push(`stop: ${r.stop_reason}`);
  if (r.stop_reason === 'max-pending') lines.push(`the inbox holds ${maxPending} or more open proposals (inbox.maxPendingProposals); review some, then re-run`);
  if (r.stop_reason === 'max-proposals') lines.push(`reached --max-proposals / cognition.maxProposalsPerRun (${r.options.max_proposals}); re-run for more`);
  if (r.job === 'supersede') {
    lines.push(
      `supersede: ${c('candidates')} candidate pairs from ${c('eligible_notes')} notes; skipped ${c('skipped_pinned')} with a pinned older note, ${c('skipped_same_date')} with equal dates, ${c('skipped_undated')} undated notes`,
    );
    if (r.provider !== null) {
      lines.push(`verdicts: ${c('relation_supersedes')} supersedes, ${c('relation_conflicts')} conflicts, ${c('relation_compatible')} compatible, ${c('relation_unrelated')} unrelated; ${c('quotes_unverified')} dropped (quotes not verbatim), ${c('no_verdict')} without a valid verdict`);
    } else {
      lines.push(`no LLM provider: proposals are marked needs_review: unadjudicated (cap cognition.supersede.maxUnadjudicated; ${c('unadjudicated_capped')} pairs over the cap)`);
    }
  }
  if (r.job === 'consolidate') {
    lines.push(
      `consolidate: ${c('eligible_notes')} notes (skipped ${c('skipped_pinned')} pinned, ${c('skipped_other_principal')} journal entries of other principals); ` +
        `${c('duplicate_pairs')} near-duplicate pairs from ${c('dedup_candidates')} candidates (${c('merge_overlap_skipped')} overlapping another merge); ` +
        `${c('clusters')} clusters (${c('summary_exists')} already summarized, ${c('summaries_capped')} over cognition.consolidate.maxSummaries)`,
    );
    if (r.provider !== null) {
      lines.push(`claims: ${c('claims_supported')} supported, ${c('claims_unsupported')} dropped (quote not verbatim in the cited source); ${c('summary_no_supported_claims')} clusters left without a supported claim`);
    } else {
      lines.push('no LLM provider: summaries are extractive link lists');
    }
  }
  if (r.job === 'forget') {
    lines.push(
      `forget: ${c('eligible_notes')} notes considered; skipped ${c('skipped_pinned')} pinned, ${c('skipped_exempt_kind')} of an exempt kind, ${c('skipped_young')} too young, ` +
        `${c('skipped_recalled')} recalled within the window, ${c('skipped_no_history')} without enough recall history, ${c('skipped_cited')} cited by an accepted note, ${c('skipped_evidence_useful')} with a good evidence-linked outcome; ` +
        `${c('demote_candidates')} demote and ${c('archive_candidates')} archive candidates (${c('expired_journal')} expired journal entries)`,
      'nothing is deleted: demote sets status: stale, archive moves to _archive/; review each with: ebrain review show <id>',
    );
  }
  if (r.job === 'gaps') {
    lines.push(
      `gaps: ${c('queries')} logged queries (${c('queries_empty')} with no usable words) in ${c('clusters')} clusters; ${c('gap_clusters')} met cognition.gaps.minQueries and minPoorRate` +
        (c('groups_capped') > 0 ? `; ${c('groups_capped')} rarer query groups left out` : ''),
      'a gap proposal changes nothing; with no logged queries, enable queryLog.enabled and search for a while first',
    );
  }
  if (r.job === 'reflect') {
    lines.push(
      `reflect: ${c('groups')} closed theses/decisions with entries and outcomes (skipped ${c('skipped_thesis_unresolved')} unresolved theses, ${c('skipped_open_thesis')} open, ${c('skipped_no_outcome')} without an outcome); ${c('existing_lessons')} existing lessons`,
      `lessons: ${c('lessons_proposed')} proposed by the model, ${c('lessons_kept')} kept; dropped ${c('lessons_unresolved_citation')} with unresolved citations, ${c('lessons_foreign_citation')} citing outside their thesis, ` +
        `${c('lessons_missing_citation')} missing an entry/thesis/outcome citation, ${c('lessons_unsupported_number')} with unsupported numbers, ${c('lessons_guardrail_dropped')} by the guardrails, ` +
        `${c('lessons_scrub_rejected')} by the strict scrubber, ${c('lessons_duplicate')} duplicates, ${c('conflict_quote_unverified')} with an unverified conflict quote`,
      'lessons are advisory and unverified; review each with: ebrain review show <id>',
    );
  }
  if (c('skipped_provisional') > 0) lines.push(`${c('skipped_provisional')} notes have only a provisional id and were skipped; run: ebrain ids assign`);
  lines.push(`review with: ebrain review list`);
  return `${lines.join('\n')}\n`;
}

async function runCommand(args: readonly string[], opts: CognitionCommandOptions): Promise<CommandResult> {
  let jobName: string | undefined;
  let since: string | undefined;
  let maxProposals: number | undefined;
  let dryRun = false;
  let reconsider = false;
  let leaves = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--reconsider') reconsider = true;
    else if (a === DATA_LEAVES_MACHINE_FLAG) leaves = true;
    else if (a === '--since' || a === '--max-proposals') {
      const v = args[++i];
      if (v === undefined || v === '') return usage(`${a} needs a value`);
      if (a === '--since') {
        if (since !== undefined) return usage('--since given twice');
        if (!isIsoDate(v)) return usage('--since must be an ISO 8601 date');
        since = v;
      } else {
        if (maxProposals !== undefined) return usage('--max-proposals given twice');
        if (!/^[0-9]{1,5}$/.test(v) || Number(v) < 1 || Number(v) > MAX_PROPOSALS_CEILING) return usage(`--max-proposals must be an integer from 1 to ${MAX_PROPOSALS_CEILING}`);
        maxProposals = Number(v);
      }
    } else if (a.startsWith('-')) return usage(`unknown option ${JSON.stringify(a)}`);
    else if (jobName === undefined) jobName = a;
    else return usage(`unexpected argument ${JSON.stringify(a)}`);
  }
  if (jobName === undefined) return usage('missing <job>');
  const job = findJob(jobName);
  if (job === undefined) return usage(`unknown job ${JSON.stringify(jobName)}`);

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(opts);
  } catch (err) {
    return fail(`${err instanceof ConfigError ? 'config: ' : ''}${message(err)}`);
  }
  const { config } = loaded;
  let provider: ExtractionProvider | undefined;
  if (job.llm !== 'never') {
    try {
      provider = createProvider(config.llm, { allowedHosts: config.network.allowedHosts, env: opts.env ?? process.env, dataLeavesMachine: leaves });
    } catch (err) {
      if (err instanceof LlmRefusedError) return fail(err.message);
      throw err;
    }
  }
  let h: ReturnType<typeof openIndex>;
  let stateDir: ReturnType<typeof ensureStateDir>;
  try {
    stateDir = ensureStateDir(config);
    h = openIndex({ vaultPath: config.vaultPath, stateDir });
  } catch (err) {
    return fail(message(err));
  }
  let evidence: OpenEvidence | undefined;
  try {
    // Jobs that need ground truth get it only when an evidence file is configured and readable; runJob refuses otherwise.
    if (job.evidence !== undefined && discoverEvidence(config).some((f) => f.refused === undefined)) evidence = openEvidence({ config, stateDir });
    const r = await runJob({
      config, stateDir, index: h, job, dryRun, reconsider,
      ...(provider === undefined ? {} : { provider }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(since === undefined ? {} : { since, sinceMs: Date.parse(since) }),
      ...(maxProposals === undefined ? {} : { maxProposals }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    return { code: 0, stdout: summarize(r.record, r.created, config.inbox.maxPendingProposals), stderr: '' };
  } catch (err) {
    const known = err instanceof CognitionError || err instanceof SafePathError || err instanceof PromptFileError || err instanceof EvidenceError;
    return fail(known ? message(err) : `failed: ${message(err)}`);
  } finally {
    evidence?.close();
    closeIndex(h);
  }
}

function runsCommand(args: readonly string[], opts: CognitionCommandOptions): CommandResult {
  let n = 20;
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '-n' || !/^[0-9]{1,5}$/.test(args[1]!) || Number(args[1]) < 1) return usage('expected -n <count>');
    n = Number(args[1]);
  }
  try {
    const { config } = loadConfig(opts);
    const records = listRunRecords(ensureStateDir(config));
    const lines = records.slice(0, n).map((r) =>
      [r.run_id, r.job, `v${r.job_version}`, r.started, r.status, `${r.proposals.length} proposals`, `stop: ${r.stop_reason ?? '-'}`, r.options.dry_run ? 'dry-run' : ''].join('\t').trimEnd());
    lines.push(`${records.length} runs (records in <stateDir>/runs/)`);
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return fail(`${err instanceof ConfigError ? 'config: ' : ''}${message(err)}`);
  }
}

const STATS_TOP = 10;

function usageStats(opts: CognitionCommandOptions): CommandResult {
  let h: ReturnType<typeof openIndex> | undefined;
  let evidence: OpenEvidence | undefined;
  try {
    const { config } = loadConfig(opts);
    const stateDir = ensureStateDir(config);
    h = openIndex({ vaultPath: config.vaultPath, stateDir });
    refreshIndex(h);
    if (discoverEvidence(config).some((f) => f.refused === undefined)) evidence = openEvidence({ config, stateDir });
    const rows = rebuildNoteUsage(h.db, stateDir, evidence);
    const paths = new Map(allNoteRows(h.db).map((r) => [r.id, r.path]));
    const sum = (k: 'recalls' | 'reported_used' | 'evidence_linked_good' | 'evidence_linked_bad'): number => rows.reduce((a, r) => a + r[k], 0);
    const lines = [
      `usage stats: ${rows.length} notes recalled or reported`,
      `totals: ${sum('recalls')} recalls, ${sum('reported_used')} reported used (self-reported), ${sum('evidence_linked_good')} evidence-linked good, ${sum('evidence_linked_bad')} evidence-linked bad`,
      `evidence source: ${evidence === undefined ? 'none configured (nothing can be evidence-linked)' : 'local evidence'}`,
      `ranking: rank.usageBoost is ${config.rank.usageBoost ? 'on' : 'off'} (only evidence-linked counts can affect ranking; self-reported never)`,
    ];
    const top = [...rows]
      .sort((a, b) => b.evidence_linked_good - b.evidence_linked_bad - (a.evidence_linked_good - a.evidence_linked_bad) || b.reported_used - a.reported_used || b.recalls - a.recalls || (a.id < b.id ? -1 : 1))
      .slice(0, STATS_TOP);
    if (top.length > 0) {
      lines.push(`top ${top.length} (evidence-linked net, then reported used, then recalls):`);
      for (const r of top) {
        lines.push(`  ${paths.get(r.id) ?? r.id}: recalls ${r.recalls}; reported used ${r.reported_used} (self-reported); evidence-linked ${r.evidence_linked_good} good, ${r.evidence_linked_bad} bad`);
      }
    }
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return fail(`${err instanceof ConfigError ? 'config: ' : ''}${message(err)}`);
  } finally {
    evidence?.close();
    if (h !== undefined) closeIndex(h);
  }
}

function statsCommand(args: readonly string[], opts: CognitionCommandOptions): CommandResult {
  if (args[0] === 'usage' && args.length === 1) return usageStats(opts);
  if (args[0] !== 'forget' || args.length !== 1) return usage(args.length === 0 ? 'stats needs a report name (forget, usage)' : `unknown stats report ${JSON.stringify(args[0])} (expected: forget, usage)`);
  let h: ReturnType<typeof openIndex> | undefined;
  let evidence: OpenEvidence | undefined;
  try {
    const { config } = loadConfig(opts);
    const stateDir = ensureStateDir(config);
    h = openIndex({ vaultPath: config.vaultPath, stateDir });
    refreshIndex(h);
    if (discoverEvidence(config).some((f) => f.refused === undefined)) evidence = openEvidence({ config, stateDir });
    const a = analyzeForget({ config, index: h, stateDir, now: (opts.now ?? (() => new Date()))(), ...(evidence === undefined ? {} : { evidence }) });
    const c = (k: string): number => a.counts[k] ?? 0;
    const f = config.cognition.forget;
    const lines = [
      `forget stats: window ${f.windowDays} days, minimum age ${f.minAgeDays} days, exempt kinds: ${f.exemptKinds.join(', ') || '(none)'}`,
      `recall record starts: ${a.trackingStart ?? 'no records yet (never-recalled notes are not candidates)'}`,
      `notes considered: ${c('eligible_notes')}`,
      `skipped: ${c('skipped_pinned')} pinned, ${c('skipped_exempt_kind')} exempt kind, ${c('skipped_young')} too young, ${c('skipped_recalled')} recalled in the window, ` +
        `${c('skipped_no_history')} without enough recall history, ${c('skipped_cited')} cited by an accepted note, ${c('skipped_evidence_useful')} with a good evidence-linked outcome, ${c('skipped_provisional')} provisional id`,
      `candidates: ${c('demote_candidates')} demote, ${c('archive_candidates')} archive` +
        (config.journal.pruneRequiresReview ? ` (including ${c('expired_journal')} expired journal entries)` : ''),
    ];
    if (a.candidates.length > 0) {
      lines.push(`top ${Math.min(STATS_TOP, a.candidates.length)} (oldest last recall first; signal values, not scores):`);
      for (const k of a.candidates.slice(0, STATS_TOP)) lines.push(`  ${k.action} ${k.row.path}: ${describeSignals(k.signals)}`);
    }
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return fail(`${err instanceof ConfigError ? 'config: ' : ''}${message(err)}`);
  } finally {
    evidence?.close();
    if (h !== undefined) closeIndex(h);
  }
}

export async function runCognition(args: readonly string[], opts: CognitionCommandOptions = {}): Promise<CommandResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'run':
      return runCommand(rest, opts);
    case 'runs':
      return runsCommand(rest, opts);
    case 'stats':
      return statsCommand(rest, opts);
    default:
      return usage(sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
  }
}
