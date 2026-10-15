// Deterministic text overlap without embeddings (cognition G13): word
// shingles and their Jaccard similarity. Text is NFKC-normalized, case
// folded, and split into letter/number words; a text with fewer words than
// the shingle size contributes its whole word sequence as one shingle.
// Pure: no I/O.

export const DEFAULT_SHINGLE_SIZE = 3;

/** Lower-cased words of `text` (letters, numbers, marks, underscore). */
export function words(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [];
}

/** The set of `size`-word shingles of `text`. */
export function shingles(text: string, size: number = DEFAULT_SHINGLE_SIZE): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length === 0) return out;
  if (w.length < size) {
    out.add(w.join(' '));
    return out;
  }
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(' '));
  return out;
}

/** |a ∩ b| / |a ∪ b|; 0 when both are empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}
