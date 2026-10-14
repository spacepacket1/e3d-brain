// `ebrain reindex [--full]` and `ebrain index dump`.

import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { dumpIndex } from '../index/dump.js';
import { closeIndex, indexTotals, openIndex, reindex, type RefreshResult } from '../index/indexer.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withIndex(opts: EnvOptions, mustExist: boolean, fn: (h: ReturnType<typeof openIndex>) => string): CommandResult {
  let h: ReturnType<typeof openIndex>;
  try {
    const { config } = loadConfig(opts);
    h = openIndex({ vaultPath: config.vaultPath, stateDir: ensureStateDir(config), mustExist });
  } catch (err) {
    const prefix = err instanceof ConfigError ? 'config: ' : '';
    return { code: 1, stdout: '', stderr: `${prefix}${message(err)}\n` };
  }
  try {
    return { code: 0, stdout: fn(h), stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `${message(err)}\n` };
  } finally {
    closeIndex(h);
  }
}

export function formatSummary(r: RefreshResult, t: ReturnType<typeof indexTotals>): string {
  const s = r.skipped;
  const lines = [
    `reindex (${r.mode}${r.rebuilt ? ', rebuilt for new parser settings' : ''}): ${t.notes} notes; ` +
      `added ${r.added}, updated ${r.updated}, removed ${r.removed}, unchanged ${r.unchanged}`,
    `chunks: ${t.chunks}  links: ${t.links} (unresolved ${t.unresolvedLinks})  tags: ${t.tags}`,
    `malformed frontmatter: ${t.malformedFrontmatter}`,
    `invalid dates: ${t.invalidDates}`,
    `unknown statuses: ${t.unknownStatuses}`,
    `invalid fields: ${t.invalidFields}`,
    `invalid utf-8: ${t.invalidUtf8}`,
    `skipped: symlinks ${s.symlinks}, hidden ${s.hidden}, unsafe names ${s.unsafeNames}, too large ${s.tooLarge}, ` +
      `unreadable ${s.unreadable}, other ${s.other}`,
    `path collisions: ${t.collisions.length}`,
  ];
  for (const g of t.collisions) lines.push(`  collision: ${g.map((p) => JSON.stringify(p)).join(' ')}`);
  return `${lines.join('\n')}\n`;
}

export function runReindex(args: readonly string[], opts: EnvOptions = {}): CommandResult {
  const full = args.includes('--full');
  const unknown = args.find((a) => a !== '--full');
  if (unknown !== undefined) return { code: 2, stdout: '', stderr: `ebrain reindex: unexpected argument ${JSON.stringify(unknown)}\n` };
  return withIndex(opts, false, (h) => formatSummary(reindex(h, { full }), indexTotals(h.db)));
}

export function runIndexCommand(args: readonly string[], opts: EnvOptions = {}): CommandResult {
  if (args.length !== 1 || args[0] !== 'dump') {
    return { code: 2, stdout: '', stderr: 'usage: ebrain index dump\n' };
  }
  return withIndex(opts, true, (h) => dumpIndex(h.db));
}
