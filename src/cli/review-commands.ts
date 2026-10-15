// `ebrain review list | show <id> | diff <id> | accept <id> | edit <id> |
// reject <id> [--reason <text>] | undo <id> | recover` (cognition Phase 2):
// the review queue for typed proposals. Owner CLI only; no MCP tool reviews,
// accepts, or applies anything (I2, C2). Works in every mode (C11). The
// memory-layer `ebrain inbox ...` commands stay as they are for ordinary notes.

import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { closeIndex, openIndex } from '../index/indexer.js';
import { inboxDir } from '../inbox/writer.js';
import {
  acceptQueued, editQueued, listQueue, recoverQueue, rejectQueued, ReviewError, showQueued, undoQueued, type ReviewQueueEnv,
} from '../review/queue.js';
import { SafePathError } from '../safe-path.js';
import { UndoError } from '../undo/store.js';
import type { CommandResult } from './index-commands.js';

export const REVIEW_USAGE = `usage: ebrain review list
       ebrain review show <id>
       ebrain review diff <id>
       ebrain review accept <id>
       ebrain review edit <id>
       ebrain review reject <id> [--reason <text>]
       ebrain review undo <id>
       ebrain review recover`;

export interface ReviewCommandOptions extends EnvOptions {
  now?: () => Date;
  /** Test hooks passed through to the queue (see ReviewQueueEnv). */
  afterPublish?: (index: number) => void;
  afterCommit?: () => void;
}

function usage(msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain review: ${msg}\n${REVIEW_USAGE}\n` };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NEEDS_ID = new Set(['show', 'diff', 'accept', 'edit', 'reject', 'undo']);

export function runReview(args: readonly string[], opts: ReviewCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  if (sub === undefined) return usage('missing subcommand');
  if (sub !== 'list' && sub !== 'recover' && !NEEDS_ID.has(sub)) return usage(`unknown subcommand ${JSON.stringify(sub)}`);
  let reason: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (sub === 'reject' && (a === '--reason' || a.startsWith('--reason='))) {
      if (reason !== undefined) return usage('--reason given twice');
      reason = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i];
      if (reason === undefined || reason === '') return usage('--reason needs a value');
    } else if (a.startsWith('--')) return usage(`unknown option ${JSON.stringify(a)}`);
    else positional.push(a);
  }
  if (NEEDS_ID.has(sub) ? positional.length !== 1 : positional.length !== 0) {
    return usage(NEEDS_ID.has(sub) ? `${sub} needs exactly one <id>` : `unexpected argument ${JSON.stringify(positional[0])}`);
  }
  const id = positional[0] ?? '';

  let h: ReturnType<typeof openIndex>;
  let env: ReviewQueueEnv;
  try {
    const { config } = loadConfig(opts);
    const stateDir = ensureStateDir(config);
    h = openIndex({ vaultPath: config.vaultPath, stateDir });
    env = {
      vaultPath: config.vaultPath, stateDir, index: h, editorEnv: opts.env ?? process.env,
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.afterPublish === undefined ? {} : { afterPublish: opts.afterPublish }),
      ...(opts.afterCommit === undefined ? {} : { afterCommit: opts.afterCommit }),
    };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain review: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
  }
  try {
    inboxDir(env.vaultPath);
    switch (sub) {
      case 'list': {
        const items = listQueue(env);
        if (items.length === 0) return { code: 0, stdout: 'review: no typed proposals waiting\n', stderr: '' };
        const lines = items.map((p) => [
          p.id, p.invalid !== undefined ? 'INVALID' : p.status, p.type, p.job, p.authenticated ? 'authenticated' : 'UNAUTHENTICATED',
          p.untrusted ? 'UNTRUSTED' : '-', p.path, p.invalid ?? p.title,
        ].join('\t'));
        return { code: 0, stdout: `${['id', 'status', 'type', 'job', 'auth', 'taint', 'path', 'title'].join('\t')}\n${lines.join('\n')}\n`, stderr: '' };
      }
      case 'show':
        return { code: 0, stdout: showQueued(env, id), stderr: '' };
      case 'diff':
        return { code: 0, stdout: showQueued(env, id, { diffOnly: true }), stderr: '' };
      case 'accept': {
        const r = acceptQueued(env, id);
        if (r.outcome === 'stale') {
          return { code: 1, stdout: '', stderr: `ebrain review: stale: proposal ${id} was not applied (marked stale): ${r.reasons.join('; ')}. Reject it and re-run the job.\n` };
        }
        if (r.outcome === 'already') return { code: 0, stdout: `accept ${id}: nothing to do (already applied: ${r.to})\n`, stderr: '' };
        const lines = r.changes.map((c) => (c.kind === 'move' ? `moved ${c.from} -> ${c.path}` : `${c.kind === 'create' ? 'created' : 'edited'} ${c.path}`));
        lines.push(
          r.outcome === 'recovered' ? `accept ${id}: finished an interrupted accept (operation ${r.operationId}); proposal at ${r.to}` : `accept ${id}: applied; proposal at ${r.to}`,
        );
        if (r.operationId !== '') lines.push(`undo with: ebrain review undo ${id}`);
        return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
      }
      case 'edit': {
        const r = editQueued(env, id);
        return { code: 0, stdout: r.changed ? `edit ${id}: saved (still proposed)\n` : `edit ${id}: no changes\n`, stderr: '' };
      }
      case 'reject': {
        const r = rejectQueued(env, id, reason);
        return { code: 0, stdout: `reject ${id}: moved to ${r.to}; key ${r.key} remembered (re-runs skip it unless --reconsider)\n`, stderr: '' };
      }
      case 'undo': {
        const r = undoQueued(env, id);
        return { code: 0, stdout: `undo ${id}: restored ${r.restored} files${r.operationId === '' ? '' : ` (operation ${r.operationId})`}; proposal back at ${r.to}\n`, stderr: '' };
      }
      default: {
        const r = recoverQueue(env);
        return { code: 0, stdout: `review recover: ${r.rolledBack.length} pending operations rolled back, ${r.finalized.length} interrupted accepts finished\n`, stderr: '' };
      }
    }
  } catch (err) {
    const known = err instanceof ReviewError || err instanceof SafePathError || err instanceof UndoError;
    return { code: 1, stdout: '', stderr: `ebrain review: ${known ? message(err) : `failed: ${message(err)}`}\n` };
  } finally {
    closeIndex(h);
  }
}
