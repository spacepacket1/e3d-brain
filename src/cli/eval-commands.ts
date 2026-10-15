// `ebrain eval replay --job <job> --at <commit-or-date> [--max-proposals N]
// [--i-understand-data-leaves-machine]` (cognition Phase 9). Owner CLI only
// (C2). Writes nothing to the vault or to the owner's state directory; see
// src/eval/replay.ts. Without a usable git history it exits 1 with a message
// that only online metrics (`ebrain cognition report`) are available.

import { ConfigError, ensureStateDir, loadConfig, MAX_PROPOSALS_CEILING, type EnvOptions } from '../config.js';
import { findJob, JOBS } from '../cognition/jobs/index.js';
import { CognitionError } from '../cognition/run.js';
import { PromptFileError } from '../cognition/prompts.js';
import { formatReplay, replay, ReplayError, ReplayUnavailable } from '../eval/replay.js';
import { TarError } from '../eval/tar.js';
import { EvidenceError } from '../evidence/store.js';
import { GitError } from '../exec/git.js';
import { createProvider, DATA_LEAVES_MACHINE_FLAG, LlmRefusedError, type ExtractionProvider } from '../llm/provider.js';
import { SafePathError } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

export const EVAL_USAGE = `usage: ebrain eval replay --job <job> --at <commit|date> [--max-proposals <n>] [${DATA_LEAVES_MACHINE_FLAG}]
jobs: ${JOBS.map((j) => j.name).join(', ')}`;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain eval: ${msg}\n${EVAL_USAGE}\n` };
}

function fail(msg: string): CommandResult {
  return { code: 1, stdout: '', stderr: `ebrain eval: ${msg}\n` };
}

async function replayCommand(args: readonly string[], opts: EnvOptions): Promise<CommandResult> {
  let jobName: string | undefined;
  let at: string | undefined;
  let maxProposals: number | undefined;
  let leaves = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === DATA_LEAVES_MACHINE_FLAG) leaves = true;
    else if (a === '--job' || a === '--at' || a === '--max-proposals') {
      const v = args[++i];
      if (v === undefined || v === '') return usage(`${a} needs a value`);
      if (a === '--job') {
        if (jobName !== undefined) return usage('--job given twice');
        jobName = v;
      } else if (a === '--at') {
        if (at !== undefined) return usage('--at given twice');
        if (v.startsWith('-')) return usage('--at must be a commit or an ISO 8601 date');
        at = v;
      } else {
        if (maxProposals !== undefined) return usage('--max-proposals given twice');
        if (!/^[0-9]{1,5}$/.test(v) || Number(v) < 1 || Number(v) > MAX_PROPOSALS_CEILING) return usage(`--max-proposals must be an integer from 1 to ${MAX_PROPOSALS_CEILING}`);
        maxProposals = Number(v);
      }
    } else return usage(`unexpected argument ${JSON.stringify(a)}`);
  }
  if (jobName === undefined) return usage('missing --job');
  if (at === undefined) return usage('missing --at');
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
  try {
    const r = await replay({
      config, job, at, ownerStateDir: ensureStateDir(config), git: { env: opts.env ?? process.env },
      ...(provider === undefined ? {} : { provider }),
      ...(maxProposals === undefined ? {} : { maxProposals }),
    });
    return { code: 0, stdout: formatReplay(r), stderr: '' };
  } catch (err) {
    if (err instanceof ReplayUnavailable) return fail(err.message);
    const known = err instanceof ReplayError || err instanceof CognitionError || err instanceof GitError || err instanceof TarError ||
      err instanceof SafePathError || err instanceof PromptFileError || err instanceof EvidenceError;
    return fail(known ? message(err) : `failed: ${message(err)}`);
  }
}

export async function runEval(args: readonly string[], opts: EnvOptions = {}): Promise<CommandResult> {
  const [sub, ...rest] = args;
  if (sub === 'replay') return replayCommand(rest, opts);
  return usage(sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
}
