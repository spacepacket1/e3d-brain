// Reading conversation sources (Phase 10). Every source file is opened with
// `openExternalFile` and the caller-named root (the projects directory, the
// export directory, or the zip's own directory), under the realpath and
// symlink rules of I1. Sources are never written. Zip exports are read in
// memory through `./zip.ts` (nothing is extracted to disk).

import * as path from 'node:path';
import {
  openExternalFile, readDirSafe, resolveInRoot, SafePathError, statSafe, type ExternalFile, type SafePath,
} from '../safe-path.js';
import { decodeNote } from '../vault/parse.js';
import {
  ClaudeCodeCollector, emptyStats, parseChatgptExport, parseClaudeExport,
  type Conversation, type ConversationSource, type ParseStats,
} from './sources.js';
import { DEFAULT_ZIP_LIMITS, readZipEntries, type ZipLimits } from './zip.js';

/** Largest JSONL transcript or unzipped `conversations.json` read from a directory. */
export const MAX_SOURCE_FILE_BYTES = 512 * 1024 * 1024;
/** Deepest directory level walked under the Claude Code projects directory. */
export const MAX_PROJECTS_DEPTH = 8;
/** `conversations.json`, or a split export's `conversations-NNN.json`. */
const CONVERSATIONS_FILE_RE = /^conversations(?:-\d{1,6})?\.json$/;

export interface LoadOptions {
  zipLimits?: ZipLimits;
  maxFileBytes?: number;
}

export interface Loaded {
  conversations: Conversation[];
  stats: ParseStats;
  /** Source files read. */
  files: number;
  skippedFiles: { path: string; reason: string }[];
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

function readCapped(file: ExternalFile, cap: number, label: string): string {
  if (file.stat.size > cap) throw new SourceError(`${label} is larger than ${cap} bytes`);
  return decodeText(file.readBuffer(), label);
}

function decodeText(data: Buffer, label: string): string {
  const d = decodeNote(data);
  if (d.invalidUtf8) throw new SourceError(`${label} is not valid UTF-8`);
  return d.text;
}

function directoryRoot(dir: string, what: string): SafePath {
  const root = resolveInRoot(dir, '');
  const st = statSafe(root);
  if (st === undefined || !st.isDirectory()) throw new SourceError(`${what} is not a directory: ${dir}`);
  return root;
}

/** Claude Code transcripts: every `*.jsonl` under `projectsDir` (symlinks and dot-entries skipped). */
export function loadClaudeCode(projectsDir: string, opts: LoadOptions = {}): Loaded {
  const root = directoryRoot(projectsDir, 'projects directory');
  const cap = opts.maxFileBytes ?? MAX_SOURCE_FILE_BYTES;
  const collector = new ClaudeCodeCollector();
  const loaded: Loaded = { conversations: [], stats: collector.stats, files: 0, skippedFiles: [] };
  const walk = (rel: string, depth: number): void => {
    const dir = rel === '' ? root : resolveInRoot(root, rel);
    // Directory order is filesystem-dependent; sort for a deterministic turn order.
    const entries = readDirSafe(dir).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) {
        if (e.name.endsWith('.jsonl')) loaded.skippedFiles.push({ path: childRel, reason: 'symlink' });
        continue;
      }
      if (e.isDirectory()) {
        if (depth < MAX_PROJECTS_DEPTH) walk(childRel, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      let text: string;
      try {
        const file = openExternalFile(resolveInRoot(root, childRel), [root]);
        try {
          text = readCapped(file, cap, childRel);
        } finally {
          file.close();
        }
      } catch (err) {
        const reason = err instanceof SafePathError ? `not read (${err.code})` : err instanceof SourceError ? err.message : 'unreadable';
        loaded.skippedFiles.push({ path: childRel, reason });
        continue;
      }
      loaded.files++;
      collector.addFile(text, e.name.slice(0, -'.jsonl'.length));
    }
  };
  walk('', 0);
  loaded.conversations = collector.conversations();
  return loaded;
}

type ExportSource = Exclude<ConversationSource, 'claude-code'>;

function parseExport(source: ExportSource, json: string, stats: ParseStats): Conversation[] {
  return source === 'claude-export' ? parseClaudeExport(json, stats) : parseChatgptExport(json, stats);
}

const ZIP_MAGIC = [Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('PK\x05\x06', 'latin1')];

/** A Claude.ai or ChatGPT data export: the zip as downloaded, or a directory it was unpacked into. */
export async function loadExport(source: ExportSource, inputPath: string, opts: LoadOptions = {}): Promise<Loaded> {
  const abs = path.resolve(inputPath);
  const stats = emptyStats();
  const loaded: Loaded = { conversations: [], stats, files: 0, skippedFiles: [] };
  const parent = path.dirname(abs);
  const target = resolveInRoot(parent, path.basename(abs));
  const st = statSafe(target);
  if (st === undefined) throw new SourceError(`no such file or directory: ${inputPath}`);

  if (st.isDirectory()) {
    const root = directoryRoot(abs, 'export directory');
    const cap = opts.maxFileBytes ?? MAX_SOURCE_FILE_BYTES;
    const names = readDirSafe(root)
      .filter((e) => e.isFile() && CONVERSATIONS_FILE_RE.test(e.name))
      .map((e) => e.name)
      .sort();
    if (names.length === 0) throw new SourceError('no conversations.json in the export directory');
    for (const name of names) {
      const file = openExternalFile(resolveInRoot(root, name), [root]);
      try {
        loaded.conversations.push(...parseExport(source, readCapped(file, cap, name), stats));
      } finally {
        file.close();
      }
      loaded.files++;
    }
    return loaded;
  }

  const file = openExternalFile(target, [parent]);
  try {
    const head = file.readAt(0, 4);
    if (!ZIP_MAGIC.some((m) => m.equals(head))) throw new SourceError(`${path.basename(abs)} is not a zip archive or a directory`);
    const wanted = (name: string): boolean => {
      const parts = name.split('/');
      return parts.length <= 2 && CONVERSATIONS_FILE_RE.test(parts[parts.length - 1]!);
    };
    const entries = await readZipEntries(file, wanted, opts.zipLimits ?? DEFAULT_ZIP_LIMITS);
    if (entries.size === 0) throw new SourceError('no conversations.json in the archive');
    for (const name of [...entries.keys()].sort()) {
      loaded.conversations.push(...parseExport(source, decodeText(entries.get(name)!, name), stats));
      loaded.files++;
    }
  } finally {
    file.close();
  }
  return loaded;
}
