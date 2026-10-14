// `ebrain hook session-start | pre-compact | install | remove` (Phase 13).
//
// session-start and pre-compact run inside a Claude Code session, so they
// fail open: whatever goes wrong (bad stdin, missing config, unreadable
// transcript, a vault error) the result is exit 0 and, at worst, no output.
// Configuration comes only from the user-level config file (`loadConfig`);
// the hook JSON's `cwd` and any project-local file are never consulted.

import { loadConfig, ensureStateDir, type EnvOptions } from '../config.js';
import { writeCheckpoint } from '../hooks/checkpoint.js';
import { buildBrief } from '../hooks/brief.js';
import { HookInstallError, installHooks, removeHooks } from '../hooks/install.js';
import { closeIndex, openIndex } from '../index/indexer.js';
import { readStdinSafe, SafePathError } from '../safe-path.js';
import { entryPoint, shellQuote } from './init.js';
import type { CommandResult } from './index-commands.js';

export const HOOK_USAGE = `usage: ebrain hook session-start
       ebrain hook pre-compact
       ebrain hook install
       ebrain hook remove`;

/** Largest hook payload read from stdin. */
export const MAX_HOOK_STDIN_BYTES = 1024 * 1024;

export interface HookCommandOptions extends EnvOptions {
  /** Test hook: the hook JSON (default: standard input). */
  stdin?: () => Buffer;
  now?: () => Date;
  /** Test hook: the node binary and ebrain script written by `install`. */
  entry?: { node: string; script: string };
}

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

/** The hook JSON object, or undefined when stdin is empty, malformed, oversized, or not an object. */
function readPayload(opts: HookCommandOptions): Record<string, unknown> | undefined {
  try {
    if (opts.stdin === undefined && process.stdin.isTTY) return undefined;
    const data = (opts.stdin ?? (() => readStdinSafe(MAX_HOOK_STDIN_BYTES)))();
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function sessionStart(opts: HookCommandOptions): CommandResult {
  if (readPayload(opts) === undefined) return OK;
  const { config } = loadConfig(opts);
  const index = openIndex({ vaultPath: config.vaultPath, stateDir: ensureStateDir(config) });
  try {
    const stdout = buildBrief({ index, hooks: config.hooks, maxChars: config.limits.maxCharsPerCall, ...(opts.now === undefined ? {} : { now: opts.now }) });
    return { code: 0, stdout, stderr: '' };
  } finally {
    closeIndex(index);
  }
}

function preCompact(opts: HookCommandOptions): CommandResult {
  const payload = readPayload(opts);
  if (payload === undefined) return OK;
  const { config } = loadConfig(opts);
  // Writing hooks need mode inbox and an explicit opt-in.
  if (config.mode !== 'inbox' || config.hooks.captureCheckpoints !== true) return OK;
  writeCheckpoint({
    vaultPath: config.vaultPath,
    principalId: config.principal.id,
    extraPatterns: config.scrub.extraPatterns,
    projectsDir: config.hooks.claudeProjectsDir,
    transcriptPath: payload['transcript_path'],
    sessionId: payload['session_id'],
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return OK;
}

function failClosedMessage(err: unknown): string {
  return err instanceof HookInstallError || err instanceof SafePathError ? err.message : `failed: ${err instanceof Error ? err.message : String(err)}`;
}

export function runHook(args: readonly string[], opts: HookCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'session-start':
    case 'pre-compact':
      // The only extra argument is the ownership tag `install` appends.
      try {
        return sub === 'session-start' ? sessionStart(opts) : preCompact(opts);
      } catch {
        return OK;
      }
    case 'install':
    case 'remove': {
      if (rest.length > 0) return { code: 2, stdout: '', stderr: `ebrain hook ${sub}: unexpected argument ${JSON.stringify(rest[0])}\n${HOOK_USAGE}\n` };
      try {
        if (sub === 'install') {
          const r = installHooks(opts.entry ?? entryPoint(), shellQuote, opts.homeDir);
          return { code: 0, stdout: `installed ${r.commands.length} hooks in ${r.file}\n${r.commands.map((c) => `  ${c}\n`).join('')}`, stderr: '' };
        }
        const r = removeHooks(opts.homeDir);
        return { code: 0, stdout: `removed ${r.removed} ebrain hook(s) from ${r.file}\n`, stderr: '' };
      } catch (err) {
        return { code: 1, stdout: '', stderr: `ebrain hook ${sub}: ${failClosedMessage(err)}\n` };
      }
    }
    default:
      return { code: 2, stdout: '', stderr: `ebrain hook: ${sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`}\n${HOOK_USAGE}\n` };
  }
}
