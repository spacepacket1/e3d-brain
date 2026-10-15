// `ebrain evidence import <file> [--name <n>]`, `ebrain evidence stats`, and
// `ebrain evidence reindex` (cognition Phase 3). Owner CLI only; none of these
// is an MCP tool, and they work in every instance mode (C11). Output carries
// counts and paths only, never record text.

import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { EvidenceError, evidenceStats, importEvidence, refreshEvidence, type EvidenceEnv } from '../evidence/store.js';
import { SKIP_REASONS, type LineCounts } from '../evidence/record.js';
import { SafePathError } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

export const EVIDENCE_USAGE = 'usage: ebrain evidence import <file> [--name <name>.jsonl] | ebrain evidence stats | ebrain evidence reindex';

export interface EvidenceCommandOptions extends EnvOptions {
  cwd?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain evidence: ${msg}\n${EVIDENCE_USAGE}\n` };
}

function skippedText(s: LineCounts['skipped']): string {
  const parts = SKIP_REASONS.filter((k) => s[k] > 0).map((k) => `${s[k]} ${k.replace('_', ' ')}`);
  return parts.length === 0 ? '0 skipped' : `skipped: ${parts.join(', ')}`;
}

function withEnv(opts: EvidenceCommandOptions, fn: (env: EvidenceEnv) => CommandResult): CommandResult {
  let env: EvidenceEnv;
  try {
    const { config } = loadConfig(opts);
    env = { config, stateDir: ensureStateDir(config) };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain evidence: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
  }
  try {
    return fn(env);
  } catch (err) {
    const known = err instanceof EvidenceError || err instanceof SafePathError;
    return { code: 1, stdout: '', stderr: `ebrain evidence: ${known ? message(err) : `failed: ${message(err)}`}\n` };
  }
}

export function runEvidence(args: readonly string[], opts: EvidenceCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'import': {
      let name: string | undefined;
      const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--name' || a.startsWith('--name=')) {
          if (name !== undefined) return usage('--name given twice');
          name = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i];
          if (name === undefined || name === '') return usage('--name needs a value');
        } else if (a.startsWith('--')) return usage(`unknown option ${JSON.stringify(a)}`);
        else positional.push(a);
      }
      if (positional.length !== 1) return usage(positional.length === 0 ? 'import needs a <file>' : 'import takes one <file>');
      return withEnv(opts, (env) => {
        const r = importEvidence(env, positional[0]!, { ...(name === undefined ? {} : { name }), ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) });
        const idx = refreshEvidence(env);
        const lines = [
          `evidence import: ${r.records} records written to ${r.path}${r.replaced ? ' (replaced the previous file)' : ''}`,
          `  ${r.lines} lines checked, ${skippedText(r.skipped)}${r.findings > 0 ? `, ${r.findings} redactions` : ''}`,
          `evidence index: ${idx.records} records from ${idx.files} files`,
        ];
        return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
      });
    }
    case 'stats':
    case 'reindex': {
      if (rest.length > 0) return usage(`unexpected argument ${JSON.stringify(rest[0])}`);
      return withEnv(opts, (env) => {
        if (sub === 'reindex') refreshEvidence(env, { force: true });
        const s = evidenceStats(env);
        const lines = s.files.map((f) =>
          f.refused !== null
            ? `${f.path}  [${f.origin}]  REFUSED: ${f.refused}`
            : `${f.path}  [${f.origin}]  ${f.records} records of ${f.lines} lines, ${skippedText(f.skipped)}, ${f.duplicates} duplicates replaced${f.findings > 0 ? `, ${f.findings} redactions` : ''}`);
        if (s.files.length === 0) lines.push('no evidence files (configure evidence.sources or run: ebrain evidence import <file>)');
        lines.push(`kinds: ${s.byKind.length === 0 ? '(none)' : s.byKind.map((k) => `${k.kind} ${k.count}`).join(', ')}`);
        lines.push(`evidence: ${s.records} records from ${s.files.length} files${sub === 'reindex' || s.rebuilt ? ' (index rebuilt)' : ''}`);
        return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
      });
    }
    default:
      return usage(sub === undefined ? 'missing subcommand' : `unknown subcommand ${JSON.stringify(sub)}`);
  }
}
