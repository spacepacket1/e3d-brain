// `read_ref_chunk` (Phase 11): one passage of a reference book from
// `<stateDir>/refs.db`, addressed by its citation parts. A read tool in every
// mode. It returns exactly one chunk (a few paragraphs), fenced and capped by
// dispatch like any note text (I6), so a book cannot be dumped in one call;
// `prev`/`next` citations allow reading on, one call per chunk. refs.db is
// opened read-only per call and never written over MCP.

import { MAX_ORDINAL } from '../cite/citation.js';
import {
  chunkRow, nextChunkKey, openRefsDbReadOnly, prevChunkKey, REF_ID_RE, refCitation, refLabel, refRow,
} from '../refs/db.js';
import { MODES, registerTool, ToolRejection, type ToolRegistry, type ToolResult } from './dispatch.js';
import { truncateText } from './fence.js';
import { MAX_CHARS_SCHEMA, type ObjectSchema } from './schema.js';
import { COMPACT_EXCERPT_CHARS, type Format, type RefsEnv } from './tools.js';
import { ulid } from './ulid.js';

export const READ_REF_CHUNK_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    ref_id: { type: 'string', minLength: 36, maxLength: 36, pattern: REF_ID_RE.source, description: 'Reference id (ref_ plus 32 hex), from a ref: citation.' },
    chapter: { type: 'integer', minimum: 1, maximum: MAX_ORDINAL, description: 'Chapter number (1-based), from the citation.' },
    ordinal: { type: 'integer', minimum: 0, maximum: MAX_ORDINAL, description: 'Chunk number within the chapter (0-based), from the citation.' },
    max_chars: MAX_CHARS_SCHEMA,
    format: { type: 'string', enum: ['full', 'compact'], description: '"compact" returns the citation plus an excerpt of at most 200 characters.' },
  },
  required: ['ref_id', 'chapter', 'ordinal'],
};

function readRefChunk(env: RefsEnv | undefined, args: Record<string, unknown>): ToolResult {
  const format: Format = args['format'] === 'compact' ? 'compact' : 'full';
  const refId = args['ref_id'] as string;
  const chapter = args['chapter'] as number;
  const ordinal = args['ordinal'] as number;
  const notFound = () => new ToolRejection({ type: 'invalid', detail: 'not found: no such reference chunk (check ref_id, chapter, and ordinal)' });
  const db = env === undefined ? undefined : openRefsDbReadOnly(env.stateDir);
  if (db === undefined) throw notFound();
  try {
    const row = chunkRow(db, refId, chapter, ordinal);
    if (row === undefined) throw notFound();
    const ref = refRow(db, refId)!;
    const citation = refCitation(refId, chapter, ordinal);
    const prev = prevChunkKey(db, refId, chapter, ordinal);
    const next = nextChunkKey(db, refId, chapter, ordinal);
    const meta: Record<string, unknown> = {
      source: 'ref',
      ref_id: refId,
      chapter,
      ordinal,
      label: refLabel(row.title, chapter, row.chapter_heading),
      citation,
    };
    if (row.heading !== null && row.heading !== row.chapter_heading) meta['heading'] = row.heading;
    if (format === 'compact') meta['excerpt'] = truncateText(row.text, COMPACT_EXCERPT_CHARS);
    else {
      Object.assign(meta, {
        title: row.title,
        book_author: row.author,
        chapters: ref.chapters,
        prev: prev === undefined ? null : refCitation(refId, prev.chapter, prev.ordinal),
        next: next === undefined ? null : refCitation(refId, next.chapter, next.ordinal),
      });
    }
    const recall_id = ulid();
    const header = JSON.stringify({ tool: 'read_ref_chunk', recall_id, format, count: 1 });
    const data = format === 'compact' ? JSON.stringify(meta) : `${JSON.stringify(meta)}\n\n${row.text}`;
    return {
      content: [{ type: 'text', text: header }, { type: 'data', text: data, source: citation }],
      recall_id,
      returned: [{ id: refId, rev: row.chunk_rev }],
      count: 1,
    };
  } finally {
    db.close();
  }
}

/** Register `read_ref_chunk` (every mode). */
export function registerRefTools(env: RefsEnv | undefined, registry: ToolRegistry): void {
  registerTool(
    {
      name: 'read_ref_chunk',
      modes: MODES,
      description: 'Read one passage of a reference book by its citation parts (ref:<ref_id>/<chapter>/<ordinal>), with prev/next citations.',
      schema: READ_REF_CHUNK_SCHEMA,
      auditArgs: { ref_id: 'id' },
      handler: (args) => readRefChunk(env, args),
    },
    registry,
  );
}
