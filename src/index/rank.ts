// The one ranking function (I13). Every retrieval result list is put in its
// final order here and nowhere else; docs/RANKING.md documents the tier table
// and the ordering rules, and a scan test fails if another module orders
// results by relevance.
//
// Order: notes before reference books; then tier (T1 first; hidden notes,
// when a filter reveals them, after T8); then BM25 relevance quantized to
// 1e-6 (I11); then path (bytewise listing order); then chunk ordinal.

import { parseCitation } from '../cite/citation.js';
import { STATUSES } from '../vault/parse.js';
import { comparePaths, type FolderClass } from '../vault/names.js';

export type Tier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** Not in the tier table: hidden by default (filters in Phase 6 reveal it). */
export type TierOrHidden = Tier | 'hidden';

export interface TierRow {
  tier: Tier;
  name: string;
  contents: string;
  /** The phase whose end-to-end fixtures first produce notes of this tier. */
  registered: number;
}

/** The tier table, highest first (docs/RANKING.md). */
export const TIER_TABLE: readonly TierRow[] = [
  { tier: 1, name: 'curated', contents: 'folder class curated and reference', registered: 4 },
  { tier: 2, name: 'inbox', contents: 'folder class inbox', registered: 8 },
  { tier: 3, name: 'cited journal lesson', contents: 'journal, kind lesson, a well-formed citation in sources', registered: 9 },
  { tier: 4, name: 'uncited journal lesson', contents: 'journal, kind lesson, no well-formed citation', registered: 9 },
  { tier: 5, name: 'other journal', contents: 'other journal entries', registered: 9 },
  { tier: 6, name: 'raw', contents: 'folder class raw', registered: 10 },
  { tier: 7, name: 'stale', contents: 'status stale, any folder class', registered: 4 },
  { tier: 8, name: 'unknown', contents: 'unknown status value', registered: 4 },
];

/** Statuses that hide a note by default wherever it lives. */
export const HIDDEN_STATUSES: readonly string[] = ['rejected', 'superseded', 'archived'];

/** Relevance is compared after rounding to this step (I11). */
export const SCORE_QUANTUM = 1e-6;

export interface TierInput {
  /** `notes.status`; null/undefined when the note has no status. */
  status?: string | null;
  /**
   * `notes.status_known` from the index. When given and false, the status is
   * unknown even if its text matches a known value (for example a non-string
   * YAML value that stringified to one).
   */
  statusKnown?: boolean;
  /** Folder-hidden location (`_inbox/_rejected/`, `_inbox/_applied/`, archives). */
  folderHidden?: boolean;
  kind?: string | null;
  /** Raw `sources` entries; only well-formed citations count. */
  sources?: readonly unknown[];
}

/**
 * Citation kinds that ground a journal lesson (T3, Phase 9): verifiable
 * identifiers. A `url:` or `ref:` source is provenance, not grounding.
 */
export const GROUNDING_CITATION_KINDS: readonly string[] = ['thesis', 'outcome', 'commit', 'note'];

/**
 * True when at least one entry is a well-formed grounding citation: kind
 * thesis, outcome, commit, or note, accepted by the Phase 3 grammar
 * (`parseCitation`). Resolution against evidence is not checked.
 */
export function hasWellFormedCitation(sources: readonly unknown[] | undefined): boolean {
  return (sources ?? []).some((s) => {
    const parsed = parseCitation(s);
    return parsed.ok && GROUNDING_CITATION_KINDS.includes(parsed.citation.kind);
  });
}

/**
 * The effective tier: a total function of folder class and status (plus, for
 * journal notes, kind and sources). Evaluated in this order:
 *   1. status rejected/superseded/archived, folder class archive, or a hidden
 *      folder: hidden;
 *   2. unknown status: T8;
 *   3. status stale: T7;
 *   4. by folder class: curated/reference T1, inbox T2, journal T3-T5, raw T6.
 * Absent status falls through to step 4.
 */
export function effectiveTier(folderClass: FolderClass, status: string | null | undefined, extra: Omit<TierInput, 'status'> = {}): TierOrHidden {
  const hasStatus = status !== null && status !== undefined;
  const known = !hasStatus || (extra.statusKnown !== false && (STATUSES as readonly string[]).includes(status));
  if ((hasStatus && known && HIDDEN_STATUSES.includes(status)) || folderClass === 'archive' || extra.folderHidden === true) {
    return 'hidden';
  }
  if (!known) return 8;
  if (status === 'stale') return 7;
  switch (folderClass) {
    case 'curated':
    case 'reference':
      return 1;
    case 'inbox':
      return 2;
    case 'journal':
      if (extra.kind === 'lesson') return hasWellFormedCitation(extra.sources) ? 3 : 4;
      return 5;
    case 'raw':
      return 6;
  }
}

/** Integer relevance key: BM25 rounded to 1e-6. NaN sorts last. */
export function quantize(score: number): number {
  if (Number.isNaN(score)) return Number.POSITIVE_INFINITY;
  const q = Math.round(score / SCORE_QUANTUM);
  return q === 0 ? 0 : q;
}

export interface RankItem extends TierInput {
  path: string;
  /** Chunk ordinal (0 for whole-note results). */
  ordinal?: number;
  folderClass: FolderClass;
  /** FTS5 `bm25()` value: lower (more negative) is more relevant. Absent: no relevance (listings). */
  bm25?: number;
  /** Reference books (`scope: refs`) always come after notes. */
  source?: 'note' | 'ref';
  /** Hybrid search (Phase 12): the Reciprocal Rank Fusion score; when set on both items it replaces `bm25`. Higher is better. */
  fused?: number;
  /** `created` (ISO 8601); used only with `newestFirst`. */
  created?: string | null;
  /** Evidence-linked good minus bad reports for the note (cognition Phase 8); read only with `usageBoost`. Never from self-reported events. */
  usageNet?: number;
}

export interface Ranked<T extends RankItem> {
  item: T;
  tier: TierOrHidden;
}

export interface RankOptions {
  /** Keep hidden notes (placed after T8). Default false: they are dropped. */
  includeHidden?: boolean;
  /**
   * Listings only (`journal_list`, Phase 9): within a tier and relevance,
   * newer `created` first (absent or unparseable last), before the path rule.
   */
  newestFirst?: boolean;
  /**
   * Cognition Phase 8 (`rank.usageBoost`, default off): after the normal order,
   * an item with a positive `usageNet` swaps one place up with the item ahead
   * of it, and one with a negative `usageNet` one place down, but only inside
   * the same tier and source, and each item takes part in at most one swap, so
   * nothing moves more than one position. The magnitude of `usageNet` does not
   * matter (that is the cap). With this off, `usageNet` is ignored and the order
   * is a pure function of vault and config (I11).
   */
  usageBoost?: boolean;
}

function tierKey(t: TierOrHidden): number {
  return t === 'hidden' ? 9 : t;
}

function createdKey(item: RankItem): number {
  const ms = typeof item.created === 'string' ? Date.parse(item.created) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Compare two ranked entries by the documented rules (negative: `a` first). */
export function compareRanked<T extends RankItem>(a: Ranked<T>, b: Ranked<T>, opts: RankOptions = {}): number {
  const sa = a.item.source === 'ref' ? 1 : 0;
  const sb = b.item.source === 'ref' ? 1 : 0;
  if (sa !== sb) return sa - sb;
  const ta = tierKey(a.tier);
  const tb = tierKey(b.tier);
  if (ta !== tb) return ta - tb;
  if (a.item.fused !== undefined && b.item.fused !== undefined) {
    const fa = quantize(a.item.fused);
    const fb = quantize(b.item.fused);
    if (fa !== fb) return fa > fb ? -1 : 1;
  } else {
    const qa = quantize(a.item.bm25 ?? 0);
    const qb = quantize(b.item.bm25 ?? 0);
    if (qa !== qb) return qa < qb ? -1 : 1;
  }
  if (opts.newestFirst === true) {
    const ca = createdKey(a.item);
    const cb = createdKey(b.item);
    if (ca !== cb) return ca > cb ? -1 : 1;
  }
  return comparePaths(a.item.path, b.item.path) || (a.item.ordinal ?? 0) - (b.item.ordinal ?? 0);
}

/** Tier of an item. Reference books are ordered among themselves as `reference` notes. */
export function tierOf(item: RankItem): TierOrHidden {
  if (item.source === 'ref') return effectiveTier('reference', undefined);
  return effectiveTier(item.folderClass, item.status, item);
}

/** The bounded usage nudge (see `RankOptions.usageBoost`): adjacent same-tier swaps, at most one per item. */
function applyUsageNudge<T extends RankItem>(list: Ranked<T>[]): void {
  const sign = (r: Ranked<T>): number => Math.sign(r.item.usageNet ?? 0);
  const sameGroup = (a: Ranked<T>, b: Ranked<T>): boolean => a.tier === b.tier && (a.item.source ?? 'note') === (b.item.source ?? 'note');
  const moved = new Set<Ranked<T>>();
  const swap = (i: number): void => {
    const a = list[i]!;
    const b = list[i + 1]!;
    list[i] = b;
    list[i + 1] = a;
    moved.add(a);
    moved.add(b);
  };
  for (let i = 1; i < list.length; i++) {
    const up = list[i]!;
    const ahead = list[i - 1]!;
    if (sign(up) > 0 && sign(ahead) <= 0 && !moved.has(up) && !moved.has(ahead) && sameGroup(up, ahead)) swap(i - 1);
  }
  for (let i = list.length - 2; i >= 0; i--) {
    const down = list[i]!;
    const behind = list[i + 1]!;
    if (sign(down) < 0 && sign(behind) >= 0 && !moved.has(down) && !moved.has(behind) && sameGroup(down, behind)) swap(i);
  }
}

/** The final order of a result list. Returns new entries; the input is not modified. */
export function rank<T extends RankItem>(items: readonly T[], opts: RankOptions = {}): Ranked<T>[] {
  const ranked = items.map((item) => ({ item, tier: tierOf(item) }));
  const visible = opts.includeHidden === true ? ranked : ranked.filter((r) => r.tier !== 'hidden');
  const sorted = visible.sort((a, b) => compareRanked(a, b, opts));
  if (opts.usageBoost === true) applyUsageNudge(sorted);
  return sorted;
}

// ---- hybrid search (Phase 12) ----

/** Reciprocal Rank Fusion constant (Cormack et al.). */
export const RRF_K = 60;
/** Vector candidates kept per query, and the cosine below which a chunk is not a candidate. */
export const VECTOR_CANDIDATES = 50;
export const VECTOR_MIN_COSINE = 0.3;

export interface ChunkKey {
  path: string;
  ordinal: number;
}

export function chunkKey(k: ChunkKey): string {
  return `${k.path}\0${k.ordinal}`;
}

function byPathThenOrdinal(a: ChunkKey, b: ChunkKey): number {
  return comparePaths(a.path, b.path) || a.ordinal - b.ordinal;
}

/** The most similar chunks: cosine at or above the floor, best first (quantized), then path, then ordinal; at most `limit`. */
export function nearestChunks<T extends ChunkKey & { cosine: number }>(scored: readonly T[], limit: number = VECTOR_CANDIDATES): T[] {
  return scored
    .filter((s) => s.cosine >= VECTOR_MIN_COSINE)
    .sort((a, b) => quantize(b.cosine) - quantize(a.cosine) || byPathThenOrdinal(a, b))
    .slice(0, limit);
}

/**
 * Reciprocal Rank Fusion of a BM25 list and a vector list. Each list is
 * ranked on its own (BM25 ascending, cosine descending, both quantized, ties
 * by path then ordinal); a chunk scores the sum of 1/(RRF_K + rank) over the
 * lists it appears in. Returns the fused score by `chunkKey`.
 */
export function fuseRrf(bm25: readonly (ChunkKey & { bm25: number })[], vectors: readonly (ChunkKey & { cosine: number })[]): Map<string, number> {
  const fused = new Map<string, number>();
  const add = (keys: readonly ChunkKey[]) => {
    keys.forEach((k, i) => fused.set(chunkKey(k), (fused.get(chunkKey(k)) ?? 0) + 1 / (RRF_K + i + 1)));
  };
  add([...bm25].sort((a, b) => quantize(a.bm25) - quantize(b.bm25) || byPathThenOrdinal(a, b)));
  add([...vectors].sort((a, b) => quantize(b.cosine) - quantize(a.cosine) || byPathThenOrdinal(a, b)));
  return fused;
}
