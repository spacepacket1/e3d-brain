// `ebrain import claude-code [--projects-dir <dir>] [--dry-run]`,
// `ebrain import claude-export <file.zip|dir> [--dry-run]`, and
// `ebrain import chatgpt-export <file.zip|dir> [--dry-run]` (Phase 10):
// owner CLI only, never MCP. Scrubbing is mandatory (no flag turns it off).
// A conversation import needs a `human` principal; an agent's history goes
// through `import agent-workspace`.

import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { archiveConversations, ImportRefusedError, type ArchiveResult } from '../import/archive.js';
import { loadClaudeCode, loadExport, SourceError, type Loaded, type LoadOptions } from '../import/load.js';
import { ZipRejectedError } from '../import/zip.js';
import { SafePathError } from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

export const CONVERSATION_IMPORT_SOURCES = ['claude-code', 'claude-export', 'chatgpt-export'] as const;
export type ConversationImportSource = (typeof CONVERSATION_IMPORT_SOURCES)[number];

export const CONVERSATION_IMPORT_USAGE = `usage: ebrain import claude-code [--projects-dir <dir>] [--dry-run]
       ebrain import claude-export <file.zip|dir> [--dry-run]
       ebrain import chatgpt-export <file.zip|dir> [--dry-run]`;

export function isConversationImportSource(s: string | undefined): s is ConversationImportSource {
  return (CONVERSATION_IMPORT_SOURCES as readonly string[]).includes(s ?? '');
}

export interface ConversationImportOptions extends EnvOptions, LoadOptions {
  now?: () => Date;
  /** Base for relative paths (default: the process working directory). */
  cwd?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarize(source: string, loaded: Loaded, r: ArchiveResult, dryRun: boolean): string {
  const lines: string[] = [];
  const verb = { created: dryRun ? 'would create' : 'created', updated: dryRun ? 'would update' : 'updated' };
  for (const f of r.files) if (f.action !== 'unchanged') lines.push(`${verb[f.action]} ${f.path}`);
  for (const s of loaded.skippedFiles) lines.push(`skipped file ${s.path}: ${s.reason}`);
  for (const s of r.skipped) lines.push(`skipped conversation ${s.conversationId}: ${s.reason}`);
  const st = loaded.stats;
  lines.push(
    `${dryRun ? 'dry run: ' : ''}import ${source}: ${r.conversations} conversations, ${r.turns} turns ` +
      `(${r.created} ${verb.created}, ${r.updated} ${verb.updated}, ${r.unchanged} unchanged)`,
    `skipped: ${r.empty} empty, ${r.duplicates} duplicate, ${r.skipped.length} unusable conversations; ` +
      `${st.malformedConversations} malformed records, ${st.malformedLines} malformed lines, ${st.skippedFrames} non-text frames; ` +
      `${loaded.files} files read, ${loaded.skippedFiles.length} files skipped`,
    `scrub findings: ${r.findings.length === 0 ? 'none' : r.findings.map((f) => `${f.type}: ${f.count}`).join(', ')}`,
  );
  return `${lines.join('\n')}\n`;
}

export async function runConversationImport(args: readonly string[], opts: ConversationImportOptions = {}): Promise<CommandResult> {
  const usage = (msg: string): CommandResult => ({ code: 2, stdout: '', stderr: `ebrain import: ${msg}\n${CONVERSATION_IMPORT_USAGE}\n` });
  const [source, ...rest] = args;
  if (!isConversationImportSource(source)) return usage(`unknown source type ${JSON.stringify(source)}`);
  let dryRun = false;
  let projectsDir: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (source === 'claude-code' && (a === '--projects-dir' || a.startsWith('--projects-dir='))) {
      if (projectsDir !== undefined) return usage('--projects-dir given twice');
      projectsDir = a.includes('=') ? a.slice(a.indexOf('=') + 1) : rest[++i];
      if (projectsDir === undefined || projectsDir === '') return usage('--projects-dir needs a value');
    } else if (a.startsWith('--')) return usage(`unknown option ${JSON.stringify(a)}`);
    else positional.push(a);
  }
  if (source === 'claude-code' && positional.length > 0) return usage(`unexpected argument ${JSON.stringify(positional[0])}`);
  if (source !== 'claude-code' && positional.length !== 1) return usage('needs exactly one <file.zip|dir>');

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(opts);
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain import: ${err instanceof ConfigError ? 'config: ' : ''}${message(err)}\n` };
  }
  const { config } = loaded;
  if (config.principal.type !== 'human') {
    return {
      code: 1,
      stdout: '',
      stderr: 'ebrain import: conversation imports need a human principal; refusing (agent history goes through `ebrain import agent-workspace`)\n',
    };
  }
  const cwd = opts.cwd ?? process.cwd();
  const loadOpts: LoadOptions = {};
  if (opts.zipLimits !== undefined) loadOpts.zipLimits = opts.zipLimits;
  if (opts.maxFileBytes !== undefined) loadOpts.maxFileBytes = opts.maxFileBytes;
  try {
    const sources =
      source === 'claude-code'
        ? loadClaudeCode(path.resolve(cwd, projectsDir ?? path.join(opts.homeDir ?? os.homedir(), '.claude', 'projects')), loadOpts)
        : await loadExport(source, path.resolve(cwd, positional[0]!), loadOpts);
    const r = archiveConversations(sources.conversations, {
      vaultPath: config.vaultPath,
      stateDir: ensureStateDir(config),
      principal: config.principal,
      extraPatterns: config.scrub.extraPatterns,
      dryRun,
      ...(opts.now === undefined ? {} : { now: opts.now() }),
    });
    return { code: 0, stdout: summarize(source, sources, r, dryRun), stderr: '' };
  } catch (err) {
    if (err instanceof ZipRejectedError) return { code: 1, stdout: '', stderr: `ebrain import: archive rejected (${err.code}): ${err.message}\n` };
    const known = err instanceof SafePathError || err instanceof SourceError || err instanceof ImportRefusedError;
    return { code: 1, stdout: '', stderr: `ebrain import: ${known ? message(err) : `failed: ${message(err)}`}\n` };
  }
}
