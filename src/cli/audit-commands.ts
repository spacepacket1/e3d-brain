// `ebrain audit tail [-n N]`, `ebrain audit stats`, `ebrain audit prune --older-than <days>`.
// Readers go through every segment in numeric order; prune deletes whole old
// segments only (never the current one, never a partial segment).

import { auditStats, pruneAudit, tailAudit } from '../audit/audit.js';
import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import type { SafePath } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

const USAGE = 'usage: ebrain audit tail [-n N] | stats | prune --older-than <days>\n';
const DEFAULT_TAIL = 20;

function usage(): CommandResult {
  return { code: 2, stdout: '', stderr: USAGE };
}

function positiveInt(v: string | undefined, allowZero: boolean): number | undefined {
  if (v === undefined || !/^[0-9]{1,9}$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 || (allowZero && n === 0) ? n : undefined;
}

function withState(opts: EnvOptions, fn: (stateDir: SafePath) => string): CommandResult {
  let stateDir: SafePath;
  try {
    stateDir = ensureStateDir(loadConfig(opts).config);
  } catch (err) {
    const prefix = err instanceof ConfigError ? 'config: ' : '';
    return { code: 1, stdout: '', stderr: `${prefix}${err instanceof Error ? err.message : String(err)}\n` };
  }
  try {
    return { code: 0, stdout: fn(stateDir), stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `${err instanceof Error ? err.message : String(err)}\n` };
  }
}

function counts(m: Record<string, number>): string {
  const keys = Object.keys(m);
  return keys.length === 0 ? '(none)' : keys.map((k) => `${k}=${m[k]}`).join(' ');
}

export function runAudit(args: readonly string[], opts: EnvOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'tail': {
      let n = DEFAULT_TAIL;
      if (rest.length > 0) {
        const parsed = rest.length === 2 && rest[0] === '-n' ? positiveInt(rest[1], false) : undefined;
        if (parsed === undefined) return usage();
        n = parsed;
      }
      return withState(opts, (dir) => {
        const lines = tailAudit(dir, n);
        return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
      });
    }
    case 'stats': {
      if (rest.length > 0) return usage();
      return withState(opts, (dir) => {
        const s = auditStats(dir);
        const out = [`segments: ${s.segments.length}`];
        for (const seg of s.segments) out.push(`  ${seg.name}: ${seg.lines} lines, ${seg.bytes} bytes`);
        out.push(`lines: ${s.lines}`, `malformed: ${s.malformed}`);
        out.push(`first: ${s.first ?? '-'}`, `last: ${s.last ?? '-'}`);
        out.push(`by outcome: ${counts(s.byOutcome)}`, `by tool: ${counts(s.byTool)}`, `by principal: ${counts(s.byPrincipal)}`);
        return `${out.join('\n')}\n`;
      });
    }
    case 'prune': {
      const days = rest.length === 2 && rest[0] === '--older-than' ? positiveInt(rest[1], true) : undefined;
      if (days === undefined) return usage();
      return withState(opts, (dir) => {
        const deleted = pruneAudit(dir, days);
        return `pruned ${deleted.length} segment(s)${deleted.length > 0 ? `: ${deleted.join(' ')}` : ''}\n`;
      });
    }
    default:
      return usage();
  }
}
