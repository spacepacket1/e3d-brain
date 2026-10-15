// Deterministic near-duplicate detection without embeddings (cognition
// Phase 5, G13). Pure: no I/O, no randomness, no clock.
//
//   1. Normalize: HTML comments dropped, then `words()` (NFKC, case folded,
//      letter/number words; punctuation and Markdown syntax fall away).
//   2. Shingle: the set of 3-word shingles (`shingle.ts`).
//   3. Minhash: MINHASH_SIZE 32-bit hash functions, each FNV-1a of the
//      shingle mixed with a fixed seed (SEEDS, derived from a constant), so
//      signatures are identical across runs and machines.
//   4. LSH: the signature is cut into LSH_BANDS bands of LSH_ROWS rows; two
//      texts sharing any band are candidates. With 32 bands of 4 rows a pair
//      at Jaccard 0.5 is a candidate with probability ~0.9; at 0.6, ~0.99.
//   5. Confirm: every candidate's exact shingle Jaccard is computed, and only
//      pairs at or above the threshold are reported (minhash finds, Jaccard
//      decides, so estimation error never creates a false positive).
//
// Optional extra candidates (for example cosine neighbours from stored
// embeddings) are merged into step 5 by the caller through `extraPairs`.
// Results are ordered by Jaccard (highest first), then by the pair's keys
// (bytewise), so the output is a pure function of the inputs.

import { compareBytes } from '../vault/names.js';
import { DEFAULT_SHINGLE_SIZE, jaccard, words } from './shingle.js';

export const MINHASH_SIZE = 128;
export const LSH_BANDS = 32;
export const LSH_ROWS = MINHASH_SIZE / LSH_BANDS;

/** Fixed minhash seeds: a 32-bit xorshift sequence from a constant. */
export const SEEDS: readonly number[] = (() => {
  const out: number[] = [];
  let x = 0x9e3779b9;
  for (let i = 0; i < MINHASH_SIZE; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out.push(x >>> 0);
  }
  return out;
})();

/** Words of `text` after dropping HTML comments (the normalized form compared). */
export function normalizedWords(text: string): string[] {
  return words(text.replace(/<!--[\s\S]*?-->/g, ' '));
}

/** 3-word shingles of the normalized text (a shorter text is one shingle; an empty text none). */
export function textShingles(text: string, size: number = DEFAULT_SHINGLE_SIZE): Set<string> {
  const w = normalizedWords(text);
  const out = new Set<string>();
  if (w.length === 0) return out;
  if (w.length < size) {
    out.add(w.join(' '));
    return out;
  }
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(' '));
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finalizer: a well-mixed 32-bit permutation. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The minhash signature of a shingle set (all 0xffffffff for an empty set). */
export function minhash(sh: ReadonlySet<string>): Uint32Array {
  const sig = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const s of sh) {
    const base = fnv1a(s);
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const v = mix(base ^ SEEDS[i]!);
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

/** Share of equal signature positions: an estimate of Jaccard. */
export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  let eq = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) eq++;
  return eq / MINHASH_SIZE;
}

export interface DedupItem {
  /** A unique key (for example the note path). */
  key: string;
  text: string;
}

export interface DuplicatePair {
  /** The bytewise smaller key. */
  a: string;
  b: string;
  /** Exact shingle Jaccard. */
  jaccard: number;
  /** How the pair became a candidate. */
  via: 'minhash' | 'extra' | 'both';
}

export interface DedupOptions {
  /** Report pairs with exact Jaccard at or above this (0 < t <= 1). */
  threshold: number;
  /** More candidate pairs (by key), confirmed by `acceptExtra` instead of the threshold. */
  extraPairs?: readonly (readonly [string, string])[];
  /** Whether an extra candidate is a duplicate regardless of Jaccard (default: never; the threshold applies). */
  acceptExtra?: (a: string, b: string, jaccard: number) => boolean;
}

export interface DedupResult {
  pairs: DuplicatePair[];
  /** Candidate pairs examined (LSH buckets plus extras, deduplicated). */
  candidates: number;
  /** Items with no shingles (empty after normalization), never paired. */
  empty: number;
}

const pairKey = (a: string, b: string): string => `${a}\0${b}`;

/** Near-duplicate pairs among `items` (see the module comment). */
export function findDuplicates(items: readonly DedupItem[], opts: DedupOptions): DedupResult {
  const sh = new Map<string, Set<string>>();
  const buckets = new Map<string, string[]>();
  let empty = 0;
  for (const it of items) {
    const s = textShingles(it.text);
    if (s.size === 0) {
      empty++;
      continue;
    }
    sh.set(it.key, s);
    const sig = minhash(s);
    for (let b = 0; b < LSH_BANDS; b++) {
      const k = `${b}:${Array.from(sig.subarray(b * LSH_ROWS, (b + 1) * LSH_ROWS)).join(',')}`;
      const list = buckets.get(k);
      if (list === undefined) buckets.set(k, [it.key]);
      else list.push(it.key);
    }
  }
  const cand = new Map<string, { a: string; b: string; via: DuplicatePair['via'] }>();
  const add = (x: string, y: string, via: 'minhash' | 'extra'): void => {
    if (x === y || !sh.has(x) || !sh.has(y)) return;
    const [a, b] = compareBytes(x, y) < 0 ? [x, y] : [y, x];
    const k = pairKey(a, b);
    const prev = cand.get(k);
    if (prev === undefined) cand.set(k, { a, b, via });
    else if (prev.via !== via) prev.via = 'both';
  };
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i]!, list[j]!, 'minhash');
  }
  for (const [x, y] of opts.extraPairs ?? []) add(x, y, 'extra');

  const pairs: DuplicatePair[] = [];
  for (const c of cand.values()) {
    const j = jaccard(sh.get(c.a)!, sh.get(c.b)!);
    const byThreshold = j >= opts.threshold;
    const byExtra = c.via !== 'minhash' && opts.acceptExtra !== undefined && opts.acceptExtra(c.a, c.b, j);
    if (byThreshold || byExtra) pairs.push({ a: c.a, b: c.b, jaccard: j, via: c.via });
  }
  pairs.sort((p, q) => q.jaccard - p.jaccard || compareBytes(p.a, q.a) || compareBytes(p.b, q.b));
  return { pairs, candidates: cand.size, empty };
}

/**
 * Lines of `other` not already covered by `base`: a line is covered when its
 * normalized words appear as a contiguous run in `base`, or when at least
 * `minCoverage` of its 3-word shingles occur in `base`. Blank lines and lines
 * with no words are dropped, and so is a Markdown heading with no uncovered
 * line under it (before the next heading); order is kept.
 */
export function uniqueLines(base: string, other: string, minCoverage = 0.8): string[] {
  const baseWords = ` ${normalizedWords(base).join(' ')} `;
  const baseSh = textShingles(base);
  const out: string[] = [];
  for (const line of other.split('\n')) {
    const w = normalizedWords(line);
    if (w.length === 0) continue;
    if (baseWords.includes(` ${w.join(' ')} `)) continue;
    const s = textShingles(line);
    let hit = 0;
    for (const x of s) if (baseSh.has(x)) hit++;
    if (s.size > 0 && hit / s.size >= minCoverage) continue;
    out.push(line.trimEnd());
  }
  const isHeading = (l: string): boolean => /^\s{0,3}#{1,6}\s/.test(l);
  return out.filter((l, i) => !isHeading(l) || (i + 1 < out.length && !isHeading(out[i + 1]!)));
}
