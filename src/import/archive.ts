// The raw archive (Phase 10): scrubbed conversation transcripts at
// `<vault>/_raw/conversations/<source>/<yyyy>/<id>.md`.
//
// Archive notes are indexed and searchable as folder class `raw` (tier T6,
// below every curated, inbox, and journal note) with `kind: raw`; they are
// never established facts. The file `id` is a stable function of source and
// conversation id, so a re-import keeps identity; an unchanged conversation
// leaves its file byte-identical (`created` is carried over from the existing
// file), and a changed one replaces its file atomically (`writeAtomic`).
// Scrubbing (I5) is mandatory and runs on every title and turn before
// anything is rendered; there is no option to skip it. Only a `human`
// principal may import conversations (agent history goes through
// `import agent-workspace`).

import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify } from 'yaml';
import type { PrincipalType } from '../config.js';
import { cleanTitle, isoSeconds } from '../inbox/note.js';
import { realVaultDir } from '../journal/store.js';
import { withLock } from '../lock.js';
import {
  createExclusive, readDirSafe, readFileSafe, resolveInVault, writeAtomic, type SafePath,
} from '../safe-path.js';
import { DETECTOR_TYPES, scrub, scrubVersion, type DetectorType, type ScrubFinding } from '../scrub/index.js';
import { splitFrontmatter } from '../vault/parse.js';
import type { Conversation, ConversationSource, Turn } from './sources.js';

/** Archive root for conversations, relative to the vault. */
export const RAW_CONVERSATIONS_DIR = '_raw/conversations';
/** `raw_` + 32 hex characters of sha256(source, conversation id). */
export const ARCHIVE_ID_RE = /^raw_[0-9a-f]{32}$/;
const ARCHIVE_NAME_RE = /^raw_[0-9a-f]{32}\.md$/;
const YEAR_RE = /^\d{4}$/;
/** Longest fallback title taken from the first user turn. */
const FALLBACK_TITLE_CHARS = 80;

export class ImportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRefusedError';
  }
}

/** The archive note id: stable for a (source, conversation id) pair. */
export function archiveId(source: ConversationSource, conversationId: string): string {
  return `raw_${createHash('sha256').update(`${source}\n${conversationId}`, 'utf8').digest('hex').slice(0, 32)}`;
}

export interface ArchiveOptions {
  vaultPath: string;
  stateDir: SafePath;
  principal: { id: string; type: PrincipalType };
  extraPatterns?: readonly string[];
  /** Count and compare only; write nothing. */
  dryRun?: boolean;
  now?: Date;
}

export type ArchiveAction = 'created' | 'updated' | 'unchanged';

export interface ArchiveResult {
  /** Conversations with at least one turn (archived, or would be). */
  conversations: number;
  turns: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Conversations with no human/assistant text left after filtering. */
  empty: number;
  /** Later records repeating a conversation id already seen in this import. */
  duplicates: number;
  skipped: { conversationId: string; reason: string }[];
  /** Scrubber findings over every title and turn (counts by type only). */
  findings: ScrubFinding[];
  files: { path: string; action: ArchiveAction }[];
}

interface Rendered {
  id: string;
  /** Vault-relative target when no file for this id exists yet. */
  relPath: string;
  render: (created: string) => string;
}

function addFindings(into: Map<DetectorType, number>, findings: readonly ScrubFinding[]): void {
  for (const f of findings) into.set(f.type, (into.get(f.type) ?? 0) + f.count);
}

function span(c: Conversation): { started?: string; ended?: string } {
  const times = c.turns.map((t) => t.at).filter((t): t is string => t !== undefined).sort();
  const started = c.created !== undefined && (times[0] === undefined || c.created < times[0]) ? c.created : (times[0] ?? c.created);
  const ended = times[times.length - 1] ?? c.updated ?? started;
  return started === undefined ? {} : { started, ended: ended !== undefined && ended > started ? ended : started };
}

function turnHeading(n: number, t: Turn): string {
  return `## Turn ${n}: ${t.role === 'user' ? 'User' : 'Assistant'}${t.at === undefined ? '' : ` (${t.at})`}`;
}

/** Scrub and render one conversation; findings are added to `counts`. */
function renderConversation(c: Conversation, opts: ArchiveOptions, counts: Map<DetectorType, number>): Rendered | string {
  const { started, ended } = span(c);
  if (started === undefined || ended === undefined) return 'no valid timestamp';
  const scrubOpts = { principal: { type: opts.principal.type }, extraPatterns: opts.extraPatterns ?? [] };
  const turns: Turn[] = [];
  for (const t of c.turns) {
    const r = scrub(t.text, scrubOpts);
    if (!r.ok) return 'scrub rejected';
    addFindings(counts, r.findings);
    turns.push({ ...t, text: r.text });
  }
  let title: string;
  if (c.title !== undefined && c.title.trim() !== '') {
    const r = scrub(c.title, scrubOpts);
    if (!r.ok) return 'scrub rejected';
    addFindings(counts, r.findings);
    title = cleanTitle(r.text);
  } else {
    const first = turns.find((t) => t.role === 'user')?.text.split('\n').find((l) => l.trim() !== '') ?? '';
    title = cleanTitle(first.length > FALLBACK_TITLE_CHARS ? `${first.slice(0, FALLBACK_TITLE_CHARS - 1)}…` : first);
  }
  if (title === '') title = `Conversation ${c.conversationId}`;
  const id = archiveId(c.source, c.conversationId);
  const body = turns.map((t, i) => `${turnHeading(i + 1, t)}\n\n${t.text.replace(/\s+$/, '')}\n`).join('\n');
  const render = (created: string): string => {
    const fm = {
      schema: 1,
      id,
      title,
      kind: 'raw',
      source: c.source,
      conversation_id: c.conversationId,
      started,
      ended,
      occurred: started,
      turns: turns.length,
      origin: 'import',
      author: opts.principal.id,
      created,
      scrubVersion,
    };
    return `---\n${stringify(fm, { lineWidth: 0 })}---\n# ${title}\n\n${body}`;
  };
  return { id, relPath: `${RAW_CONVERSATIONS_DIR}/${c.source}/${started.slice(0, 4)}/${id}.md`, render };
}

/** Existing archive files for a source, by id (a conversation keeps its file if its start year changes). */
function existingFiles(vaultPath: string, source: ConversationSource): Map<string, string> {
  const out = new Map<string, string>();
  const rel = `${RAW_CONVERSATIONS_DIR}/${source}`;
  const dir = realVaultDir(vaultPath, rel, false);
  if (dir === undefined) return out;
  const years = readDirSafe(dir).filter((e) => e.isDirectory() && YEAR_RE.test(e.name)).map((e) => e.name).sort();
  for (const y of years) {
    for (const e of readDirSafe(resolveInVault(vaultPath, `${rel}/${y}`))) {
      if (e.isFile() && ARCHIVE_NAME_RE.test(e.name)) {
        const id = e.name.slice(0, -3);
        if (!out.has(id)) out.set(id, `${rel}/${y}/${e.name}`);
      }
    }
  }
  return out;
}

/** The `created` value of an existing archive file, if it has a usable one. */
function existingCreated(text: string): string | undefined {
  const { yaml } = splitFrontmatter(text.replace(/\r\n?/g, '\n'));
  if (yaml === null) return undefined;
  try {
    const fm = parseYaml(yaml, { schema: 'core' }) as unknown;
    const created = typeof fm === 'object' && fm !== null ? (fm as Record<string, unknown>)['created'] : undefined;
    return typeof created === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created) ? created : undefined;
  } catch {
    return undefined;
  }
}

/** Scrub, render, and (unless `dryRun`) write conversations into the raw archive. */
export function archiveConversations(conversations: readonly Conversation[], opts: ArchiveOptions): ArchiveResult {
  if (opts.principal.type !== 'human') {
    throw new ImportRefusedError('conversation imports need a human principal; agent history goes through `ebrain import agent-workspace`');
  }
  const now = isoSeconds(opts.now ?? new Date());
  const result: ArchiveResult = {
    conversations: 0, turns: 0, created: 0, updated: 0, unchanged: 0, empty: 0, duplicates: 0, skipped: [], findings: [], files: [],
  };
  const byId = new Map<string, Conversation>();
  for (const c of conversations) {
    const key = `${c.source}\n${c.conversationId}`;
    if (byId.has(key)) result.duplicates++;
    else byId.set(key, c);
  }
  const ordered = [...byId.values()].sort((a, b) => Buffer.compare(Buffer.from(a.conversationId), Buffer.from(b.conversationId)));
  const counts = new Map<DetectorType, number>();
  const rendered: Rendered[] = [];
  const sources = new Set<ConversationSource>();
  for (const c of ordered) {
    if (c.turns.length === 0) {
      result.empty++;
      continue;
    }
    const r = renderConversation(c, opts, counts);
    if (typeof r === 'string') {
      result.skipped.push({ conversationId: c.conversationId, reason: r });
      continue;
    }
    result.conversations++;
    result.turns += c.turns.length;
    rendered.push(r);
    sources.add(c.source);
  }
  result.findings = DETECTOR_TYPES.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type)! }));

  const write = (): void => {
    const existing = new Map<string, string>();
    for (const s of sources) for (const [id, p] of existingFiles(opts.vaultPath, s)) existing.set(id, p);
    for (const r of rendered) {
      const prior = existing.get(r.id);
      let action: ArchiveAction;
      let relPath = r.relPath;
      if (prior !== undefined) {
        relPath = prior;
        const target = resolveInVault(opts.vaultPath, relPath);
        const old = readFileSafe(target, 'utf8');
        const text = r.render(existingCreated(old) ?? now);
        if (text === old) action = 'unchanged';
        else {
          action = 'updated';
          if (opts.dryRun !== true) {
            realVaultDir(opts.vaultPath, relPath.slice(0, relPath.lastIndexOf('/')), false);
            writeAtomic(target, text);
          }
        }
      } else {
        action = 'created';
        if (opts.dryRun !== true) {
          realVaultDir(opts.vaultPath, relPath.slice(0, relPath.lastIndexOf('/')));
          createExclusive(resolveInVault(opts.vaultPath, relPath), r.render(now));
        }
      }
      result[action]++;
      result.files.push({ path: relPath, action });
    }
  };
  if (opts.dryRun === true) write();
  else withLock(opts.stateDir, 'raw-archive', write);
  return result;
}

