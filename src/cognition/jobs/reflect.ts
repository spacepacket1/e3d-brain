// `reflect` (cognition Phase 6): "what did outcomes teach us?"
//
// Ground truth is required: the run refuses to start (creating nothing)
// when no evidence source is configured (`evidence: 'required'`), and it
// needs an LLM provider (lessons are model-proposed, then checked here).
//
// Pairing is structural, never by timestamp proximity. Source notes are this
// principal's journal entries (`journal/<principal-id>/`) and curated notes
// (effectively accepted; not `lesson`, `summary`, or `proposal` notes) whose
// `sources` cite `thesis:<id>`. A thesis is reflected on when its record
// resolves in local evidence, it is closed (an `attributes.status`, if
// present, is `closed`), and at least one `outcome` record has
// `attributes.thesis` equal to its id ("what we expected" vs "what
// happened"). Notes need an assigned id (C3: provisional ids are skipped and
// counted); at most MAX_SOURCES entries per thesis are shown (newest first).
// With `cognition.reflect.decisions` (the human-brain variant, off by
// default) a curated `decision` note plus later notes whose `sources` cite it
// and that record an outcome (tag `#outcome` or an `outcome:` frontmatter
// key) form a group the same way, cited as `note:<id>@<rev>`.
// Priority: the latest outcome date, newest first; then the thesis id or
// decision path (bytewise). With `--since`, groups whose latest outcome is
// earlier are left out.
//
// Each group is one model call (prompt `reflect.v1`) asking for at most
// `cognition.reflect.maxLessons` lessons, each with `applies_when`, the
// expected-vs-actual comparison, and citations. A lesson is dropped and
// counted when:
//   - any field holds a URL, a wallet-style `0x` address, a code fence, or a
//     verb on the ACTION_VERBS deny-list (lessons are advisory, never an
//     instruction to act);
//   - any citation is malformed or does not resolve (Phase 3 resolver: notes
//     at their cited rev, `thesis:`/`outcome:` in local evidence), or cites
//     something outside its group, or it lacks an entry, the thesis (or
//     decision), and an outcome;
//   - any numeric token in its fields is absent from the cited records;
//   - strict-mode scrubbing finds anything in it;
//   - it repeats an existing accepted lesson (3-word-shingle Jaccard at least
//     `cognition.reflect.minDuplicateJaccard`) or another lesson of the run.
// Existing accepted lessons related to the group (a shared non-trivial tag,
// or `derived_from` citing the same thesis or decision) are shown to the
// model; a lesson that contradicts one, with the contradicted sentence quoted
// verbatim (Phase 4 rule), becomes a `supersede` proposal against it that
// creates the replacing lesson and marks the old one superseded, never a
// second lesson. The remaining lessons of a group form one `lesson` proposal
// whose evidence is the whole group (so its key is stable, C5, and a re-run
// skips the group before any model call).
//
// On accept each lesson is created at `lessons/<principal-id>/<slug>-<hash>.md`
// with `kind: lesson`, `status: accepted`, `applies_when`, and `derived_from`
// (its own citations); as a curated note it ranks at T1. A group with any
// `untrusted_origin` source taints its lessons and proposals (C8).

import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { formatCitation, parseCitation } from '../../cite/citation.js';
import { CitationResolver } from '../../cite/resolve.js';
import type { Attributes } from '../../evidence/record.js';
import type { EvidenceSource } from '../../evidence/source.js';
import { isoSeconds, toSlug } from '../../inbox/note.js';
import { noteLookup } from '../../index/identity.js';
import { allNoteRows, tagsByPath, type NoteRow } from '../../index/query.js';
import type { ItemSchema } from '../../llm/schema.js';
import { fenceFor, truncateText } from '../../mcp/fence.js';
import { isoToMs } from '../../mcp/tools.js';
import { ulid } from '../../mcp/ulid.js';
import type { ChangeOp } from '../../review/proposal.js';
import { readFileWithStatSafe, resolveInVault } from '../../safe-path.js';
import { scrub } from '../../scrub/index.js';
import { compareBytes } from '../../vault/names.js';
import { splitFrontmatter } from '../../vault/parse.js';
import type { CognitionJob, Draft, JobContext, JobOutput } from '../run.js';
import { jaccard, shingles } from '../shingle.js';
import { quoteAppears, TRIVIAL_TAGS } from './supersede.js';

export const LESSONS_DIR = 'lessons';
/** Most source notes shown per group (newest first). */
export const MAX_SOURCES = 8;
/** Most related existing lessons shown per group. */
export const MAX_EXISTING = 5;
const NOTE_CHARS = 1500;
const ACCEPTED_STATUSES = new Set([null, 'accepted']);
const SOURCE_EXCLUDED_KINDS = new Set(['lesson', 'summary', 'proposal']);
/** The standing line every lesson note carries. */
export const ADVISORY_LINE = '> **Advisory, unverified:** a model-proposed lesson from recorded outcomes. It never authorizes spending, signing, or any action.';

/**
 * The deny-list of action verbs (all forms listed): a lesson containing one
 * is dropped. Lessons advise future reasoning; they never instruct an action.
 */
export const ACTION_VERBS: readonly string[] = [
  'transfer', 'transfers', 'transferred', 'transferring',
  'sign', 'signs', 'signed', 'signing',
  'approve', 'approves', 'approved', 'approving',
  'send', 'sends', 'sent', 'sending',
  'withdraw', 'withdraws', 'withdrew', 'withdrawn', 'withdrawing',
  'execute', 'executes', 'executed', 'executing',
  'authorize', 'authorizes', 'authorized', 'authorizing', 'authorise', 'authorises', 'authorised', 'authorising',
  'spend', 'spends', 'spent', 'spending',
];
const ACTION_VERB_RE = new RegExp(`\\b(?:${ACTION_VERBS.join('|')})\\b`, 'i');
const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/|\bwww\.[a-z0-9-]/i;
const ADDRESS_RE = /\b0x[0-9a-f]{4,}/i;
const FENCE_RE = /```|~~~/;

export type Guardrail = 'url' | 'address' | 'code' | 'action_verb';

/** The first guardrail `text` violates, or undefined. */
export function guardrailViolation(text: string): Guardrail | undefined {
  if (URL_RE.test(text)) return 'url';
  if (ADDRESS_RE.test(text)) return 'address';
  if (FENCE_RE.test(text)) return 'code';
  if (ACTION_VERB_RE.test(text)) return 'action_verb';
  return undefined;
}

/** Normalized numeric tokens: thousands separators dropped, decimal comma as point, leading and trailing zeros trimmed. */
export function numericTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const n = m[0].replace(/,(?=\d{3}(?!\d))/g, '').replace(/,/g, '.');
    const [int, ...frac] = n.split('.');
    const i = int!.replace(/^0+(?=\d)/, '');
    const f = frac.join('').replace(/0+$/, '');
    out.add(frac.length === 0 || f === '' ? i : `${i}.${f}`);
  }
  return out;
}

/** Numeric tokens of `text` that are not in `corpus`. */
export function unsupportedNumbers(text: string, corpus: ReadonlySet<string>): string[] {
  return [...numericTokens(text)].filter((t) => !corpus.has(t));
}

interface Source {
  row: NoteRow;
  body: string;
  cite: string;
  date: string;
  dateMs: number;
}

interface RecordItem {
  cite: string;
  kind: 'thesis' | 'outcome';
  occurred: string;
  summary: string;
  attributes: Attributes;
}

interface Group {
  /** `thesis th_1` or `decision "<title>"`. */
  label: string;
  /** Thesis id, or the decision note path: tie-break of the priority order. */
  key: string;
  /** Shown and citable notes: entries before the outcome (thesis), or the decision then the outcome notes. */
  sources: Source[];
  /** Thesis then outcome records (empty for a decision group). */
  records: RecordItem[];
  /** The "expected" side: `thesis:<id>`, or the decision note's citation. */
  anchor: string;
  /** The "actual" side: outcome record citations, or outcome note citations. */
  outcomes: string[];
  latestMs: number;
  tags: Set<string>;
}

interface Existing {
  row: NoteRow;
  body: string;
  cite: string;
  text: string;
  sh: Set<string>;
  tags: string[];
  derived: string[];
}

interface LessonItem {
  lesson: string;
  applies_when: string;
  expected: string;
  actual: string;
  citations: string;
  conflicts_with: string;
  conflict_quote: string;
}

interface Lesson {
  lesson: string;
  applies_when: string;
  expected: string;
  actual: string;
  citations: string[];
  /** The existing lesson this one contradicts, with the contradicted sentence (verified verbatim). */
  conflict?: { lesson: Existing; quote: string };
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function bodyOf(ctx: JobContext, rel: string): string {
  const text = readFileWithStatSafe(resolveInVault(ctx.config.vaultPath, rel), { maxBytes: 4 * 1024 * 1024 }).data.toString('utf8');
  return splitFrontmatter(text.replace(/^﻿/, '')).body.replace(/\r\n?/g, '\n');
}

/** The prose of a lesson note: no headings, quotes, list items, or comments (our template's lesson paragraph; a hand-written note's prose). */
function lessonTextOf(body: string): string {
  return oneLine(body.split('\n').filter((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('- ') && !t.startsWith('<!--');
  }).join(' '));
}

const citesOf = (json: string): string[] => (JSON.parse(json) as unknown[]).filter((x): x is string => typeof x === 'string');

function topicTags(tags: readonly string[]): string[] {
  return tags.filter((t) => !TRIVIAL_TAGS.includes(t) && !t.startsWith('ebrain-'));
}

/** Source notes eligible for thesis pairing, and decision groups when configured. */
function groups(ctx: JobContext, evidence: EvidenceSource): Group[] {
  const { db } = ctx.index;
  const principal = ctx.config.principal.id;
  const tags = tagsByPath(db);
  const extra = db.prepare('SELECT extra FROM notes WHERE path = ?');
  const asSource = (r: NoteRow): Source | undefined => {
    const date = r.occurred ?? r.created;
    const dateMs = date === null ? undefined : isoToMs(date);
    if (date === null || dateMs === undefined) {
      ctx.count('skipped_undated');
      return undefined;
    }
    return { row: r, body: bodyOf(ctx, r.path), cite: formatCitation({ kind: 'note', id: r.id, rev: r.rev }), date, dateMs };
  };
  const isOwnEntry = (r: NoteRow): boolean => r.folder_class === 'journal' && r.path.split('/')[1] === principal && (r.status === 'journal' || ACCEPTED_STATUSES.has(r.status));
  const isCurated = (r: NoteRow): boolean => r.folder_class === 'curated' && ACCEPTED_STATUSES.has(r.status);
  const rows = allNoteRows(db).filter((r) => r.folder_hidden === 0 && r.status_known === 1 && (isOwnEntry(r) || isCurated(r)));

  const byThesis = new Map<string, Source[]>();
  for (const r of rows) {
    if (r.kind !== null && SOURCE_EXCLUDED_KINDS.has(r.kind)) continue;
    const theses = citesOf(r.sources).flatMap((c) => {
      const p = parseCitation(c);
      return p.ok && p.citation.kind === 'thesis' ? [p.citation.id] : [];
    });
    if (theses.length === 0) continue;
    if (r.provisional === 1) {
      ctx.count('skipped_provisional');
      continue;
    }
    const s = asSource(r);
    if (s === undefined) continue;
    for (const t of new Set(theses)) byThesis.set(t, [...(byThesis.get(t) ?? []), s]);
  }

  const outcomesByThesis = new Map<string, RecordItem[]>();
  for (const o of evidence.list('outcome')) {
    const t = o.attributes['thesis'];
    if (typeof t !== 'string') continue;
    outcomesByThesis.set(t, [...(outcomesByThesis.get(t) ?? []), { cite: `outcome:${o.id}`, kind: 'outcome', occurred: o.occurred, summary: o.summary, attributes: o.attributes }]);
  }

  const out: Group[] = [];
  const newestFirst = (a: Source, b: Source): number => b.dateMs - a.dateMs || compareBytes(a.row.path, b.row.path);
  for (const [thesis, list] of byThesis) {
    const th = evidence.resolve('thesis', thesis);
    if (!th.found) {
      ctx.count('skipped_thesis_unresolved');
      continue;
    }
    const status = th.attributes['status'];
    if (status !== undefined && status !== 'closed') {
      ctx.count('skipped_open_thesis');
      continue;
    }
    const outcomes = outcomesByThesis.get(thesis) ?? [];
    if (outcomes.length === 0) {
      ctx.count('skipped_no_outcome');
      continue;
    }
    const sources = [...list].sort(newestFirst).slice(0, MAX_SOURCES).reverse();
    out.push({
      label: `thesis ${thesis}`, key: thesis, sources,
      records: [{ cite: `thesis:${thesis}`, kind: 'thesis', occurred: th.occurred, summary: th.summary, attributes: th.attributes }, ...outcomes],
      anchor: `thesis:${thesis}`, outcomes: outcomes.map((o) => o.cite),
      latestMs: Math.max(...outcomes.map((o) => Date.parse(o.occurred))),
      tags: new Set(sources.flatMap((s) => topicTags(tags.get(s.row.path) ?? []))),
    });
  }

  if (ctx.config.cognition.reflect.decisions) {
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const citing = db.prepare("SELECT DISTINCT from_path AS p FROM cites WHERE to_id = ? AND field = 'sources'");
    for (const d of rows) {
      if (d.kind !== 'decision' || d.folder_class !== 'curated' || d.provisional === 1) continue;
      const decision = asSource(d);
      if (decision === undefined) continue;
      const results: Source[] = [];
      for (const { p } of citing.all(d.id) as { p: string }[]) {
        const r = byPath.get(p);
        if (r === undefined || r.provisional === 1 || r.path === d.path) continue;
        const ex = JSON.parse((extra.get(r.path) as { extra: string }).extra) as Record<string, unknown>;
        if (!(tags.get(r.path) ?? []).includes('outcome') && !Object.hasOwn(ex, 'outcome')) continue;
        const s = asSource(r);
        if (s !== undefined && s.dateMs > decision.dateMs) results.push(s);
      }
      if (results.length === 0) continue;
      const shown = results.sort(newestFirst).slice(0, MAX_SOURCES - 1).reverse();
      out.push({
        label: `decision "${oneLine(d.title)}"`, key: d.path, sources: [decision, ...shown], records: [],
        anchor: decision.cite, outcomes: shown.map((s) => s.cite), latestMs: Math.max(...shown.map((s) => s.dateMs)),
        tags: new Set([decision, ...shown].flatMap((s) => topicTags(tags.get(s.row.path) ?? []))),
      });
    }
  }
  ctx.count('groups', out.length);
  return out.sort((a, b) => b.latestMs - a.latestMs || compareBytes(a.key, b.key));
}

/** Accepted curated lessons (any folder), with assigned ids. */
function existingLessons(ctx: JobContext): Existing[] {
  const { db } = ctx.index;
  const tags = tagsByPath(db);
  const derived = db.prepare('SELECT derived_from FROM notes WHERE path = ?');
  return allNoteRows(db)
    .filter((r) => r.kind === 'lesson' && r.folder_class === 'curated' && r.folder_hidden === 0 && r.status_known === 1 && ACCEPTED_STATUSES.has(r.status) && r.provisional === 0)
    .map((r) => {
      const body = bodyOf(ctx, r.path);
      const text = lessonTextOf(body);
      return {
        row: r, body, text, sh: shingles(text), cite: formatCitation({ kind: 'note', id: r.id, rev: r.rev }),
        tags: topicTags(tags.get(r.path) ?? []), derived: citesOf((derived.get(r.path) as { derived_from: string }).derived_from),
      };
    })
    .sort((a, b) => compareBytes(a.row.path, b.row.path));
}

function related(g: Group, all: readonly Existing[]): Existing[] {
  const anchorId = (c: string): string => {
    const p = parseCitation(c);
    return p.ok && p.citation.kind === 'note' ? `note:${p.citation.id}` : c;
  };
  const anchor = anchorId(g.anchor);
  return all.filter((e) => e.tags.some((t) => g.tags.has(t)) || e.derived.some((c) => anchorId(c) === anchor)).slice(0, MAX_EXISTING);
}

/** All numeric tokens of the cited records: note titles and bodies; record ids, dates, summaries, and attribute values. */
function corpusOf(g: Group, cites: readonly string[]): Set<string> {
  const parts: string[] = [...cites];
  for (const s of g.sources) if (cites.includes(s.cite)) parts.push(s.row.title, s.body, s.date);
  for (const r of g.records) if (cites.includes(r.cite)) parts.push(r.occurred, r.summary, JSON.stringify(r.attributes));
  return numericTokens(parts.join('\n'));
}

function promptInput(ctx: JobContext, g: Group, rel: readonly Existing[], max: number): string {
  const s = (t: string): string => ctx.scrubText(t) ?? '';
  const fenced = (t: string): string => {
    const f = fenceFor(t);
    return `${f}text\n${t}\n${f}`;
  };
  const lines = [`Reflect topic: ${s(g.label)}`, `Lessons wanted: at most ${max}`, ''];
  for (const r of g.records) {
    lines.push(`Record [${r.cite}] occurred: ${r.occurred}`, `Record [${r.cite}] summary: ${s(oneLine(r.summary))}`, `Record [${r.cite}] attributes: ${s(JSON.stringify(r.attributes))}`, '');
  }
  for (const n of g.sources) {
    const role = g.records.length === 0 ? (n.cite === g.anchor ? 'decision' : 'outcome note') : 'entry';
    lines.push(`Entry [${n.cite}] role: ${role}`, `Entry [${n.cite}] title: ${s(oneLine(n.row.title))}`, `Entry [${n.cite}] date: ${n.date}`, `Entry [${n.cite}] text:`, fenced(s(truncateText(n.body, NOTE_CHARS))), '');
  }
  rel.forEach((e, i) => lines.push(`Existing lesson [L${i + 1}] text:`, fenced(s(truncateText(e.body, NOTE_CHARS))), ''));
  return lines.join('\n').trimEnd();
}

/** Validate one model lesson (see the module comment); undefined when dropped (counted). */
function check(ctx: JobContext, g: Group, rel: readonly Existing[], resolver: CitationResolver, item: LessonItem): Lesson | undefined {
  const fields = { lesson: oneLine(item.lesson), applies_when: oneLine(item.applies_when), expected: oneLine(item.expected), actual: oneLine(item.actual) };
  const all = Object.values(fields).join('\n');
  const guard = guardrailViolation(all);
  if (guard !== undefined) {
    ctx.count('lessons_guardrail_dropped');
    ctx.count(`guardrail_${guard}`);
    return undefined;
  }
  const cites = [...new Set(item.citations.split(/[\s,]+/).map((c) => c.replace(/^\[|\]$/g, '')).filter((c) => c !== ''))];
  if (cites.length === 0 || cites.some((c) => resolver.resolve(c).status !== 'resolved')) {
    ctx.count('lessons_unresolved_citation');
    return undefined;
  }
  const allowed = new Set([...g.sources.map((s) => s.cite), ...g.records.map((r) => r.cite)]);
  if (cites.some((c) => !allowed.has(c))) {
    ctx.count('lessons_foreign_citation');
    return undefined;
  }
  const entries = g.sources.filter((s) => s.cite !== g.anchor && !g.outcomes.includes(s.cite)).map((s) => s.cite);
  const hasEntry = g.records.length === 0 || cites.some((c) => entries.includes(c));
  if (!hasEntry || !cites.includes(g.anchor) || !cites.some((c) => g.outcomes.includes(c))) {
    ctx.count('lessons_missing_citation');
    return undefined;
  }
  if (unsupportedNumbers(all, corpusOf(g, cites)).length > 0) {
    ctx.count('lessons_unsupported_number');
    return undefined;
  }
  const strict = scrub(all, { strict: true, extraPatterns: ctx.config.scrub.extraPatterns });
  if (!strict.ok || strict.findings.length > 0) {
    ctx.count('lessons_scrub_rejected');
    return undefined;
  }
  const order = (c: string): number => (g.sources.findIndex((s) => s.cite === c) + 1 || g.sources.length + 1 + g.records.findIndex((r) => r.cite === c));
  const lesson: Lesson = { ...fields, citations: cites.sort((a, b) => order(a) - order(b)) };
  if (item.conflicts_with !== '') {
    const e = rel[Number(item.conflicts_with.slice(1)) - 1]!;
    if (!quoteAppears(item.conflict_quote, e.body)) {
      ctx.count('conflict_quote_unverified');
      return undefined;
    }
    lesson.conflict = { lesson: e, quote: oneLine(item.conflict_quote) };
  }
  return lesson;
}

function lessonPath(ctx: JobContext, g: Group, l: Lesson): string {
  const slug = toSlug(l.lesson.split(' ').slice(0, 6).join(' ')) || 'lesson';
  return `${LESSONS_DIR}/${ctx.config.principal.id}/${slug}-${sha(`${g.key}\n${l.lesson}`).slice(0, 8)}.md`;
}

function lessonNote(ctx: JobContext, g: Group, l: Lesson, id: string, tainted: boolean): string {
  const title = `Lesson: ${l.lesson.length > 80 ? `${l.lesson.slice(0, 79).trimEnd()}…` : l.lesson}`;
  const fm: Record<string, unknown> = {
    schema: 1, id, title, kind: 'lesson', status: 'accepted', created: isoSeconds(ctx.now), author: 'ebrain-reflect', origin: 'cli',
    applies_when: l.applies_when, derived_from: l.citations,
    ...(g.tags.size > 0 ? { tags: [...g.tags].sort(compareBytes) } : {}),
    ...(l.conflict === undefined ? {} : { supersedes: [l.conflict.lesson.row.id] }),
    ...(tainted ? { untrusted_origin: true } : {}),
  };
  const body = [
    ADVISORY_LINE,
    ...(tainted ? ['>', '> **Untrusted origin:** derived from untrusted journal entries.'] : []),
    '',
    l.lesson,
    '',
    `- Applies when: ${l.applies_when}`,
    `- Expected: ${l.expected}`,
    `- Actual: ${l.actual}`,
    '',
    '## Evidence',
    '',
    ...l.citations.map((c) => `- \`${c}\``),
  ];
  return `---\n${stringify(fm, { lineWidth: 0 })}---\n# ${title}\n\n${body.join('\n')}\n`;
}

function describeGroup(g: Group): string[] {
  return [
    ...g.records.map((r) => `- \`${r.cite}\` (${r.occurred}): ${oneLine(r.summary)}`),
    ...g.sources.map((s) => `- \`${s.cite}\` \`${s.row.path}\` (${s.date})${s.row.untrusted_origin === 1 ? ' (untrusted origin)' : ''}`),
  ];
}

function describeLesson(l: Lesson, path: string): string[] {
  return [`- **${l.lesson}** (\`${path}\`)`, `  - applies when: ${l.applies_when}`, `  - expected: ${l.expected}`, `  - actual: ${l.actual}`, `  - cites: ${l.citations.map((c) => `\`${c}\``).join(', ')}`];
}

function drafts(ctx: JobContext, g: Group, lessons: Lesson[]): Draft[] {
  const tainted = g.sources.filter((s) => s.row.untrusted_origin === 1).map((s) => s.cite).sort();
  const taint = tainted.length > 0 ? { untrusted_origin: true, taint_sources: tainted } : {};
  const evidence = [...g.sources.map((s) => s.cite), ...g.records.map((r) => r.cite)];
  const advisory = 'Lessons are advisory and unverified: a model proposed them; every citation resolved, numbers were checked against the cited records, and the text passed the guardrails.';
  const out: Draft[] = [];
  const plain = lessons.filter((l) => l.conflict === undefined);
  if (plain.length > 0) {
    const created = plain.map((l) => ({ l, path: lessonPath(ctx, g, l) }));
    out.push({
      proposal_type: 'lesson',
      title: `Lessons from ${g.label}`,
      rationale: [
        `Expected vs actual for ${g.label}. Accepting creates ${plain.length} lesson note(s) under \`${LESSONS_DIR}/${ctx.config.principal.id}/\` with \`derived_from\` citing their evidence; \`ebrain review undo\` removes them.`,
        '',
        advisory,
        '',
        '## Lessons',
        '',
        ...created.flatMap(({ l, path }) => describeLesson(l, path)),
        '',
        '## Evidence',
        '',
        ...describeGroup(g),
      ].join('\n'),
      targets: [],
      evidence,
      ops: created.map(({ l, path }) => ({ op: 'create_note', path, content: lessonNote(ctx, g, l, ulid(ctx.now.getTime()), tainted.length > 0) })),
      ...taint,
    });
  }
  const seen = new Set<string>();
  for (const l of lessons) {
    if (l.conflict === undefined) continue;
    const e = l.conflict.lesson;
    if (seen.has(e.row.id)) {
      ctx.count('conflict_duplicate');
      continue;
    }
    seen.add(e.row.id);
    const id = ulid(ctx.now.getTime());
    const path = lessonPath(ctx, g, l);
    const at = isoSeconds(ctx.now);
    const ops: ChangeOp[] = [
      { op: 'create_note', path, content: lessonNote(ctx, g, l, id, tainted.length > 0) },
      { op: 'set_frontmatter', target: e.row.id, key: 'status', value: 'superseded' },
      { op: 'set_frontmatter', target: e.row.id, key: 'superseded_by', value: id },
      { op: 'set_frontmatter', target: e.row.id, key: 'superseded_at', value: at },
      { op: 'set_frontmatter', target: e.row.id, key: 'valid_until', value: at },
    ];
    out.push({
      proposal_type: 'supersede',
      title: `Supersede lesson: ${oneLine(e.row.title)}`,
      rationale: [
        `A lesson from ${g.label} contradicts the existing lesson \`${e.row.path}\` (\`${e.cite}\`). Accepting creates the new lesson at \`${path}\` and marks the existing one superseded by it; \`ebrain review undo\` restores both.`,
        '',
        advisory,
        '',
        'Contradicted sentence of the existing lesson:',
        '',
        `> ${l.conflict.quote}`,
        '',
        '## New lesson',
        '',
        ...describeLesson(l, path),
        '',
        '## Evidence',
        '',
        ...describeGroup(g),
      ].join('\n'),
      targets: [{ id: e.row.id, rev: e.row.rev, path_at_proposal: e.row.path }],
      evidence: [...evidence, e.cite],
      ops,
      ...taint,
    });
  }
  return out;
}

async function generate(ctx: JobContext): Promise<JobOutput> {
  const evidence = ctx.evidence;
  if (evidence === undefined || ctx.llm === undefined) return { drafts: [], stop: 'not-configured' };
  const resolver = new CitationResolver({ notes: noteLookup(ctx.index.db), evidence });
  const existing = existingLessons(ctx);
  ctx.count('existing_lessons', existing.length);
  const max = ctx.config.cognition.reflect.maxLessons;
  const out: Draft[] = [];
  for (const g of groups(ctx, evidence)) {
    if (ctx.sinceMs !== undefined && g.latestMs < ctx.sinceMs) {
      ctx.count('skipped_since');
      continue;
    }
    const ev = [...g.sources.map((s) => s.cite), ...g.records.map((r) => r.cite)];
    const rel = related(g, existing);
    if (ctx.known(['lesson'], ev) || rel.some((e) => ctx.known(['supersede'], [...ev, e.cite]))) continue;
    for (const s of g.sources) ctx.input(s.row.id, s.row.rev);
    for (const e of rel) ctx.input(e.row.id, e.row.rev);
    const schema: ItemSchema = {
      lesson: { type: 'string', min: 1, max: 400 },
      applies_when: { type: 'string', min: 1, max: 300 },
      expected: { type: 'string', min: 1, max: 300 },
      actual: { type: 'string', min: 1, max: 300 },
      citations: { type: 'string', min: 1, max: 2000 },
      conflicts_with: { type: 'enum', values: ['', ...rel.map((_, i) => `L${i + 1}`)] },
      conflict_quote: { type: 'string', min: 0, max: 500 },
    };
    const res = await ctx.llm.ask<LessonItem>(promptInput(ctx, g, rel, max), 'items', schema, max);
    if (res.stop !== undefined) return { drafts: out, stop: res.stop };
    ctx.count('lessons_proposed', res.items.length);
    const kept: Lesson[] = [];
    for (const item of res.items) {
      const l = check(ctx, g, rel, resolver, item);
      if (l === undefined) continue;
      if (l.conflict === undefined) {
        const sh = shingles(l.lesson);
        const min = ctx.config.cognition.reflect.minDuplicateJaccard;
        const norm = l.lesson.toLowerCase();
        if (existing.some((e) => jaccard(sh, e.sh) >= min || e.text.toLowerCase().includes(norm)) || kept.some((k) => jaccard(sh, shingles(k.lesson)) >= min)) {
          ctx.count('lessons_duplicate');
          continue;
        }
      }
      kept.push(l);
    }
    ctx.count('lessons_kept', kept.length);
    if (kept.length === 0) {
      ctx.count('groups_without_lessons');
      continue;
    }
    out.push(...drafts(ctx, g, kept));
  }
  return { drafts: out };
}

export const REFLECT_JOB: CognitionJob = {
  name: 'reflect',
  version: 1,
  description: 'propose advisory lessons from closed theses and their recorded outcomes (needs evidence and an LLM)',
  llm: 'required',
  evidence: 'required',
  generate,
};
