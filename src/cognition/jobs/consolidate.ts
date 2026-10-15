// `consolidate` (cognition Phase 5, G13): "which notes are duplicates, or one
// idea in pieces?"
//
// Eligible notes: not in a hidden folder, curated or a journal entry of this
// instance's principal (journal entries of other principals, `_raw/`,
// `_archive/`, `references/`, and `_inbox/` are skipped), effectively
// accepted (no status, `accepted`, or `journal` for journal entries), not
// `kind: summary` or `proposal`, with an assigned id (C3: provisional ids are
// skipped and counted), and not `pinned` (skipped and counted).
//
// Merge (deterministic, no model). Near-duplicates come from `dedup.ts`
// (minhash with fixed seeds, LSH buckets, exact 3-word-shingle Jaccard of at
// least `cognition.consolidate.minJaccard`), so they work with embeddings
// off. With embeddings on (`embeddings.provider` not `none`), pairs whose
// mean stored chunk vectors have cosine at least `minCosine` are added; only
// vectors already in the index are read, the embedder is never called.
// Keep rule: the more complete note (more distinct shingles) is kept; on a
// tie, the earlier one (`occurred`, else `created`; undated counts as
// latest); then the bytewise smaller path. The change block appends the
// other note's unique lines (`uniqueLines`) to the kept note under a
// "Merged from" section that cites `note:<id>@<rev>`, and archives the other
// note per C10 (`status: archived`, `archived_at`, `merged_into: <kept id>`,
// moved to its archive path). Both originals stay recoverable through
// `ebrain review undo`, and no file is deleted. A note joins at most one
// merge per run: pairs are taken in priority order, and a pair already in
// `_inbox/` claims its notes too, so a re-run creates nothing new.
//
// Summary. Clusters of 3 to MAX_TAG_NOTES eligible notes that share a
// non-trivial tag (as in `supersede`) or form a connected component of
// resolved wikilinks, leaving out notes claimed by a merge. A cluster whose
// note ids equal the `derived_from` of an existing summary note is skipped.
// The proposal creates `summaries/<label>-<hash>.md` with `kind: summary`
// and `derived_from: [note:<id>@<rev>, ...]`; every claim line cites its
// source note. With an LLM provider (prompt `consolidate.v1`) each claim
// must come with a quote that appears verbatim in the cited source, else the
// claim is dropped and counted; a cluster left with no supported claim
// yields nothing. Without a provider the note is an extractive link list:
// each source's link, its first prose line verbatim, and its citation. At
// most `cognition.consolidate.maxSummaries` summaries per run. Taint (C8):
// a summary of any `untrusted_origin` note is itself `untrusted_origin` with
// `taint_sources`, and so is its proposal.
//
// Priority: merges first, highest Jaccard first, then paths (bytewise);
// then summaries, largest cluster first, then first member path. With
// `--since`, pairs and clusters with no note dated on or after it are left
// out.

import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { formatCitation, parseCitation } from '../../cite/citation.js';
import { isoSeconds, toSlug } from '../../inbox/note.js';
import { allNoteRows, tagsByPath, type NoteRow } from '../../index/query.js';
import type { ItemSchema } from '../../llm/schema.js';
import { fenceFor, truncateText } from '../../mcp/fence.js';
import { isoToMs } from '../../mcp/tools.js';
import { ulid } from '../../mcp/ulid.js';
import { archiveDestination, type ChangeOp } from '../../review/proposal.js';
import { readFileWithStatSafe, resolveInVault } from '../../safe-path.js';
import { compareBytes } from '../../vault/names.js';
import { splitFrontmatter } from '../../vault/parse.js';
import { findDuplicates, textShingles, uniqueLines } from '../dedup.js';
import type { CognitionJob, Draft, JobContext, JobOutput } from '../run.js';
import { MAX_TAG_NOTES, quoteAppears, TRIVIAL_TAGS } from './supersede.js';

export const MIN_CLUSTER = 3;
export const SUMMARY_DIR = 'summaries';
const MAX_CLAIMS = 8;
const NOTE_CHARS = 1500;
const QUOTE_MAX = 500;
const EXCERPT_CHARS = 200;
const ELIGIBLE_STATUSES = new Set([null, 'accepted']);
const EXCLUDED_KINDS = new Set(['summary', 'proposal']);

interface Note {
  row: NoteRow;
  body: string;
  dateMs: number | undefined;
  /** Distinct shingles: the "completeness" measure of the keep rule. */
  size: number;
  cite: string;
}

interface Claim {
  source: string;
  claim: string;
  quote: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const linkOf = (n: Note): string => `[[${n.row.path.replace(/\.md$/, '')}|${oneLine(n.row.title).replace(/[[\]|]/g, ' ').trim() || 'note'}]]`;

function bodyOf(ctx: JobContext, rel: string): string {
  const text = readFileWithStatSafe(resolveInVault(ctx.config.vaultPath, rel), { maxBytes: 4 * 1024 * 1024 }).data.toString('utf8');
  return splitFrontmatter(text.replace(/^﻿/, '')).body.replace(/\r\n?/g, '\n');
}

/** First prose line (no heading, comment, fence, or quote line), cut at EXCERPT_CHARS. */
function excerptOf(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('```') || line.startsWith('>')) continue;
    return line.slice(0, EXCERPT_CHARS);
  }
  return '';
}

/** The keep rule (see the module comment): negative when `a` is kept. */
function keepOrder(a: Note, b: Note): number {
  if (a.size !== b.size) return b.size - a.size;
  const da = a.dateMs ?? Number.POSITIVE_INFINITY;
  const db = b.dateMs ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return compareBytes(a.row.path, b.row.path);
}

function eligible(ctx: JobContext): Map<string, Note> {
  const { db } = ctx.index;
  const pinned = db.prepare('SELECT pinned FROM notes WHERE path = ?');
  const notes = new Map<string, Note>();
  for (const r of allNoteRows(db)) {
    if (r.folder_hidden !== 0 || r.status_known !== 1) continue;
    const journal = r.folder_class === 'journal';
    if (journal) {
      if (r.path.split('/')[1] !== ctx.config.principal.id) {
        ctx.count('skipped_other_principal');
        continue;
      }
    } else if (r.folder_class !== 'curated') continue;
    if (!(ELIGIBLE_STATUSES.has(r.status) || (journal && r.status === 'journal'))) continue;
    if (r.kind !== null && EXCLUDED_KINDS.has(r.kind)) continue;
    if (r.provisional === 1) {
      ctx.count('skipped_provisional');
      continue;
    }
    if ((pinned.get(r.path) as { pinned: number | null }).pinned === 1) {
      ctx.count('skipped_pinned');
      continue;
    }
    const body = bodyOf(ctx, r.path);
    const date = r.occurred ?? r.created;
    notes.set(r.path, {
      row: r, body, dateMs: date === null ? undefined : isoToMs(date), size: textShingles(body).size,
      cite: formatCitation({ kind: 'note', id: r.id, rev: r.rev }),
    });
  }
  ctx.count('eligible_notes', notes.size);
  return notes;
}

/** Note pairs whose mean stored chunk vectors (current model, current chunks) have cosine >= minCosine. */
function cosinePairs(ctx: JobContext, notes: ReadonlyMap<string, Note>): Map<string, number> {
  const out = new Map<string, number>();
  if (ctx.config.embeddings.provider === 'none') return out;
  const rows = ctx.index.db.prepare(
    `SELECT v.note_path AS path, v.dimensions AS dimensions, v.vector AS vector
     FROM chunk_vectors v JOIN chunks c ON c.note_path = v.note_path AND c.ordinal = v.ordinal AND c.chunk_rev = v.chunk_rev
     WHERE v.model = ?`,
  ).all(ctx.config.embeddings.model) as { path: string; dimensions: number; vector: Buffer }[];
  const sums = new Map<string, Float64Array>();
  for (const r of rows) {
    if (!notes.has(r.path) || r.vector.length !== r.dimensions * 4) continue;
    const v = new Float32Array(new Uint8Array(r.vector).buffer);
    const s = sums.get(r.path) ?? new Float64Array(r.dimensions);
    if (s.length !== r.dimensions) continue;
    for (let i = 0; i < v.length; i++) s[i]! += v[i]!;
    sums.set(r.path, s);
  }
  const unit: { path: string; v: Float64Array }[] = [];
  for (const [p, s] of sums) {
    let n = 0;
    for (const x of s) n += x * x;
    if (n === 0) continue;
    const k = 1 / Math.sqrt(n);
    unit.push({ path: p, v: s.map((x) => x * k) });
  }
  ctx.count('embedded_notes', unit.length);
  for (let i = 0; i < unit.length; i++) {
    for (let j = i + 1; j < unit.length; j++) {
      const a = unit[i]!;
      const b = unit[j]!;
      if (a.v.length !== b.v.length) continue;
      let dot = 0;
      for (let d = 0; d < a.v.length; d++) dot += a.v[d]! * b.v[d]!;
      if (dot >= ctx.config.cognition.consolidate.minCosine) out.set(compareBytes(a.path, b.path) < 0 ? `${a.path}\0${b.path}` : `${b.path}\0${a.path}`, dot);
    }
  }
  return out;
}

function mergeDraft(ctx: JobContext, keep: Note, other: Note, jaccard: number, cosine: number | undefined): Draft {
  const dest = archiveDestination(other.row.path);
  const unique = uniqueLines(keep.body, other.body);
  const untrusted = other.row.untrusted_origin === 1;
  const section = [
    `## Merged from ${oneLine(other.row.title) || other.row.path}`,
    '',
    `Merged from ${linkOf(other)} (\`${other.cite}\`), archived to \`${dest}\` by an accepted consolidate proposal.${untrusted ? ' That note has an untrusted origin.' : ''}`,
    '',
    ...(unique.length > 0 ? unique : ['(The merged note added nothing beyond what this note already says.)']),
  ].join('\n');
  const ops: ChangeOp[] = [
    { op: 'append_section', target: keep.row.id, text: section },
    { op: 'set_frontmatter', target: other.row.id, key: 'status', value: 'archived' },
    { op: 'set_frontmatter', target: other.row.id, key: 'archived_at', value: isoSeconds(ctx.now) },
    { op: 'set_frontmatter', target: other.row.id, key: 'merged_into', value: keep.row.id },
    { op: 'move_note', target: other.row.id, to: dest },
  ];
  const describe = (label: string, n: Note): string => `- ${label}: **${oneLine(n.row.title)}** (\`${n.row.path}\`, ${n.size} distinct 3-word shingles, \`${n.cite}\`)`;
  const rationale = [
    `These notes are near-duplicates. Accepting appends ${unique.length} unique line(s) of \`${other.row.path}\` to \`${keep.row.path}\` under a "Merged from" section, and archives \`${other.row.path}\` to \`${dest}\` with \`merged_into\`. Nothing is deleted; \`ebrain review undo\` restores both notes.`,
    '',
    describe('Keep', keep),
    describe('Archive', other),
    '',
    `Overlap: shingle Jaccard ${jaccard.toFixed(2)}${cosine === undefined ? '' : `, embedding cosine ${cosine.toFixed(3)}`}.`,
    'Keep rule: the more complete note (more distinct shingles); on a tie the earlier one; then the smaller path.',
  ].join('\n');
  return {
    proposal_type: 'merge',
    title: `Merge: ${oneLine(other.row.title)} into ${oneLine(keep.row.title)}`,
    rationale,
    targets: [keep, other].map((n) => ({ id: n.row.id, rev: n.row.rev, path_at_proposal: n.row.path })),
    evidence: [keep.cite, other.cite],
    ops,
  };
}

interface Cluster {
  label: string;
  slug: string;
  members: Note[];
}

function clusters(ctx: JobContext, notes: ReadonlyMap<string, Note>, claimed: ReadonlySet<string>): Cluster[] {
  const { db } = ctx.index;
  const pool = new Map([...notes].filter(([p]) => !claimed.has(p)));
  const out = new Map<string, Cluster>();
  const add = (label: string, slug: string, paths: string[]): void => {
    if (paths.length < MIN_CLUSTER) return;
    if (paths.length > MAX_TAG_NOTES) {
      ctx.count('clusters_too_large');
      return;
    }
    const sorted = [...paths].sort(compareBytes);
    const k = sorted.join('\0');
    if (!out.has(k)) out.set(k, { label, slug, members: sorted.map((p) => pool.get(p)!) });
  };
  const byTag = new Map<string, string[]>();
  for (const [p, tags] of tagsByPath(db)) {
    if (!pool.has(p)) continue;
    for (const t of tags) {
      if (TRIVIAL_TAGS.includes(t) || t.startsWith('ebrain-')) continue;
      byTag.set(t, [...(byTag.get(t) ?? []), p]);
    }
  }
  for (const [t, paths] of byTag) add(`notes tagged #${t}`, `tag-${toSlug(t)}`, paths);

  // Connected components of resolved wikilinks among the pool (union-find).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const p of pool.keys()) parent.set(p, p);
  const links = db.prepare('SELECT DISTINCT note_path AS p, resolved_path AS q FROM links WHERE resolved_path IS NOT NULL AND note_path <> resolved_path').all() as { p: string; q: string }[];
  for (const { p, q } of links) {
    if (!pool.has(p) || !pool.has(q)) continue;
    const [a, b] = [find(p), find(q)];
    if (a !== b) parent.set(compareBytes(a, b) < 0 ? b : a, compareBytes(a, b) < 0 ? a : b);
  }
  const comps = new Map<string, string[]>();
  for (const p of pool.keys()) {
    const r = find(p);
    comps.set(r, [...(comps.get(r) ?? []), p]);
  }
  for (const paths of comps.values()) {
    if (paths.length < 2) continue;
    const first = [...paths].sort(compareBytes)[0]!;
    add(`notes linked with ${oneLine(pool.get(first)!.row.title)}`, `links-${toSlug(pool.get(first)!.row.title)}`, paths);
  }

  // Skip clusters an existing summary already covers (same note ids in derived_from).
  const covered = new Set<string>();
  for (const r of db.prepare(
    `SELECT derived_from FROM notes WHERE kind = 'summary' AND folder_hidden = 0 AND (status IS NULL OR status NOT IN ('archived', 'superseded', 'rejected'))`,
  ).all() as { derived_from: string }[]) {
    const ids = (JSON.parse(r.derived_from) as unknown[]).flatMap((c) => {
      const parsed = typeof c === 'string' ? parseCitation(c) : undefined;
      return parsed?.ok === true && parsed.citation.kind === 'note' ? [parsed.citation.id] : [];
    });
    covered.add([...new Set(ids)].sort().join('\n'));
  }
  const list: Cluster[] = [];
  for (const c of out.values()) {
    if (covered.has(c.members.map((m) => m.row.id).sort().join('\n'))) {
      ctx.count('summary_exists');
      continue;
    }
    list.push(c);
  }
  ctx.count('clusters', list.length);
  return list.sort((a, b) => b.members.length - a.members.length || compareBytes(a.members[0]!.row.path, b.members[0]!.row.path) || compareBytes(a.label, b.label));
}

function summaryDraft(ctx: JobContext, c: Cluster, claims: Claim[] | undefined): Draft {
  const ids = c.members.map((m) => m.row.id).sort();
  const path = `${SUMMARY_DIR}/${c.slug}-${sha(ids.join('\n')).slice(0, 8)}.md`;
  const tainted = c.members.filter((m) => m.row.untrusted_origin === 1).map((m) => m.cite).sort();
  const title = `Summary: ${c.label}`;
  const fm: Record<string, unknown> = {
    schema: 1, id: ulid(ctx.now.getTime()), title, kind: 'summary', status: 'accepted', created: isoSeconds(ctx.now),
    author: 'ebrain-consolidate', origin: 'cli', derived_from: c.members.map((m) => m.cite),
    ...(tainted.length > 0 ? { untrusted_origin: true } : {}),
  };
  const bySource = new Map(c.members.map((m, i) => [String(i + 1), m]));
  const body = claims === undefined
    ? [
      `Extractive summary of ${c.members.length} ${c.label}: each line links a source note, quotes its first line verbatim, and cites its revision.`,
      '',
      '## Notes',
      '',
      ...c.members.map((m) => `- ${linkOf(m)}: ${oneLine(excerptOf(m.body)) || '(no prose)'} (\`${m.cite}\`)`),
    ]
    : [
      `Summary of ${c.members.length} ${c.label}. Every claim cites its source note and quotes the supporting text verbatim.`,
      '',
      '## Claims',
      '',
      ...claims.flatMap((cl) => {
        const m = bySource.get(cl.source)!;
        return [`- ${oneLine(cl.claim)} (${linkOf(m)}, \`${m.cite}\`)`, `  > ${oneLine(cl.quote)}`];
      }),
      '',
      '## Sources',
      '',
      ...c.members.map((m) => `- ${linkOf(m)} (\`${m.cite}\`)`),
    ];
  if (tainted.length > 0) body.unshift('> **Untrusted origin:** derived in part from untrusted notes.', '');
  const content = `---\n${stringify(fm, { lineWidth: 0 })}---\n# ${title}\n\n${body.join('\n')}\n`;
  return {
    proposal_type: 'summary',
    title,
    rationale: [
      `${c.members.length} related notes (${c.label}) have no summary. Accepting creates \`${path}\` with \`kind: summary\` and \`derived_from\` citing every source at its revision; the sources are unchanged.`,
      '',
      claims === undefined ? 'No LLM provider: the summary is an extractive link list.' : `${claims.length} claim(s), each supported by a verbatim quote from its cited source.`,
      '',
      ...c.members.map((m) => `- \`${m.row.path}\` (\`${m.cite}\`)`),
    ].join('\n'),
    targets: [],
    evidence: c.members.map((m) => m.cite),
    ops: [{ op: 'create_note', path, content }],
    ...(tainted.length > 0 ? { untrusted_origin: true, taint_sources: tainted } : {}),
  };
}

async function generate(ctx: JobContext): Promise<JobOutput> {
  const notes = eligible(ctx);
  const recent = (...ns: Note[]): boolean => ctx.sinceMs === undefined || ns.some((n) => n.dateMs !== undefined && n.dateMs >= ctx.sinceMs!);
  const drafts: Draft[] = [];
  const cos = cosinePairs(ctx, notes);
  const dups = findDuplicates([...notes.values()].map((n) => ({ key: n.row.path, text: n.body })), {
    threshold: ctx.config.cognition.consolidate.minJaccard,
    extraPairs: [...cos.keys()].map((k) => k.split('\0') as [string, string]),
    acceptExtra: () => true,
  });
  ctx.count('dedup_candidates', dups.candidates);
  ctx.count('duplicate_pairs', dups.pairs.length);
  const claimed = new Set<string>();
  for (const p of dups.pairs) {
    const [x, y] = [notes.get(p.a)!, notes.get(p.b)!];
    if (claimed.has(p.a) || claimed.has(p.b)) {
      ctx.count('merge_overlap_skipped');
      continue;
    }
    if (!recent(x, y)) {
      ctx.count('skipped_since');
      continue;
    }
    const [keep, other] = keepOrder(x, y) <= 0 ? [x, y] : [y, x];
    const known = ctx.knownAs(['merge'], [keep.cite, other.cite]);
    if (known === 'open') {
      claimed.add(p.a).add(p.b);
      continue;
    }
    if (known === 'rejected') continue;
    claimed.add(p.a).add(p.b);
    ctx.input(keep.row.id, keep.row.rev);
    ctx.input(other.row.id, other.row.rev);
    drafts.push(mergeDraft(ctx, keep, other, p.jaccard, cos.get(`${p.a}\0${p.b}`)));
  }

  let summaries = 0;
  for (const c of clusters(ctx, notes, claimed)) {
    if (!recent(...c.members)) {
      ctx.count('skipped_since');
      continue;
    }
    if (ctx.known(['summary'], c.members.map((m) => m.cite))) continue;
    if (summaries >= ctx.config.cognition.consolidate.maxSummaries) {
      ctx.count('summaries_capped');
      continue;
    }
    for (const m of c.members) ctx.input(m.row.id, m.row.rev);
    if (ctx.llm === undefined) {
      summaries++;
      drafts.push(summaryDraft(ctx, c, undefined));
      continue;
    }
    const labels = c.members.map((_, i) => String(i + 1));
    const blocks = c.members.map((m, i) => {
      const text = ctx.scrubText(truncateText(m.body, NOTE_CHARS)) ?? '';
      const f = fenceFor(text);
      return `Source [${i + 1}] title: ${ctx.scrubText(oneLine(m.row.title)) ?? ''}\nSource [${i + 1}] note text:\n${f}text\n${text}\n${f}`;
    });
    const schema: ItemSchema = {
      source: { type: 'enum', values: labels },
      claim: { type: 'string', min: 1, max: 300 },
      quote: { type: 'string', min: 1, max: QUOTE_MAX },
    };
    const res = await ctx.llm.ask<Claim>(`Topic: ${ctx.scrubText(c.label) ?? ''}\n\n${blocks.join('\n\n')}`, 'items', schema, MAX_CLAIMS);
    if (res.stop !== undefined) return { drafts, stop: res.stop };
    const supported = res.items.filter((cl) => {
      const ok = quoteAppears(cl.quote, c.members[Number(cl.source) - 1]!.body);
      ctx.count(ok ? 'claims_supported' : 'claims_unsupported');
      return ok;
    });
    if (supported.length === 0) {
      ctx.count('summary_no_supported_claims');
      continue;
    }
    summaries++;
    drafts.push(summaryDraft(ctx, c, supported));
  }
  return { drafts };
}

export const CONSOLIDATE_JOB: CognitionJob = {
  name: 'consolidate',
  version: 1,
  description: 'propose merging near-duplicate notes and summarizing clusters of related notes (optional LLM for summaries)',
  llm: 'optional',
  generate,
};
