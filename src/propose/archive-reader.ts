// Read raw archive notes (`_raw/conversations/<source>/<yyyy>/raw_*.md`,
// written by Phase 10) back into numbered turns for `propose`. Read-only.
// A file that does not look like an archive note (bad frontmatter, id not
// matching its name, no turns) is skipped and counted, never fatal (I10).

import { parse as parseYaml } from 'yaml';
import { ARCHIVE_ID_RE, existingFiles } from '../import/archive.js';
import { CONVERSATION_SOURCES, type ConversationSource, type TurnRole } from '../import/sources.js';
import { MAX_NOTE_BYTES } from '../index/indexer.js';
import { readFileWithStatSafe, resolveInVault } from '../safe-path.js';
import { decodeNote, revOf, splitFrontmatter } from '../vault/parse.js';

export interface ArchiveTurn {
  /** 1-based, as in the note's `## Turn <n>:` headings. */
  n: number;
  role: TurnRole;
  text: string;
}

export interface ArchiveNote {
  id: string;
  /** Revision of the whole note (pins citations). */
  rev: string;
  relPath: string;
  source: ConversationSource;
  title: string;
  started: string;
  ended: string;
  turns: ArchiveTurn[];
}

export interface ArchiveFilter {
  /** Only conversations that ended at or after this time (ms since epoch). */
  sinceMs?: number;
  /** A conversation source (`claude-code`, ...) or one archive note id (`raw_...`). */
  source?: string;
}

export interface ArchiveRead {
  notes: ArchiveNote[];
  /** Files skipped as unreadable or malformed. */
  malformed: number;
  /** Notes outside the filter. */
  filtered: number;
}

const TURN_HEADING_RE = /^## Turn (\d+): (User|Assistant)(?: \(([^)\n]*)\))?$/;

export function isSourceFilter(s: string): boolean {
  return (CONVERSATION_SOURCES as readonly string[]).includes(s) || ARCHIVE_ID_RE.test(s);
}

/**
 * Split an archive body into turns. A heading counts only when it carries the
 * next expected number, so a turn whose own text contains `## Turn ...` lines
 * cannot shift the numbering.
 */
export function parseTurns(body: string): ArchiveTurn[] {
  const turns: ArchiveTurn[] = [];
  let cur: { n: number; role: TurnRole; lines: string[] } | undefined;
  const flush = (): void => {
    if (cur !== undefined) turns.push({ n: cur.n, role: cur.role, text: cur.lines.join('\n').trim() });
  };
  for (const line of body.split('\n')) {
    const m = TURN_HEADING_RE.exec(line);
    if (m !== null && Number(m[1]) === turns.length + (cur === undefined ? 1 : 2)) {
      flush();
      cur = { n: Number(m[1]), role: m[2] === 'User' ? 'user' : 'assistant', lines: [] };
    } else if (cur !== undefined) cur.lines.push(line);
  }
  flush();
  return turns;
}

function parseArchive(relPath: string, expectedId: string, data: Uint8Array): ArchiveNote | undefined {
  const { text, invalidUtf8 } = decodeNote(data);
  if (invalidUtf8) return undefined;
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === null) return undefined;
  let fm: unknown;
  try {
    fm = parseYaml(yaml, { schema: 'core' });
  } catch {
    return undefined;
  }
  if (typeof fm !== 'object' || fm === null) return undefined;
  const f = fm as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
  const source = str('source');
  const started = str('started');
  const ended = str('ended');
  if (f['id'] !== expectedId || source === undefined || !(CONVERSATION_SOURCES as readonly string[]).includes(source)) return undefined;
  if (started === undefined || ended === undefined || Number.isNaN(Date.parse(started)) || Number.isNaN(Date.parse(ended))) return undefined;
  const turns = parseTurns(body);
  if (turns.length === 0) return undefined;
  return { id: expectedId, rev: revOf(text), relPath, source: source as ConversationSource, title: str('title') ?? expectedId, started, ended, turns };
}

/** Archive notes matching `filter`, in a stable order (source, then path). */
export function readArchive(vaultPath: string, filter: ArchiveFilter = {}): ArchiveRead {
  const out: ArchiveRead = { notes: [], malformed: 0, filtered: 0 };
  const byId = filter.source !== undefined && ARCHIVE_ID_RE.test(filter.source) ? filter.source : undefined;
  for (const source of CONVERSATION_SOURCES) {
    if (filter.source !== undefined && byId === undefined && filter.source !== source) continue;
    const files = [...existingFiles(vaultPath, source)].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    for (const [id, relPath] of files) {
      if (byId !== undefined && id !== byId) continue;
      let note: ArchiveNote | undefined;
      try {
        note = parseArchive(relPath, id, readFileWithStatSafe(resolveInVault(vaultPath, relPath), { maxBytes: MAX_NOTE_BYTES }).data);
      } catch {
        note = undefined;
      }
      if (note === undefined) {
        out.malformed++;
        continue;
      }
      if (filter.sinceMs !== undefined && Date.parse(note.ended) < filter.sinceMs) {
        out.filtered++;
        continue;
      }
      out.notes.push(note);
    }
  }
  return out;
}
