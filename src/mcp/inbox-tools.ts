// The inbox MCP tools (Phase 8): `capture` and `list_inbox`, registered for
// `inbox` mode only (they do not exist in `journal` or `read-only` mode).
//
// `capture` scrubs everything the client submitted (title, body, sources)
// under the principal's rules before anything is written (I5; an agent
// principal's credential rejects the whole call), then hands a sanitized slug
// and the rendered note to the inbox writer, the only module an MCP tool can
// write the vault through (I2). It never accepts a path. `list_inbox` lists
// the proposals with citations, fenced like every other read result (I6).

import { parseCitation } from '../cite/citation.js';
import { refreshIndex, type IndexHandle } from '../index/indexer.js';
import { allNoteRows, firstChunkText, type NoteRow } from '../index/query.js';
import { rank } from '../index/rank.js';
import { CAPTURE_KINDS, cleanTitle, DEFAULT_CAPTURE_KIND, isoSeconds, renderProposal, toSlug } from '../inbox/note.js';
import { writeInboxFile } from '../inbox/writer.js';
import { scrubVersion, type ScrubFinding } from '../scrub/index.js';
import { revOf } from '../vault/parse.js';
import { registerTool, ToolRejection, type ToolContext, type ToolRegistry, type ToolResult } from './dispatch.js';
import { truncateText } from './fence.js';
import { MAX_CHARS_SCHEMA, type ObjectSchema } from './schema.js';
import { scrubToolInput } from './scrub-guard.js';
import {
  citationFor, COMPACT_EXCERPT_CHARS, isVisible, LIST_EXCERPT_CHARS, listResponse, noteFields, PROPOSED_NOTICE, rankItem,
  type Format,
} from './tools.js';
import { ulid } from './ulid.js';

export const MAX_TITLE_INPUT = 10_000;
export const MAX_BODY_INPUT = 100_000;
export const MAX_SOURCES = 50;
export const INBOX_LIMIT = { default: 50, max: 200 };

export interface InboxToolEnv {
  vaultPath: string;
  index: IndexHandle;
  /** `scrub.extraPatterns` from the instance config. */
  extraPatterns: readonly string[];
  /** Clock (tests inject one). */
  now?: () => Date;
}

export const CAPTURE_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_INPUT, description: 'Short title; becomes the file slug and the heading.' },
    body: { type: 'string', maxLength: MAX_BODY_INPUT, description: 'Note text (Markdown). Secrets are redacted before it is stored.' },
    kind: { type: 'string', enum: CAPTURE_KINDS, description: `Default "${DEFAULT_CAPTURE_KIND}".` },
    sources: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 4096 },
      maxItems: MAX_SOURCES,
      description: 'Source identifiers in citation form: note:<id>@<rev>, thesis:<id>, outcome:<id>, commit:<sha>, url:<url>, ref:...',
    },
  },
  required: ['title', 'body'],
};

export const LIST_INBOX_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: INBOX_LIMIT.max, description: `Maximum results (default ${INBOX_LIMIT.default}).` },
    max_chars: MAX_CHARS_SCHEMA,
    format: { type: 'string', enum: ['full', 'compact'], description: '"compact" returns citations plus excerpts of at most 200 characters.' },
  },
};

function mergeFindings(lists: readonly (readonly ScrubFinding[])[]): ScrubFinding[] {
  const counts = new Map<string, number>();
  for (const list of lists) for (const f of list) counts.set(f.type, (counts.get(f.type) ?? 0) + f.count);
  return [...counts].map(([type, count]) => ({ type, count }) as ScrubFinding);
}

/** Validate and scrub `sources`; a source the scrubber changes is refused (a redacted citation is no citation). */
function scrubSources(raw: unknown, ctx: ToolContext, env: InboxToolEnv): { sources: string[]; findings: ScrubFinding[] } {
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  const sources: string[] = [];
  const findings: ScrubFinding[][] = [];
  list.forEach((s, i) => {
    const scrubbed = scrubToolInput(s, ctx, env.extraPatterns);
    if (scrubbed.text !== s) throw new ToolRejection({ type: 'invalid', code: 'sensitive-source', detail: `argument "sources/${i}" contains sensitive data; nothing was stored` });
    if (!parseCitation(s).ok) throw new ToolRejection({ type: 'invalid', detail: `argument "sources/${i}" is not a well-formed citation` });
    findings.push(scrubbed.findings);
    if (!sources.includes(s)) sources.push(s);
  });
  return { sources, findings: mergeFindings(findings) };
}

function capture(env: InboxToolEnv, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  // Scrub every submitted field before anything touches the disk.
  const title = scrubToolInput(args['title'] as string, ctx, env.extraPatterns);
  const body = scrubToolInput(args['body'] as string, ctx, env.extraPatterns);
  const src = scrubSources(args['sources'], ctx, env);
  const displayTitle = cleanTitle(title.text);
  if (displayTitle === '') throw new ToolRejection({ type: 'invalid', detail: 'argument "title" has no visible characters' });

  const now = (env.now ?? (() => new Date()))();
  const id = ulid(now.getTime());
  const kind = typeof args['kind'] === 'string' ? args['kind'] : DEFAULT_CAPTURE_KIND;
  const text = renderProposal(
    { id, title: displayTitle, kind, created: isoSeconds(now), origin: 'mcp', author: ctx.principal.id, sources: src.sources, scrubVersion },
    body.text,
  );
  const written = writeInboxFile(env.vaultPath, toSlug(displayTitle), now, text);
  refreshIndex(env.index);

  const rev = revOf(text);
  const findings = mergeFindings([title.findings, body.findings, src.findings]);
  const header = {
    tool: 'capture',
    status: 'proposed',
    id,
    rev,
    path: written.relPath,
    citation: citationFor({ id, rev }),
    redacted: findings,
    notice: 'Stored as an unreviewed proposal in _inbox/. It is not curated memory until the owner accepts it.',
  };
  return { content: JSON.stringify(header), returned: [{ id, rev }], count: 1 };
}

function listInbox(env: InboxToolEnv, args: Record<string, unknown>, maxChars: number): ToolResult {
  const format: Format = args['format'] === 'compact' ? 'compact' : 'full';
  const limit = typeof args['limit'] === 'number' ? args['limit'] : INBOX_LIMIT.default;
  refreshIndex(env.index);
  const { db } = env.index;
  const vis = { includeSuperseded: false, includeArchived: false, now: (env.now ?? (() => new Date()))().getTime() };
  const candidates = allNoteRows(db)
    .filter((r: NoteRow) => r.folder_class === 'inbox' && isVisible(r, vis))
    .map((r) => rankItem({ row: r }));
  const ranked = rank(candidates).slice(0, limit);
  const items = ranked.map(({ item, tier }) => {
    const fields = { ...noteFields(item.row, tier), citation: citationFor(item.row) };
    if (format === 'full') Object.assign(fields, { title: item.row.title });
    const excerpt = truncateText(firstChunkText(db, item.row.path), format === 'compact' ? COMPACT_EXCERPT_CHARS : LIST_EXCERPT_CHARS);
    return { fields, excerpt };
  });
  return listResponse('list_inbox', format, items, maxChars, { matched: candidates.length, notice: PROPOSED_NOTICE });
}

/** Register `capture` and `list_inbox` (inbox mode only) into `registry`. */
export function registerInboxTools(env: InboxToolEnv, registry: ToolRegistry): void {
  registerTool(
    {
      name: 'capture',
      modes: ['inbox'],
      description:
        'Propose a note for the owner to review. It is saved under _inbox/ with status "proposed" (secrets redacted) and does not become ' +
        'curated memory until the owner accepts it. Cannot edit, move, or overwrite anything.',
      schema: CAPTURE_SCHEMA,
      handler: (args, ctx) => capture(env, args, ctx),
    },
    registry,
  );
  registerTool(
    {
      name: 'list_inbox',
      modes: ['inbox'],
      description: 'List proposed (unreviewed) notes in _inbox/ with citations. These are proposals, not established facts.',
      schema: LIST_INBOX_SCHEMA,
      handler: (args, ctx) => listInbox(env, args, ctx.maxChars),
    },
    registry,
  );
}
