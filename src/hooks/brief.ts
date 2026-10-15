// The session brief (Phase 13): what `ebrain hook session-start` prints into
// a Claude Code session. Read-only: it reads the note index and writes
// nothing to the vault. Titles come from notes, so the whole brief is
// wrapped by the I6 fence and capped at 10,000 characters.

import { refreshIndex, type IndexHandle } from '../index/indexer.js';
import { allNoteRows, tagsByPath } from '../index/query.js';
import { rank } from '../index/rank.js';
import { fence, truncateText } from '../mcp/fence.js';
import { citationFor, effectiveStatus, isVisible, normalizeTag, rankItem } from '../mcp/tools.js';
import { cleanTitle } from '../inbox/note.js';
import { nfc } from '../vault/names.js';
import { MAX_CHARS_CEILING, type HooksConfig } from '../config.js';

/** Most notes listed in the brief. */
export const BRIEF_MAX_NOTES = 15;

export interface BriefInput {
  index: IndexHandle;
  hooks: HooksConfig;
  /** `limits.maxCharsPerCall`; the brief never exceeds the 10,000-character ceiling either. */
  maxChars: number;
  now?: () => Date;
}

/** Open proposals waiting in `_inbox/` (not rejected or applied). */
function openInboxCount(index: IndexHandle): number {
  return allNoteRows(index.db).filter((r) => r.folder_class === 'inbox' && r.folder_hidden === 0).length;
}

/** The brief text, fenced and capped. Throws on index errors (the caller fails open). */
export function buildBrief(input: BriefInput): string {
  refreshIndex(input.index);
  const { db } = input.index;
  const now = (input.now ?? (() => new Date()))().getTime();
  const vis = { includeSuperseded: false, includeArchived: false, now };
  const tagMap = tagsByPath(db);
  const folders = input.hooks.briefFolders.filter((f) => !f.startsWith('#')).map((f) => `${nfc(f).replace(/\/+$/, '')}/`);
  const tags = input.hooks.briefFolders.filter((f) => f.startsWith('#')).map(normalizeTag);

  const candidates = allNoteRows(db)
    .filter((r) => (r.folder_class === 'curated' || r.folder_class === 'reference') && effectiveStatus(r) === 'accepted' && isVisible(r, vis))
    .filter((r) => folders.some((f) => nfc(r.path).startsWith(f)) || tags.some((t) => (tagMap.get(r.path) ?? []).includes(t)))
    .map((r) => rankItem({ row: r }));
  const ranked = rank(candidates, { newestFirst: true }).slice(0, BRIEF_MAX_NOTES);

  const lines: string[] = ['# e3d-brain session brief', ''];
  if (input.hooks.focus.trim() !== '') lines.push('## Focus', input.hooks.focus.trim(), '');
  lines.push('## Recent accepted notes');
  if (ranked.length === 0) lines.push('(none in the configured brief folders)');
  for (const { item } of ranked) {
    const title = cleanTitle(item.row.title) || item.row.path;
    lines.push(`- ${title} (${item.row.path}) ${citationFor(item.row)}`);
  }
  lines.push('', '## Inbox', `${openInboxCount(input.index)} proposal(s) waiting for owner review.`);

  const cap = Math.min(input.maxChars, MAX_CHARS_CEILING);
  const block = fence(lines.join('\n'), { maxChars: cap });
  return block === undefined ? truncateText('', 0) : `${block.text}\n`.slice(0, cap);
}
