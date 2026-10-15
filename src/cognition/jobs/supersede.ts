// `supersede` (cognition Phase 4): "did a newer decision or fact replace an
// older one?"
//
// Candidates (deterministic, no model). Eligible notes are curated, not in a
// hidden folder, effectively accepted (no status, or `status: accepted`),
// have an assigned id (C3: provisional ids are skipped and counted), and
// have a date (`occurred`, else `created`; undated notes are skipped and
// counted). A pair of eligible notes is a candidate when it shares a topic
// signal:
//   - a non-trivial tag: not in TRIVIAL_TAGS, not `ebrain-*`, and carried by
//     at most MAX_TAG_NOTES eligible notes;
//   - a mutual wikilink (each note links to the other);
//   - the same `kind` in {decision, preference, fact} plus 3-word-shingle
//     Jaccard of at least `cognition.supersede.minJaccard`;
// and its dates differ (the later date is the newer note). A pair whose
// older note is `pinned` is never proposed (counted). With `--since`, pairs
// whose newer note is dated earlier are left out.
// Priority: newer note's date, newest first; then newer path, then older
// path (bytewise).
//
// Adjudication. With an LLM provider, each pair is classified (prompt
// `supersede.v1`) as `supersedes | conflicts | compatible | unrelated`, with
// the exact conflicting sentence quoted from each note. Each quote must
// appear verbatim (whitespace runs compared as one space) in its note's
// body, else the item is dropped and counted. `supersedes` yields a
// `supersede` proposal; `conflicts` (neither clearly replaces the other)
// yields a `gap` proposal asking the owner to decide, with no change block;
// `compatible` and `unrelated` yield nothing. Without a provider, up to
// `cognition.supersede.maxUnadjudicated` pairs become `supersede` proposals
// marked `needs_review: unadjudicated`, quoting an excerpt of each note.
//
// The supersede change block sets on the older note `status: superseded`,
// `superseded_by: <newer id>`, `superseded_at` and `valid_until` (both the
// newer note's date, so `as_of` before it still shows the older note), and
// on the newer note `supersedes` (its existing list plus the older id).
// Pairs already proposed (open or applied, as supersede or gap) or rejected
// are skipped before any model call (C5), so a re-run is idempotent.

import { formatCitation } from '../../cite/citation.js';
import { allNoteRows, tagsByPath, type NoteRow } from '../../index/query.js';
import type { ItemSchema } from '../../llm/schema.js';
import { fenceFor, truncateText } from '../../mcp/fence.js';
import { isoToMs } from '../../mcp/tools.js';
import type { ChangeOp } from '../../review/proposal.js';
import { readFileWithStatSafe, resolveInVault } from '../../safe-path.js';
import { compareBytes } from '../../vault/names.js';
import { splitFrontmatter } from '../../vault/parse.js';
import type { CognitionJob, Draft, JobContext, JobOutput } from '../run.js';
import { jaccard, shingles } from '../shingle.js';

/** Kinds whose same-kind, high-overlap pairs are candidates. */
export const TOPIC_KINDS: readonly string[] = ['decision', 'preference', 'fact'];
/** Tags too generic to signal a shared topic (in addition to `ebrain-*`). */
export const TRIVIAL_TAGS: readonly string[] = [
  'todo', 'done', 'wip', 'draft', 'inbox', 'journal', 'log', 'misc', 'note', 'notes', 'idea', 'ideas', 'meta', 'important', 'review', 'archive',
];
/** A tag on more eligible notes than this is too broad to pair on. */
export const MAX_TAG_NOTES = 25;
export const RELATIONS = ['supersedes', 'conflicts', 'compatible', 'unrelated'] as const;
export type Relation = (typeof RELATIONS)[number];
const NOTE_CHARS = 4000;
const QUOTE_MAX = 500;
/** Shortest quote accepted as evidence (a few words, not a fragment). */
export const MIN_QUOTE_CHARS = 8;
const EXCERPT_CHARS = 200;
const ACCEPTED_STATUSES = new Set([null, 'accepted']);
const VERDICT_SCHEMA: ItemSchema = {
  relation: { type: 'enum', values: RELATIONS },
  older_quote: { type: 'string', min: 0, max: QUOTE_MAX },
  newer_quote: { type: 'string', min: 0, max: QUOTE_MAX },
  reason: { type: 'string', min: 1, max: 300 },
};

interface Verdict {
  relation: Relation;
  older_quote: string;
  newer_quote: string;
  reason: string;
}

interface Note {
  row: NoteRow;
  /** `occurred`, else `created`, as stored. */
  date: string;
  dateMs: number;
  pinned: boolean;
  supersedes: string[];
}

interface Pair {
  older: Note;
  newer: Note;
  signals: string[];
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** True when `quote` (at least MIN_QUOTE_CHARS) appears verbatim in `body`, whitespace runs compared as one space. */
export function quoteAppears(quote: string, body: string): boolean {
  const q = oneLine(quote);
  return q.length >= MIN_QUOTE_CHARS && oneLine(body).includes(q);
}

/** The note body (after frontmatter), read from the vault. */
function bodyOf(ctx: JobContext, rel: string): string {
  const text = readFileWithStatSafe(resolveInVault(ctx.config.vaultPath, rel), { maxBytes: 4 * 1024 * 1024 }).data.toString('utf8');
  return splitFrontmatter(text.replace(/^﻿/, '')).body.replace(/\r\n?/g, '\n');
}

/** A verbatim excerpt: the first line of prose (no heading, comment, or tag-only line), cut at EXCERPT_CHARS. */
function excerptOf(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('```') || line.startsWith('>')) continue;
    return line.slice(0, EXCERPT_CHARS);
  }
  return '';
}

/** Candidate pairs in priority order (see the module comment). */
function candidates(ctx: JobContext): Pair[] {
  const { db } = ctx.index;
  const extra = db.prepare('SELECT pinned, supersedes FROM notes WHERE path = ?');
  const notes = new Map<string, Note>();
  for (const r of allNoteRows(db)) {
    if (r.folder_class !== 'curated' || r.folder_hidden !== 0 || r.status_known !== 1 || !ACCEPTED_STATUSES.has(r.status)) continue;
    if (r.provisional === 1) {
      ctx.count('skipped_provisional');
      continue;
    }
    const date = r.occurred ?? r.created;
    const dateMs = date === null ? undefined : isoToMs(date);
    if (date === null || dateMs === undefined) {
      ctx.count('skipped_undated');
      continue;
    }
    const e = extra.get(r.path) as { pinned: number | null; supersedes: string };
    const supersedes = (JSON.parse(e.supersedes) as unknown[]).filter((x): x is string => typeof x === 'string');
    notes.set(r.path, { row: r, date, dateMs, pinned: e.pinned === 1, supersedes });
  }
  ctx.count('eligible_notes', notes.size);

  const signals = new Map<string, { a: string; b: string; s: Set<string> }>();
  const add = (p: string, q: string, signal: string): void => {
    if (p === q) return;
    const [a, b] = compareBytes(p, q) < 0 ? [p, q] : [q, p];
    const k = `${a}\0${b}`;
    const entry = signals.get(k) ?? { a, b, s: new Set<string>() };
    entry.s.add(signal);
    signals.set(k, entry);
  };

  const byTag = new Map<string, string[]>();
  for (const [p, tags] of tagsByPath(db)) {
    if (!notes.has(p)) continue;
    for (const t of tags) {
      if (TRIVIAL_TAGS.includes(t) || t.startsWith('ebrain-')) continue;
      byTag.set(t, [...(byTag.get(t) ?? []), p]);
    }
  }
  for (const [t, paths] of byTag) {
    if (paths.length > MAX_TAG_NOTES) {
      ctx.count('broad_tags_ignored');
      continue;
    }
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) add(paths[i]!, paths[j]!, `tag #${t}`);
  }

  const mutual = db.prepare(
    `SELECT DISTINCT a.note_path AS p, a.resolved_path AS q FROM links a
     JOIN links b ON b.note_path = a.resolved_path AND b.resolved_path = a.note_path
     WHERE a.resolved_path IS NOT NULL AND a.note_path <> a.resolved_path`,
  ).all() as { p: string; q: string }[];
  for (const m of mutual) if (notes.has(m.p) && notes.has(m.q)) add(m.p, m.q, 'mutual wikilink');

  const chunkText = db.prepare('SELECT text FROM chunks WHERE note_path = ? ORDER BY ordinal');
  const byKind = new Map<string, { path: string; sh: Set<string> }[]>();
  for (const [p, n] of notes) {
    if (n.row.kind === null || !TOPIC_KINDS.includes(n.row.kind)) continue;
    const text = (chunkText.all(p) as { text: string }[]).map((c) => c.text).join('\n');
    byKind.set(n.row.kind, [...(byKind.get(n.row.kind) ?? []), { path: p, sh: shingles(text) }]);
  }
  for (const [kind, list] of byKind) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (jaccard(list[i]!.sh, list[j]!.sh) >= ctx.config.cognition.supersede.minJaccard) add(list[i]!.path, list[j]!.path, `same kind ${kind}, high text overlap`);
      }
    }
  }

  const pairs: Pair[] = [];
  for (const { a, b, s } of signals.values()) {
    const [x, y] = [notes.get(a)!, notes.get(b)!];
    if (x.dateMs === y.dateMs) {
      ctx.count('skipped_same_date');
      continue;
    }
    const [older, newer] = x.dateMs < y.dateMs ? [x, y] : [y, x];
    if (older.pinned) {
      ctx.count('skipped_pinned');
      continue;
    }
    if (ctx.sinceMs !== undefined && newer.dateMs < ctx.sinceMs) {
      ctx.count('skipped_since');
      continue;
    }
    pairs.push({ older, newer, signals: [...s].sort(compareBytes) });
  }
  ctx.count('candidates', pairs.length);
  return pairs.sort((p, q) => q.newer.dateMs - p.newer.dateMs || compareBytes(p.newer.row.path, q.newer.row.path) || compareBytes(p.older.row.path, q.older.row.path));
}

function describe(label: string, n: Note): string {
  return `- ${label}: **${oneLine(n.row.title)}** (\`${n.row.path}\`, ${n.row.occurred !== null ? 'occurred' : 'created'} ${n.date}, \`note:${n.row.id}@${n.row.rev}\`)`;
}

function supersedeOps(p: Pair): ChangeOp[] {
  const { older, newer } = p;
  const until = newer.row.occurred ?? newer.date;
  return [
    { op: 'set_frontmatter', target: older.row.id, key: 'status', value: 'superseded' },
    { op: 'set_frontmatter', target: older.row.id, key: 'superseded_by', value: newer.row.id },
    { op: 'set_frontmatter', target: older.row.id, key: 'superseded_at', value: newer.date },
    { op: 'set_frontmatter', target: older.row.id, key: 'valid_until', value: until },
    { op: 'set_frontmatter', target: newer.row.id, key: 'supersedes', value: [...new Set([...newer.supersedes, older.row.id])] },
  ];
}

function draftFor(p: Pair, kind: 'supersede' | 'gap', quotes: { older: string; newer: string; label: string }, reason?: string): Draft {
  const { older, newer } = p;
  const lines = kind === 'supersede'
    ? [`The newer note appears to replace the older one. Accepting marks \`${older.row.path}\` superseded by \`${newer.row.path}\`; \`ebrain review undo\` restores both notes.`]
    : ['These notes conflict and neither clearly replaces the other. Decide which holds (edit or supersede one by hand), then accept this report to file it, or reject it.'];
  lines.push('', describe('Older', older), describe('Newer', newer), '', `Topic signals: ${p.signals.join('; ')}.`, '', `${quotes.label} from the older note:`, '', `> ${oneLine(quotes.older) || '(no excerpt)'}`, '', `${quotes.label} from the newer note:`, '', `> ${oneLine(quotes.newer) || '(no excerpt)'}`);
  if (reason !== undefined) lines.push('', `Model reason (unverified): ${oneLine(reason)}`);
  const draft: Draft = {
    proposal_type: kind,
    title: kind === 'supersede' ? `Supersede: ${oneLine(older.row.title)} replaced by ${oneLine(newer.row.title)}` : `Conflict: ${oneLine(older.row.title)} vs ${oneLine(newer.row.title)}`,
    rationale: lines.join('\n'),
    targets: [older, newer].map((n) => ({ id: n.row.id, rev: n.row.rev, path_at_proposal: n.row.path })),
    evidence: [older, newer].map((n) => formatCitation({ kind: 'note', id: n.row.id, rev: n.row.rev })),
    ops: kind === 'supersede' ? supersedeOps(p) : [],
  };
  return draft;
}

async function generate(ctx: JobContext): Promise<JobOutput> {
  const drafts: Draft[] = [];
  let unadjudicated = 0;
  for (const p of candidates(ctx)) {
    const evidence = [p.older, p.newer].map((n) => formatCitation({ kind: 'note', id: n.row.id, rev: n.row.rev }));
    if (ctx.known(['supersede', 'gap'], evidence)) continue;
    if (ctx.llm === undefined) {
      if (unadjudicated >= ctx.config.cognition.supersede.maxUnadjudicated) {
        ctx.count('unadjudicated_capped');
        continue;
      }
      ctx.input(p.older.row.id, p.older.row.rev);
      ctx.input(p.newer.row.id, p.newer.row.rev);
      unadjudicated++;
      const d = draftFor(p, 'supersede', { older: excerptOf(bodyOf(ctx, p.older.row.path)), newer: excerptOf(bodyOf(ctx, p.newer.row.path)), label: 'Excerpt' });
      drafts.push({ ...d, needs_review: 'unadjudicated' });
      continue;
    }
    ctx.input(p.older.row.id, p.older.row.rev);
    ctx.input(p.newer.row.id, p.newer.row.rev);
    const bodies = { older: bodyOf(ctx, p.older.row.path), newer: bodyOf(ctx, p.newer.row.path) };
    const block = (label: string, n: Note, body: string): string => {
      const text = ctx.scrubText(truncateText(body, NOTE_CHARS)) ?? '';
      const f = fenceFor(text);
      return `${label} note title: ${ctx.scrubText(oneLine(n.row.title)) ?? ''}\n${label} note date: ${n.date}\n${label} note text:\n${f}text\n${text}\n${f}`;
    };
    const res = await ctx.llm.ask<Verdict>(`${block('Older', p.older, bodies.older)}\n\n${block('Newer', p.newer, bodies.newer)}`, 'items', VERDICT_SCHEMA, 1);
    if (res.stop !== undefined) return { drafts, stop: res.stop };
    const v = res.items[0];
    if (v === undefined) {
      ctx.count('no_verdict');
      continue;
    }
    ctx.count(`relation_${v.relation}`);
    if (v.relation === 'compatible' || v.relation === 'unrelated') continue;
    if (!quoteAppears(v.older_quote, bodies.older) || !quoteAppears(v.newer_quote, bodies.newer)) {
      ctx.count('quotes_unverified');
      continue;
    }
    drafts.push(draftFor(p, v.relation === 'supersedes' ? 'supersede' : 'gap', { older: v.older_quote, newer: v.newer_quote, label: 'Quote' }, v.reason));
  }
  return { drafts };
}

export const SUPERSEDE_JOB: CognitionJob = {
  name: 'supersede',
  version: 1,
  description: 'propose marking older notes superseded by newer ones on the same topic (optional LLM adjudication)',
  llm: 'optional',
  generate,
};
