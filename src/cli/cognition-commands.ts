// `ebrain cognition run <job> [--since <date>] [--max-proposals N] [--dry-run]
// [--reconsider] [--i-understand-data-leaves-machine]` and `ebrain cognition
// runs [-n N]` (cognition Phase 2). Owner CLI only (C2): no MCP tool starts,
// schedules, or lists jobs. Works in every instance mode (C11): proposals go
// to `_inbox/` whatever the mode.

import { ConfigError, ensureStateDir, loadConfig, MAX_PROPOSALS_CEILING, type EnvOptions } from '../config.js';
import { findJob, JOBS } from '../cognition/jobs/index.js';
import { CognitionError, runJob } from '../cognition/run.js';
import { listRunRecords, type RunRecord } from '../cognition/runs.js';
import { PromptFileError } from '../cognition/prompts.js';
import { closeIndex, openIndex } from '../index/indexer.js';
import { createProvider, DATA_LEAVES_MACHINE_FLAG, LlmRefusedError, type ExtractionProvider } from '../llm/provider.js';
import { SafePathError } from '../safe-path.js';
import { isIsoDate } from '../vault/parse.js';
import type { CommandResult } from './index-commands.js';

export const COGNITION_USAGE = `usage: ebrain cognition run <job> [--since <date>] [--max-proposals <n>] [--dry-run] [--reconsider] [${DATA_LEAVES_MACHINE_FLAG}]
       ebrain cognition runs [-n <count>]
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
  try {
    const r = await runJob({
      config, stateDir, index: h, job, dryRun, reconsider,
      ...(provider === undefined ? {} : { provider }),
      ...(since === undefined ? {} : { since, sinceMs: Date.parse(since) }),
      ...(maxProposals === undefined ? {} : { maxProposals }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    return { code: 0, stdout: summarize(r.record, r.created, config.inbox.maxPendingProposals), stderr: '' };
  } catch (err) {
    const known = err instanceof CognitionError || err instanceof SafePathError || err instanceof PromptFileError;
    return fail(known ? message(err) : `failed: ${message(err)}`);
  } finally {
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

export async function runCognition(args: readonly string[], opts: CognitionCommandOptions = {}): Promise<CommandResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'run':
      return runCommand(rest, opts);
    case 'runs':
      return runsCommand(rest, opts);
    default:
      return usage(sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
  }
}
