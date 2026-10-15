// `ebrain sync [<mirror>...] [--dry-run]`, `ebrain mirrors list`, and `ebrain mirrors status [<mirror>...]`.
// Owner CLI only (none of these is an MCP tool); they need a human principal with `mirrors` in the config. Output carries
// counts and paths only, never note text.

import { ConfigError, ensureStateDir, loadConfig, type Config, type EnvOptions, type MirrorConfig } from '../config.js';
import { mirrorStatus, syncMirror, MirrorError, SKIP_REASONS, type MirrorEnv, type MirrorReport } from '../mirror/sync.js';
import { SafePathError } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

export const MIRROR_USAGE = 'usage: ebrain sync [<mirror>...] [--dry-run] | ebrain mirrors list | ebrain mirrors status [<mirror>...]';
const MAX_LISTED = 20;

export interface MirrorCommandOptions extends EnvOptions {
  now?: () => Date;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function usage(cmd: string, msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain ${cmd}: ${msg}\n${MIRROR_USAGE}\n` };
}

function load(cmd: string, opts: MirrorCommandOptions): { env: MirrorEnv; config: Config } | CommandResult {
  try {
    const { config } = loadConfig(opts);
    if (config.mirrors.length === 0) {
      return { code: 1, stdout: '', stderr: `ebrain ${cmd}: no mirrors configured (add a "mirrors" array to the config; see docs/SETUP.md)\n` };
    }
    return { env: { config, stateDir: ensureStateDir(config), ...(opts.now === undefined ? {} : { now: opts.now }) }, config };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain ${cmd}: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
  }
}

function pick(config: Config, names: readonly string[]): MirrorConfig[] | string {
  if (names.length === 0) return config.mirrors;
  const out: MirrorConfig[] = [];
  for (const n of names) {
    const m = config.mirrors.find((x) => x.name === n);
    if (m === undefined) return `unknown mirror "${n}" (configured: ${config.mirrors.map((x) => x.name).join(', ')})`;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function listSome(items: readonly string[], indent = '    '): string[] {
  const lines = items.slice(0, MAX_LISTED).map((i) => `${indent}${i}`);
  if (items.length > MAX_LISTED) lines.push(`${indent}... and ${items.length - MAX_LISTED} more`);
  return lines;
}

function formatReport(r: MirrorReport): string[] {
  const skips = SKIP_REASONS.filter((k) => r.skipped[k] > 0).map((k) => `${r.skipped[k]} ${k.replace('_', ' ')}`);
  const out = [
    `${r.dryRun ? 'sync (dry run)' : 'sync'} ${r.name} -> ${r.into}/: scanned ${r.scanned}, added ${r.added}, updated ${r.updated}, ` +
      `unchanged ${r.unchanged}, orphaned ${r.orphaned.length}${skips.length > 0 ? `; skipped: ${skips.join(', ')}` : ''}`,
  ];
  const f = Object.entries(r.findings).filter(([, n]) => n > 0).map(([t, n]) => `${t} x${n}`);
  if (f.length > 0) out.push(`  scrubbed (counts only): ${f.join(', ')}`);
  if (r.credentialFiles.length > 0) {
    out.push('  check these sources for real secrets (credential-class findings; redacted in the vault copy):');
    out.push(...listSome(r.credentialFiles));
  }
  if (r.orphaned.length > 0) {
    out.push('  orphaned (the source file is gone; the note is kept):');
    out.push(...listSome(r.orphaned));
  }
  return out;
}

export function runSync(args: readonly string[], opts: MirrorCommandOptions = {}): CommandResult {
  const names: string[] = [];
  let dryRun = false;
  for (const a of args) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('-')) return usage('sync', `unknown flag ${a}`);
    else names.push(a);
  }
  const loaded = load('sync', opts);
  if ('code' in loaded) return loaded;
  const chosen = pick(loaded.config, names);
  if (typeof chosen === 'string') return usage('sync', chosen);
  const lines: string[] = [];
  let code = 0;
  for (const m of chosen) {
    try {
      lines.push(...formatReport(syncMirror(loaded.env, m, { dryRun })));
    } catch (err) {
      const known = err instanceof MirrorError || err instanceof SafePathError;
      lines.push(`sync ${m.name}: FAILED: ${known ? message(err) : `unexpected: ${message(err)}`}`);
      code = 1;
    }
  }
  if (!dryRun && code === 0) lines.push('the index picks the changes up on the next search or `ebrain reindex`');
  return { code, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

export function runMirrors(args: readonly string[], opts: MirrorCommandOptions = {}): CommandResult {
  const [sub, ...rest] = args;
  if (sub !== 'list' && sub !== 'status') return usage('mirrors', sub === undefined ? 'missing subcommand' : `unknown subcommand ${sub}`);
  const loaded = load('mirrors', opts);
  if ('code' in loaded) return loaded;
  const chosen = pick(loaded.config, sub === 'list' ? [] : rest);
  if (typeof chosen === 'string') return usage('mirrors', chosen);
  const lines: string[] = [];
  let code = 0;
  for (const m of chosen) {
    if (sub === 'list') {
      lines.push(`${m.name}\t${m.path}\t-> ${m.into}/`);
      continue;
    }
    try {
      const s = mirrorStatus(loaded.env, m);
      const age = s.ageDays === null ? 'never synced' : `last sync ${s.lastSync!.slice(0, 10)} (${s.ageDays}d ago)`;
      const drift = s.newFiles + s.changed + s.orphaned + s.missingNotes;
      lines.push(
        `${s.name}: ${age}; tracked ${s.tracked}; source has ${s.newFiles} new, ${s.changed} changed, ${s.orphaned} gone; ` +
          `${s.missingNotes} note(s) missing from the vault${drift === 0 ? '; up to date' : `; STALE: run \`ebrain sync ${s.name}\``}`,
      );
    } catch (err) {
      lines.push(`${m.name}: FAILED: ${message(err)}`);
      code = 1;
    }
  }
  return { code, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
