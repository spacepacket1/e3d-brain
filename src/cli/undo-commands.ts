// `ebrain ids assign [--folder <f>] [--dry-run]`, `ebrain undo <operation-id>`,
// `ebrain undo --list`, and `ebrain recalls prune [--older-than <days>]`, and `ebrain queries prune [--older-than <days>]`
// (cognition Phase 1). Owner CLI only; none of these is an MCP tool (I2), and
// they work in every instance mode (C11).

import { ConfigError, ensureStateDir, loadConfig, type Config, type EnvOptions } from '../config.js';
import { assignIds } from '../ids/assign.js';
import { pruneQueries } from '../recall/queries.js';
import { pruneRecalls } from '../recall/recalls.js';
import { SafePathError, type SafePath } from '../safe-path.js';
import { listOperations, restore, UndoError } from '../undo/store.js';
import type { CommandResult } from './index-commands.js';

export const IDS_USAGE = 'usage: ebrain ids assign [--folder <f>] [--dry-run]';
export const UNDO_USAGE = 'usage: ebrain undo <operation-id> | ebrain undo --list';
export const QUERIES_USAGE = 'usage: ebrain queries prune [--older-than <days>]';
export const RECALLS_USAGE = 'usage: ebrain recalls prune [--older-than <days>]';

export interface UndoCommandOptions extends EnvOptions {
  now?: () => Date;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(cmd: string, text: string, msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain ${cmd}: ${msg}\n${text}\n` };
}

function withConfig(cmd: string, opts: UndoCommandOptions, fn: (config: Config, stateDir: SafePath) => CommandResult): CommandResult {
  let config: Config;
  let stateDir: SafePath;
  try {
    config = loadConfig(opts).config;
    stateDir = ensureStateDir(config);
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain ${cmd}: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
  }
  try {
    return fn(config, stateDir);
  } catch (err) {
    const known = err instanceof UndoError || err instanceof SafePathError;
    return { code: 1, stdout: '', stderr: `ebrain ${cmd}: ${known ? message(err) : `failed: ${message(err)}`}\n` };
  }
}

export function runIds(args: readonly string[], opts: UndoCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  if (sub !== 'assign') return usage('ids', IDS_USAGE, sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
  let folder: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--folder' || a.startsWith('--folder=')) {
      if (folder !== undefined) return usage('ids', IDS_USAGE, '--folder given twice');
      folder = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i];
      if (folder === undefined || folder === '') return usage('ids', IDS_USAGE, '--folder needs a value');
    } else return usage('ids', IDS_USAGE, `unexpected argument ${JSON.stringify(a)}`);
  }
  return withConfig('ids', opts, (config, stateDir) => {
    const r = assignIds({
      vaultPath: config.vaultPath,
      stateDir,
      dryRun,
      ...(folder === undefined ? {} : { folder }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    const verb = dryRun ? 'would assign' : 'assigned';
    const lines = r.assigned.map((a) => (dryRun ? `${verb} ${a.path}` : `${verb} ${a.id} ${a.path} (was ${a.previous})`));
    lines.push(...r.skipped.map((s) => `skipped ${s.path}: ${s.reason}`));
    lines.push(`ids assign: ${r.assigned.length} ${verb}, ${r.skipped.length} skipped${dryRun ? ' (dry run: nothing written)' : ''}`);
    if (r.operationId !== undefined) lines.push(`undo with: ebrain undo ${r.operationId}`);
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  });
}

export function runUndo(args: readonly string[], opts: UndoCommandOptions = {}): CommandResult {
  if (args.length !== 1) return usage('undo', UNDO_USAGE, args.length === 0 ? 'missing operation id' : 'expected one argument');
  const arg = args[0]!;
  if (arg.startsWith('-') && arg !== '--list') return usage('undo', UNDO_USAGE, `unknown option ${JSON.stringify(arg)}`);
  return withConfig('undo', opts, (config, stateDir) => {
    const env = { vaultPath: config.vaultPath, stateDir };
    if (arg === '--list') {
      const ops = listOperations(env);
      const lines = ops.map((m) => `${m.operation_id}  ${m.created}  ${m.status.padEnd(11)}  ${m.command}  (${m.ops.length} ops)`);
      lines.push(`${ops.length} undo operations (machine-local, under <stateDir>/undo/)`);
      return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    const m = restore(env, arg);
    return { code: 0, stdout: `undo ${m.operation_id}: restored ${m.ops.length} files (${m.command})\n`, stderr: '' };
  });
}

export function runRecalls(args: readonly string[], opts: UndoCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  if (sub !== 'prune') return usage('recalls', RECALLS_USAGE, sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
  let days: number | undefined;
  if (rest.length > 0) {
    if (rest.length !== 2 || rest[0] !== '--older-than' || !/^[0-9]{1,5}$/.test(rest[1]!) || Number(rest[1]) < 1) {
      return usage('recalls', RECALLS_USAGE, 'expected --older-than <days> (a positive integer)');
    }
    days = Number(rest[1]);
  }
  return withConfig('recalls', opts, (config, stateDir) => {
    const retention = days ?? config.recallLog.retentionDays;
    const r = pruneRecalls(stateDir, retention, opts.now?.() ?? new Date());
    return { code: 0, stdout: `recalls prune: kept ${r.kept}, removed ${r.removed} (older than ${retention} days)\n`, stderr: '' };
  });
}

export function runQueries(args: readonly string[], opts: UndoCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  if (sub !== 'prune') return usage('queries', QUERIES_USAGE, sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
  let days: number | undefined;
  if (rest.length > 0) {
    if (rest.length !== 2 || rest[0] !== '--older-than' || !/^[0-9]{1,5}$/.test(rest[1]!) || Number(rest[1]) < 1) {
      return usage('queries', QUERIES_USAGE, 'expected --older-than <days> (a positive integer)');
    }
    days = Number(rest[1]);
  }
  return withConfig('queries', opts, (config, stateDir) => {
    const retention = days ?? config.queryLog.retentionDays;
    const r = pruneQueries(stateDir, retention, opts.now?.() ?? new Date());
    return { code: 0, stdout: `queries prune: kept ${r.kept}, removed ${r.removed} (older than ${retention} days)\n`, stderr: '' };
  });
}
