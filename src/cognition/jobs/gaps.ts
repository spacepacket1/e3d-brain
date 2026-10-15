// `gaps` (cognition Phase 8, G18): "what do we ask about and not find?" Reads
// the opt-in query log (`<stateDir>/queries.jsonl`, `queryLog.enabled`; the
// text is already scrubbed) and files `gap` proposals: reports that change
// nothing (`targets: []`, `evidence: []`, no change block; C3's evidence
// requirement is waived for that reason). No model is involved and every
// number is a count.
//
// Clustering is deterministic text similarity. A query's tokens are its
// lower-cased words minus a short stop list and one-letter words; the token set
// is sorted and deduplicated. Identical token sets are one group; groups whose
// token sets have Jaccard similarity of at least `cognition.gaps.minSimilarity`
// are joined (connected components, so the result does not depend on log order).
// The cluster hash is the SHA-256 of the representative group's sorted token
// set (newline-joined): the group with the most queries, ties to the smaller
// token string. The proposal key is the hash of (job, cluster hash, type), so a
// re-run does not repeat a gap, and a rejected gap stays rejected.
//
// A query has a poor result when it returned nothing or its first result was
// tier 6 or lower (raw, stale, or unknown). A cluster qualifies when it was
// asked at least `minQueries` times and its poor-result rate is at least
// `minPoorRate`. Priority: most queries, then highest poor-result rate, then
// cluster hash (bytewise). "Best result tier" is the best first-result tier
// over the cluster's queries; "results" is the largest result count among them.
// An optional LLM pass could only rename a cluster label, never change counts;
// this job does not use one.

import { createHash } from 'node:crypto';
import { readQueries, type QueryRecord } from '../../recall/queries.js';
import { compareBytes } from '../../vault/names.js';
import type { CognitionJob, Draft, JobContext, JobOutput } from '../run.js';
import { jaccard, words } from '../shingle.js';

/** Most distinct token sets clustered per run (the most frequent ones); the rest are counted and left out. */
export const MAX_GROUPS = 2000;
/** A first result at this tier or lower counts as a poor result. */
export const POOR_TIER = 6;
const EXAMPLES = 3;
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'our', 'the', 'to', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
]);

export interface GapCluster {
  hash: string;
  tokens: string[];
  queries: number;
  poor: number;
  /** Best first-result tier (1 = best), or null when no query returned anything. */
  bestTier: number | null;
  maxResults: number;
  /** Distinct query texts, most frequent first. */
  examples: string[];
}

/** The sorted, deduplicated, stop-listed token set of a query. */
export function queryTokens(query: string): string[] {
  return [...new Set(words(query).filter((w) => w.length > 1 && !STOP.has(w)))].sort(compareBytes);
}

export function clusterHash(tokens: readonly string[]): string {
  return createHash('sha256').update(tokens.join('\n'), 'utf8').digest('hex');
}

const isPoor = (r: QueryRecord): boolean => r.results === 0 || r.top_tier === null || r.top_tier >= POOR_TIER;

/** Cluster logged queries (pure). Clusters are returned in no particular order. */
export function clusterQueries(records: readonly QueryRecord[], minSimilarity: number): { clusters: GapCluster[]; empty: number; capped: number } {
  const groups = new Map<string, { tokens: string[]; records: QueryRecord[] }>();
  let empty = 0;
  for (const r of records) {
    const tokens = queryTokens(r.query);
    if (tokens.length === 0) {
      empty++;
      continue;
    }
    const key = tokens.join(' ');
    const g = groups.get(key) ?? { tokens, records: [] };
    g.records.push(r);
    groups.set(key, g);
  }
  let list = [...groups.entries()].sort((a, b) => b[1].records.length - a[1].records.length || compareBytes(a[0], b[0]));
  const capped = Math.max(0, list.length - MAX_GROUPS);
  list = list.slice(0, MAX_GROUPS).sort((a, b) => compareBytes(a[0], b[0]));
  const sets = list.map(([, g]) => new Set(g.tokens));
  const parent = list.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (jaccard(sets[i]!, sets[j]!) >= minSimilarity) parent[find(j)] = find(i);
    }
  }
  const members = new Map<number, number[]>();
  list.forEach((_, i) => members.set(find(i), [...(members.get(find(i)) ?? []), i]));
  const clusters: GapCluster[] = [];
  for (const idx of members.values()) {
    const all = idx.flatMap((i) => list[i]![1].records);
    const rep = idx.map((i) => list[i]!).sort((a, b) => b[1].records.length - a[1].records.length || compareBytes(a[0], b[0]))[0]!;
    const tiers = all.flatMap((r) => (r.results > 0 && r.top_tier !== null ? [r.top_tier] : []));
    const freq = new Map<string, number>();
    for (const r of all) freq.set(r.query, (freq.get(r.query) ?? 0) + 1);
    clusters.push({
      hash: clusterHash(rep[1].tokens),
      tokens: rep[1].tokens,
      queries: all.length,
      poor: all.filter(isPoor).length,
      bestTier: tiers.length === 0 ? null : Math.min(...tiers),
      maxResults: Math.max(...all.map((r) => r.results)),
      examples: [...freq.entries()].sort((a, b) => b[1] - a[1] || compareBytes(a[0], b[0])).map(([q]) => q),
    });
  }
  return { clusters, empty, capped };
}

/** Qualifying clusters in priority order. */
export function rankGaps(clusters: readonly GapCluster[], minQueries: number, minPoorRate: number): GapCluster[] {
  return clusters
    .filter((c) => c.queries >= minQueries && c.poor / c.queries >= minPoorRate)
    .sort((a, b) => b.queries - a.queries || b.poor * a.queries - a.poor * b.queries || compareBytes(a.hash, b.hash));
}

function draftOf(c: GapCluster, ctx: JobContext): Draft {
  const label = c.tokens.slice(0, 6).join(' ');
  const examples = c.examples.flatMap((q) => ctx.scrubText(q) ?? []).slice(0, EXAMPLES);
  const tier = c.bestTier === null ? 'none (no query returned a result)' : `T${c.bestTier}`;
  return {
    proposal_type: 'gap',
    title: `Gap: ${label}`,
    rationale: [
      `Asked ${c.queries} times, best result tier ${tier}, ${c.maxResults} results. ${c.poor} of ${c.queries} queries returned nothing or only tier ${POOR_TIER} or lower.`,
      '',
      'Example queries (scrubbed):',
      ...examples.map((q) => `- ${q}`),
      '',
      'This proposal changes nothing. Consider capturing a note that answers it; accepting only files this report away, and rejecting it stops it from being proposed again.',
    ].join('\n'),
    targets: [],
    evidence: [],
    ops: [],
    key_basis: [c.hash],
  };
}

export const GAPS_JOB: CognitionJob = {
  name: 'gaps',
  version: 1,
  description: 'report clusters of logged queries that found little or nothing (needs queryLog.enabled; no model)',
  llm: 'never',
  generate(ctx: JobContext): Promise<JobOutput> {
    const { minQueries, minPoorRate, minSimilarity } = ctx.config.cognition.gaps;
    const records = readQueries(ctx.stateDir).filter((r) => ctx.sinceMs === undefined || Date.parse(r.ts) >= ctx.sinceMs);
    const { clusters, empty, capped } = clusterQueries(records, minSimilarity);
    const ranked = rankGaps(clusters, minQueries, minPoorRate);
    ctx.count('queries', records.length);
    ctx.count('queries_empty', empty);
    ctx.count('groups_capped', capped);
    ctx.count('clusters', clusters.length);
    ctx.count('gap_clusters', ranked.length);
    return Promise.resolve({ drafts: ranked.map((c) => draftOf(c, ctx)) });
  },
};
