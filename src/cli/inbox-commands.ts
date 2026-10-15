// `ebrain inbox list | show <id> | accept <id> [--to <folder>] [--edit] |
// reject <id> [--reason <text>]` (Phase 8): the owner's review gate. CLI
// only; there is no MCP tool for any of this (I2). Works in every mode.

import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { openInEditor } from '../exec/editor.js';
import { acceptProposal, rejectProposal, ReviewError, showProposal, listProposals, type MoveResult, type ReviewEnv } from '../inbox/review.js';
import { inboxDir } from '../inbox/writer.js';
import { closeIndex, openIndex } from '../index/indexer.js';
import { resolveInVault, SafePathError } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

export const INBOX_USAGE = `usage: ebrain inbox list
       ebrain inbox show <id>
       ebrain inbox accept <id> [--to <folder>] [--edit]
       ebrain inbox reject <id> [--reason <text>]`;

export interface InboxCommandOptions extends EnvOptions {
  /** Test hook passed through to accept/reject (see ReviewEnv). */
  afterDestinationWrite?: () => void;
  now?: () => Date;
}

function usage(msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain inbox: ${msg}\n${INBOX_USAGE}\n` };
}

function parseFlags(args: readonly string[], allowed: Record<string, 'value' | 'bool'>): { positional: string[]; flags: Record<string, string | true> } | string {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const kind = allowed[name];
    if (kind === undefined) return `unknown option ${JSON.stringify(arg)}`;
    if (flags[name] !== undefined) return `${name} given twice`;
    if (kind === 'bool') {
      if (eq > 0) return `${name} takes no value`;
      flags[name] = true;
    } else {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === '') return `${name} needs a value`;
      flags[name] = value;
    }
  }
  return { positional, flags };
}

function describe(verb: string, r: MoveResult): string {
  switch (r.outcome) {
    case 'moved':
      return `${verb} ${r.id}: ${r.from} -> ${r.to}\n`;
    case 'recovered':
      return `${verb} ${r.id}: completed an interrupted ${verb} (${r.to} exists; removed ${r.from})\n`;
    case 'already':
      return `${verb} ${r.id}: nothing to do (already at ${r.to})\n`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function runInbox(args: readonly string[], opts: InboxCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  let parsed: ReturnType<typeof parseFlags>;
  switch (sub) {
    case 'list':
      parsed = parseFlags(rest, {});
      if (typeof parsed !== 'string' && parsed.positional.length > 0) parsed = `unexpected argument ${JSON.stringify(parsed.positional[0])}`;
      break;
    case 'show':
      parsed = parseFlags(rest, {});
      break;
    case 'accept':
      parsed = parseFlags(rest, { '--to': 'value', '--edit': 'bool' });
      break;
    case 'reject':
      parsed = parseFlags(rest, { '--reason': 'value' });
      break;
    default:
      return usage(sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
  }
  if (typeof parsed === 'string') return usage(parsed);
  const { positional, flags } = parsed;
  if (sub !== 'list' && positional.length !== 1) return usage(`${sub} needs exactly one <id>`);
  const id = positional[0] ?? '';

  let h: ReturnType<typeof openIndex>;
  let env: ReviewEnv;
  try {
    const { config } = loadConfig(opts);
    h = openIndex({ vaultPath: config.vaultPath, stateDir: ensureStateDir(config) });
    env = { vaultPath: config.vaultPath, index: h };
    if (opts.now !== undefined) env.now = opts.now;
    if (opts.afterDestinationWrite !== undefined) env.afterDestinationWrite = opts.afterDestinationWrite;
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain inbox: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
  }
  try {
    // _inbox/ exists in every vault, whatever the mode.
    inboxDir(env.vaultPath);
    switch (sub) {
      case 'list': {
        const items = listProposals(env);
        if (items.length === 0) return { code: 0, stdout: 'inbox: no proposals\n', stderr: '' };
        const lines = items.map((p) =>
          [p.id + (p.provisional ? ' (provisional)' : ''), p.created ?? '-', p.kind ?? '-', p.author ?? '-', p.path, p.title].join('\t'));
        return { code: 0, stdout: `${['id', 'created', 'kind', 'author', 'path', 'title'].join('\t')}\n${lines.join('\n')}\n`, stderr: '' };
      }
      case 'show': {
        const note = showProposal(env, id);
        return { code: 0, stdout: `path: ${note.path}\n\n${note.text}${note.text.endsWith('\n') ? '' : '\n'}`, stderr: '' };
      }
      case 'accept': {
        const r = acceptProposal(env, id, typeof flags['--to'] === 'string' ? { to: flags['--to'] } : {});
        let out = describe('accept', r);
        if (flags['--edit'] === true) {
          const edited = openInEditor(resolveInVault(env.vaultPath, r.to));
          if ('error' in edited) return { code: 1, stdout: out, stderr: `ebrain inbox: accepted, but --edit failed: ${edited.error}\n` };
          if (edited.status !== 0) return { code: 1, stdout: out, stderr: `ebrain inbox: accepted, but the editor exited ${edited.status}\n` };
          out += `edited ${r.to}\n`;
        }
        return { code: 0, stdout: out, stderr: '' };
      }
      default: {
        const r = rejectProposal(env, id, typeof flags['--reason'] === 'string' ? { reason: flags['--reason'] } : {});
        return { code: 0, stdout: describe('reject', r), stderr: '' };
      }
    }
  } catch (err) {
    const known = err instanceof ReviewError || err instanceof SafePathError;
    return { code: 1, stdout: '', stderr: `ebrain inbox: ${known ? message(err) : `failed: ${message(err)}`}\n` };
  } finally {
    closeIndex(h);
  }
}
