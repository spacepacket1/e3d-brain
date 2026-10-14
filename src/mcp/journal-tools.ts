// The journal MCP tools (Phase 9): `journal_append` and `journal_list`,
// registered for `journal` mode only (an agent principal's own brain).
//
// `journal_append` scrubs everything the client submitted (title, body,
// sources) under strict agent rules before anything is written (I5: a
// credential rejects the whole call and stores nothing), then hands a
// sanitized slug and the rendered entry to the journal store, the only
// module an MCP tool can write a journal through (I2). It never accepts a
// path, and author/principal come from the instance config (the schema
// refuses them as unknown keys). `journal_list` lists the principal's own
// entries, fenced like every other read result (I6).

import { parseCitation } from '../cite/citation.js';
import type { JournalConfig } from '../config.js';
import { refreshIndex, type IndexHandle } from '../index/indexer.js';
import { allNoteRows, firstChunkText, type NoteRow } from '../index/query.js';
import { rank } from '../index/rank.js';
import { cleanTitle, isoSeconds, toSlug } from '../inbox/note.js';
import { DEFAULT_JOURNAL_KIND, expiresAt, JOURNAL_DIR, JOURNAL_KINDS, renderEntry } from '../journal/entry.js';
import { appendEntry, JournalRefusedError } from '../journal/store.js';
import type { SafePath } from '../safe-path.js';
import { scrubVersion, type ScrubFinding } from '../scrub/index.js';
import { foldKey } from '../vault/names.js';
import { revOf } from '../vault/parse.js';
import { registerTool, ToolRejection, type ToolContext, type ToolRegistry, type ToolResult } from './dispatch.js';
import { truncateText } from './fence.js';
import { MAX_CHARS_SCHEMA, type ObjectSchema } from './schema.js';
import { scrubToolInput } from './scrub-guard.js';
import {
  citationFor, COMPACT_EXCERPT_CHARS, isoToMs, isVisible, JOURNAL_NOTICE, LIST_EXCERPT_CHARS, listResponse, noteFields, rankItem,
  type Format,
} from './tools.js';
import { ulid } from './ulid.js';

export const MAX_TITLE_INPUT = 10_000;
/** Schema bound only; `journal.maxEntryChars` (default 4,000) is the enforced limit. */
export const MAX_BODY_INPUT = 100_000;
export const MAX_SOURCES = 50;
export const JOURNAL_LIST_LIMIT = { default: 20, max: 200 };

export interface JournalToolEnv {
  vaultPath: string;
  stateDir: SafePath;
  index: IndexHandle;
  limits: JournalConfig;
  /** `scrub.extraPatterns` from the instance config. */
  extraPatterns: readonly string[];
  /** Clock (tests inject one). */
  now?: () => Date;
  lockWaitMs?: number;
}

export const JOURNAL_APPEND_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_INPUT, description: 'Short title; becomes the file slug and the heading.' },
    body: { type: 'string', maxLength: MAX_BODY_INPUT, description: 'Entry text (Markdown); at most journal.maxEntryChars characters (default 4000).' },
    kind: { type: 'string', enum: JOURNAL_KINDS, description: `Default "${DEFAULT_JOURNAL_KIND}". A "lesson" citing thesis:, outcome:, commit:, or note: ranks higher.` },
    sources: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 4096 },
      maxItems: MAX_SOURCES,
      description: 'Source identifiers in citation form: note:<id>@<rev>, thesis:<id>, outcome:<id>, commit:<sha>, url:<url>, ref:...',
    },
    untrusted_origin: {
      type: 'boolean',
      description: 'Set when the entry is derived from untrusted content (web pages, social posts, inbound messages); needs a source.',
    },
  },
  required: ['title', 'body'],
};

export const JOURNAL_LIST_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    since: { type: 'string', maxLength: 40, description: 'ISO 8601 date or date-time: only entries created at or after it.' },
    kind: { type: 'string', enum: [...JOURNAL_KINDS, 'reference'], description: 'Only entries of this kind.' },
    limit: { type: 'integer', minimum: 1, maximum: JOURNAL_LIST_LIMIT.max, description: `Maximum results (default ${JOURNAL_LIST_LIMIT.default}).` },
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
function scrubSources(raw: unknown, ctx: ToolContext, env: JournalToolEnv): { sources: string[]; findings: ScrubFinding[] } {
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  const sources: string[] = [];
  const findings: ScrubFinding[][] = [];
  list.forEach((s, i) => {
    const scrubbed = scrubToolInput(s, ctx, env.extraPatterns);
    if (scrubbed.text !== s) throw new ToolRejection({ type: 'strict-scrub', code: 'sensitive-source', detail: `argument "sources/${i}" contains sensitive data; nothing was stored` });
    if (!parseCitation(s).ok) throw new ToolRejection({ type: 'invalid', detail: `argument "sources/${i}" is not a well-formed citation` });
    findings.push(scrubbed.findings);
    if (!sources.includes(s)) sources.push(s);
  });
  return { sources, findings: mergeFindings(findings) };
}

function journalAppend(env: JournalToolEnv, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  // Journal mode is agent-only (config), so scrubbing is strict; force it regardless.
  const strict: ToolContext = { ...ctx, principal: { ...ctx.principal, type: 'agent' } };
  const rawBody = args['body'] as string;
  const title = scrubToolInput(args['title'] as string, strict, env.extraPatterns);
  const body = scrubToolInput(rawBody, strict, env.extraPatterns);
  const src = scrubSources(args['sources'], strict, env);
  const displayTitle = cleanTitle(title.text);
  if (displayTitle === '') throw new ToolRejection({ type: 'invalid', detail: 'argument "title" has no visible characters' });
  const untrusted = args['untrusted_origin'] === true;
  if (untrusted && src.sources.length === 0) {
    throw new ToolRejection({ type: 'invalid', detail: 'an entry with untrusted_origin needs at least one source reference' });
  }

  const now = (env.now ?? (() => new Date()))();
  const id = ulid(now.getTime());
  const kind = typeof args['kind'] === 'string' ? args['kind'] : DEFAULT_JOURNAL_KIND;
  const text = renderEntry(
    {
      id, title: displayTitle, author: ctx.principal.id, origin: 'mcp', created: isoSeconds(now), kind, sources: src.sources,
      untrustedOrigin: untrusted, expires: expiresAt(now, env.limits.ttlDays), scrubVersion,
    },
    body.text,
  );
  let written: { relPath: string };
  try {
    const storeEnv = { vaultPath: env.vaultPath, stateDir: env.stateDir, limits: env.limits, ...(env.lockWaitMs === undefined ? {} : { lockWaitMs: env.lockWaitMs }) };
    written = appendEntry(storeEnv, {
      principalId: ctx.principal.id, slug: toSlug(displayTitle), when: now, text, body: body.text, submittedChars: rawBody.length,
    });
  } catch (err) {
    if (err instanceof JournalRefusedError) {
      const type = err.code === 'exists' ? 'invalid' : 'limit';
      throw new ToolRejection({ type, code: err.code, detail: err.message });
    }
    throw err;
  }
  refreshIndex(env.index);

  const rev = revOf(text);
  const header = {
    tool: 'journal_append',
    status: 'journal',
    id,
    rev,
    path: written.relPath,
    citation: citationFor({ id, rev }),
    expires: expiresAt(now, env.limits.ttlDays),
    redacted: mergeFindings([title.findings, body.findings, src.findings]),
    notice: 'Stored as an agent journal entry (labeled agent-journal, ranked below curated notes). It is never promoted automatically.',
  };
  return { content: JSON.stringify(header), returned: [{ id, rev }], count: 1 };
}

function journalList(env: JournalToolEnv, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const format: Format = args['format'] === 'compact' ? 'compact' : 'full';
  const limit = typeof args['limit'] === 'number' ? args['limit'] : JOURNAL_LIST_LIMIT.default;
  let since: number | undefined;
  if (typeof args['since'] === 'string') {
    since = isoToMs(args['since']);
    if (since === undefined) throw new ToolRejection({ type: 'invalid', detail: 'argument "since" must be an ISO 8601 date or date-time' });
  }
  const kind = typeof args['kind'] === 'string' ? args['kind'] : undefined;
  const prefix = foldKey(`${JOURNAL_DIR}/${ctx.principal.id}/`);
  refreshIndex(env.index);
  const { db } = env.index;
  const vis = { includeSuperseded: false, includeArchived: false, now: (env.now ?? (() => new Date()))().getTime() };
  const createdMs = (r: NoteRow) => (r.created === null ? undefined : isoToMs(r.created));
  const candidates = allNoteRows(db)
    .filter((r) => r.folder_class === 'journal' && foldKey(r.path).startsWith(prefix) && isVisible(r, vis))
    .filter((r) => kind === undefined || r.kind === kind)
    .filter((r) => since === undefined || (createdMs(r) ?? Number.NEGATIVE_INFINITY) >= since)
    .map((r) => rankItem({ row: r }));
  const ranked = rank(candidates, { newestFirst: true }).slice(0, limit);
  const items = ranked.map(({ item, tier }) => {
    const fields = { ...noteFields(item.row, tier), created: item.row.created, citation: citationFor(item.row) };
    if (format === 'full') Object.assign(fields, { title: item.row.title });
    const excerpt = truncateText(firstChunkText(db, item.row.path), format === 'compact' ? COMPACT_EXCERPT_CHARS : LIST_EXCERPT_CHARS);
    return { fields, excerpt };
  });
  return listResponse('journal_list', format, items, ctx.maxChars, { matched: candidates.length, notice: JOURNAL_NOTICE });
}

/** Register `journal_append` and `journal_list` (journal mode only) into `registry`. */
export function registerJournalTools(env: JournalToolEnv, registry: ToolRegistry): void {
  registerTool(
    {
      name: 'journal_append',
      modes: ['journal'],
      description:
        'Record a new entry in your own journal (journal/<principal-id>/). Create-only: it cannot edit, append to, move, or delete ' +
        'entries. Secrets reject the whole entry. Size, rate, and duplicate limits apply; entries expire after the configured TTL.',
      schema: JOURNAL_APPEND_SCHEMA,
      handler: (args, ctx) => journalAppend(env, args, ctx),
    },
    registry,
  );
  registerTool(
    {
      name: 'journal_list',
      modes: ['journal'],
      description: 'List your own journal entries (newest first within each tier), optionally since a date or by kind.',
      schema: JOURNAL_LIST_SCHEMA,
      handler: (args, ctx) => journalList(env, args, ctx),
    },
    registry,
  );
}
