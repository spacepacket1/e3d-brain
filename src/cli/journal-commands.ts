// `ebrain journal prune [--dry-run]` and `ebrain import agent-workspace <dir>
// --principal <id>` (Phase 9): owner CLI only; neither is an MCP tool (I2).

import * as path from 'node:path';
import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { JOURNAL_PRUNE_JOB } from '../cognition/jobs/forget.js';
import { CognitionError, runJob } from '../cognition/run.js';
import { closeIndex, openIndex } from '../index/indexer.js';
import { importAgentWorkspace } from '../journal/import.js';
import { pruneJournal } from '../journal/prune.js';
import { SafePathError } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

export const JOURNAL_USAGE = `usage: ebrain journal prune [--dry-run]`;
export const IMPORT_USAGE = `usage: ebrain import agent-workspace <dir> --principal <id>
       ebrain import claude-code|claude-export|chatgpt-export ... (see ebrain --help)`;

export interface JournalCommandOptions extends EnvOptions {
  now?: () => Date;
  /** Base for a relative <dir> (default: the process working directory). */
  cwd?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configError(cmd: string, err: unknown): CommandResult {
  return { code: 1, stdout: '', stderr: `ebrain ${cmd}: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
}

/** `journal.pruneRequiresReview`: expired entries become `archive` proposals (the `forget` mechanism); nothing moves until `ebrain review accept`. */
async function pruneForReview(config: ReturnType<typeof loadConfig>['config'], dryRun: boolean, opts: JournalCommandOptions): Promise<CommandResult> {
  let h: ReturnType<typeof openIndex> | undefined;
  try {
    const stateDir = ensureStateDir(config);
    h = openIndex({ vaultPath: config.vaultPath, stateDir });
    const r = await runJob({ config, stateDir, index: h, job: JOURNAL_PRUNE_JOB, dryRun, ...(opts.now === undefined ? {} : { now: opts.now }) });
    const c = (k: string): number => r.record.counts[k] ?? 0;
    const lines = r.created.map((p) => `proposed archive ${p.id} ${p.path}`);
    lines.push(
      `journal prune: ${dryRun ? `${c('would_create')} would be proposed` : `${c('created')} archive proposals created`}, ${c('duplicates')} already in _inbox/, ` +
        `${c('rejected_skipped')} previously rejected (journal.pruneRequiresReview is true: nothing moves until reviewed; nothing is ever deleted)`,
    );
    if (c('created') > 0) lines.push('review with: ebrain review list');
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain journal: ${err instanceof SafePathError || err instanceof CognitionError ? message(err) : `failed: ${message(err)}`}\n` };
  } finally {
    if (h !== undefined) closeIndex(h);
  }
}

export async function runJournal(args: readonly string[], opts: JournalCommandOptions = {}): Promise<CommandResult> {
  const [sub, ...rest] = args;
  if (sub !== 'prune') {
    return { code: 2, stdout: '', stderr: `ebrain journal: ${sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`}\n${JOURNAL_USAGE}\n` };
  }
  const extra = rest.filter((a) => a !== '--dry-run');
  if (extra.length > 0 || rest.length > 1) return { code: 2, stdout: '', stderr: `ebrain journal: unexpected argument ${JSON.stringify(extra[0] ?? rest[1])}\n${JOURNAL_USAGE}\n` };
  const dryRun = rest.includes('--dry-run');
  let config: ReturnType<typeof loadConfig>['config'];
  try {
    config = loadConfig(opts).config;
  } catch (err) {
    return configError('journal', err);
  }
  const vaultPath = config.vaultPath;
  if (config.journal.pruneRequiresReview) return pruneForReview(config, dryRun, opts);
  try {
    const r = pruneJournal(vaultPath, { dryRun, ...(opts.now === undefined ? {} : { now: opts.now() }) });
    const verb = dryRun ? 'would archive' : 'archived';
    const lines = r.archived.map((a) => `${verb} ${a.from} -> ${a.to} (expired ${a.expires})`);
    lines.push(...r.skipped.map((s) => `skipped ${s.path}: ${s.reason}`));
    lines.push(`journal prune: ${r.archived.length} ${verb}, ${r.skipped.length} skipped (nothing is ever deleted)`);
    return { code: r.skipped.length > 0 ? 1 : 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain journal: ${err instanceof SafePathError ? message(err) : `failed: ${message(err)}`}\n` };
  }
}

export function runImport(args: readonly string[], opts: JournalCommandOptions = {}): CommandResult {
  const usage = (msg: string): CommandResult => ({ code: 2, stdout: '', stderr: `ebrain import: ${msg}\n${IMPORT_USAGE}\n` });
  const [sub, ...rest] = args;
  if (sub !== 'agent-workspace') return usage(sub === undefined ? 'missing source type' : `unknown source type ${JSON.stringify(sub)}`);
  const positional: string[] = [];
  let principal: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--principal' || a.startsWith('--principal=')) {
      if (principal !== undefined) return usage('--principal given twice');
      principal = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i];
      if (principal === undefined || principal === '') return usage('--principal needs a value');
    } else if (a.startsWith('--')) {
      return usage(`unknown option ${JSON.stringify(a)}`);
    } else positional.push(a);
  }
  if (positional.length !== 1) return usage('needs exactly one <dir>');
  if (principal === undefined) return usage('--principal <id> is required');

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(opts);
  } catch (err) {
    return configError('import', err);
  }
  const { config } = loaded;
  if (principal !== config.principal.id) {
    return { code: 1, stdout: '', stderr: `ebrain import: --principal ${JSON.stringify(principal)} does not match the configured principal; refusing\n` };
  }
  try {
    const dir = path.resolve(opts.cwd ?? process.cwd(), positional[0]!);
    const r = importAgentWorkspace(dir, {
      vaultPath: config.vaultPath,
      stateDir: ensureStateDir(config),
      principalId: config.principal.id,
      extraPatterns: config.scrub.extraPatterns,
      ...(opts.now === undefined ? {} : { now: opts.now() }),
    });
    const lines = [
      ...r.imported.map((x) => `imported ${x.source} -> ${x.path}`),
      ...r.unchanged.map((x) => `unchanged ${x.source} (already at ${x.path})`),
      ...r.skipped.map((x) => `skipped ${x.source}: ${x.reason}`),
      `import agent-workspace: ${r.imported.length} imported, ${r.unchanged.length} unchanged, ${r.skipped.length} skipped`,
    ];
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain import: ${err instanceof SafePathError ? message(err) : `failed: ${message(err)}`}\n` };
  }
}
