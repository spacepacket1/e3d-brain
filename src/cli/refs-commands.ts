// `ebrain refs add <file> [--title <t>] [--author <a>]`, `ebrain refs list`,
// `ebrain refs remove <ref_id>`, `ebrain refs reindex` (Phase 11): the
// owner's reference library. Book text goes to `<stateDir>/refs.db` only
// (scrubbed); the vault gets one owner note per book under `references/`.
// `ebrain reindex` never touches refs.db.

import * as path from 'node:path';
import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import type { PdfOptions } from '../exec/pdftotext.js';
import { ZipRejectedError, type ZipLimits } from '../import/zip.js';
import { LockError } from '../lock.js';
import { BookError } from '../refs/extract.js';
import { RefsDbError } from '../refs/db.js';
import { addRef, listRefs, RefError, reindexRefs, removeRef, type LibraryOptions } from '../refs/library.js';
import { SafePathError } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

export const REFS_USAGE = `usage: ebrain refs add <file.epub|.md|.txt|.pdf> [--title <title>] [--author <author>]
       ebrain refs list
       ebrain refs remove <ref_id>
       ebrain refs reindex`;

export interface RefsCommandOptions extends EnvOptions {
  now?: () => Date;
  cwd?: string;
  zipLimits?: ZipLimits;
  pdf?: PdfOptions;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function libraryOptions(opts: RefsCommandOptions): LibraryOptions | CommandResult {
  try {
    const { config } = loadConfig(opts);
    const lib: LibraryOptions = {
      vaultPath: config.vaultPath,
      stateDir: ensureStateDir(config),
      principal: config.principal,
      extraPatterns: config.scrub.extraPatterns,
    };
    if (opts.now !== undefined) lib.now = opts.now();
    if (opts.zipLimits !== undefined) lib.zipLimits = opts.zipLimits;
    if (opts.pdf !== undefined) lib.pdf = opts.pdf;
    return lib;
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain refs: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
  }
}

function failure(err: unknown): CommandResult {
  if (err instanceof ZipRejectedError) return { code: 1, stdout: '', stderr: `ebrain refs: archive rejected (${err.code}): ${err.message}\n` };
  const known = err instanceof RefError || err instanceof BookError || err instanceof SafePathError || err instanceof RefsDbError ||
    err instanceof LockError;
  const errno = (err as NodeJS.ErrnoException).code;
  if (errno === 'ENOENT') return { code: 1, stdout: '', stderr: 'ebrain refs: no such file\n' };
  return { code: 1, stdout: '', stderr: `ebrain refs: ${known ? message(err) : `failed: ${message(err)}`}\n` };
}

function findingsLine(findings: readonly { type: string; count: number }[]): string {
  return `scrub findings: ${findings.length === 0 ? 'none' : findings.map((f) => `${f.type}: ${f.count}`).join(', ')}`;
}

async function add(args: readonly string[], opts: RefsCommandOptions): Promise<CommandResult> {
  const usage = (msg: string): CommandResult => ({ code: 2, stdout: '', stderr: `ebrain refs add: ${msg}\n${REFS_USAGE}\n` });
  const positional: string[] = [];
  const flags: { title?: string; author?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^--(title|author)(?:=(.*))?$/.exec(a);
    if (m !== null) {
      const key = m[1] as 'title' | 'author';
      if (flags[key] !== undefined) return usage(`--${key} given twice`);
      const v = m[2] ?? args[++i];
      if (v === undefined || v.trim() === '') return usage(`--${key} needs a value`);
      flags[key] = v;
    } else if (a.startsWith('--')) return usage(`unknown option ${JSON.stringify(a)}`);
    else positional.push(a);
  }
  if (positional.length !== 1) return usage('needs exactly one <file>');
  const lib = libraryOptions(opts);
  if ('code' in lib) return lib;
  try {
    const r = await addRef(path.resolve(opts.cwd ?? process.cwd(), positional[0]!), { ...lib, ...flags });
    if (r.action === 'unchanged') {
      return { code: 0, stdout: `already in the library (same file hash): ${r.refId} ${JSON.stringify(r.title)}; nothing changed\n`, stderr: '' };
    }
    const lines = [
      `added ${r.refId}: ${JSON.stringify(r.title)}${r.author === undefined ? '' : ` by ${JSON.stringify(r.author)}`} (${r.chapters} chapters, ${r.chunks} chunks)`,
      `${r.noteCreated ? 'created' : 'kept existing'} note ${r.notePath}`,
      findingsLine(r.findings),
    ];
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return failure(err);
  }
}

function list(args: readonly string[], opts: RefsCommandOptions): CommandResult {
  if (args.length > 0) return { code: 2, stdout: '', stderr: `ebrain refs list: unexpected argument ${JSON.stringify(args[0])}\n` };
  const lib = libraryOptions(opts);
  if ('code' in lib) return lib;
  try {
    const rows = listRefs(lib);
    const lines = rows.map((r) =>
      `${r.ref_id}  ${JSON.stringify(r.title)}${r.author === null ? '' : ` by ${JSON.stringify(r.author)}`}  ` +
        `${r.format}, ${r.chapters} chapters, ${r.chunks} chunks  source: ${r.source_path}${r.note_path === null ? '' : `  note: ${r.note_path}`}`);
    lines.push(`${rows.length} reference${rows.length === 1 ? '' : 's'}`);
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return failure(err);
  }
}

function remove(args: readonly string[], opts: RefsCommandOptions): CommandResult {
  if (args.length !== 1) return { code: 2, stdout: '', stderr: `ebrain refs remove: needs exactly one <ref_id>\n${REFS_USAGE}\n` };
  const lib = libraryOptions(opts);
  if ('code' in lib) return lib;
  try {
    const row = removeRef(args[0]!, lib);
    const note = row.note_path === null ? '' : `; your note ${row.note_path} was left in place`;
    return { code: 0, stdout: `removed ${row.ref_id} (${JSON.stringify(row.title)}) from the library index${note}\n`, stderr: '' };
  } catch (err) {
    return failure(err);
  }
}

async function reindex(args: readonly string[], opts: RefsCommandOptions): Promise<CommandResult> {
  if (args.length > 0) return { code: 2, stdout: '', stderr: `ebrain refs reindex: unexpected argument ${JSON.stringify(args[0])}\n` };
  const lib = libraryOptions(opts);
  if ('code' in lib) return lib;
  try {
    const r = await reindexRefs(lib);
    const lines: string[] = [];
    for (const x of r.rebuilt) lines.push(`rebuilt ${x.refId}: ${JSON.stringify(x.title)} (${x.chapters} chapters, ${x.chunks} chunks)`);
    for (const x of r.missing) lines.push(`missing ${x.refId}: source not found at ${x.sourcePath} (moved or deleted; rows kept)`);
    for (const x of r.changed) lines.push(`changed ${x.refId}: ${x.sourcePath} has different content now (rows kept; \`refs add\` it as a new reference)`);
    for (const x of r.failed) lines.push(`failed ${x.refId}: ${x.reason}`);
    lines.push(
      `refs reindex: ${r.rebuilt.length} rebuilt, ${r.missing.length} missing, ${r.changed.length} changed, ${r.failed.length} failed` +
        (r.removed > 0 ? `; ${r.removed} removed (not restored)` : ''),
    );
    const problems = r.missing.length + r.changed.length + r.failed.length;
    return { code: problems > 0 ? 1 : 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return failure(err);
  }
}

export async function runRefs(args: readonly string[], opts: RefsCommandOptions = {}): Promise<CommandResult> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add':
      return add(rest, opts);
    case 'list':
      return list(rest, opts);
    case 'remove':
      return remove(rest, opts);
    case 'reindex':
      return reindex(rest, opts);
    default:
      return { code: 2, stdout: '', stderr: `ebrain refs: unknown subcommand ${JSON.stringify(sub)}\n${REFS_USAGE}\n` };
  }
}
