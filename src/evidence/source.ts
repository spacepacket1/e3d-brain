// The evidence-source interface (cognition Phase 3). Resolution is local
// only: implementations read local files or the derived `evidence.db`, never
// the network.

import type { Attributes, EvidenceRecord } from './record.js';

export type EvidenceResolution =
  | { found: true; summary: string; occurred: string; attributes: Attributes }
  | { found: false };

export interface EvidenceSource {
  /** Kinds present, sorted. */
  kinds(): string[];
  resolve(kind: string, id: string): EvidenceResolution;
  /** Records of `kind` with `occurred >= since` (all when omitted), ordered by occurred, then id. */
  list(kind: string, since?: string | Date): EvidenceRecord[];
}

/** `since` as a comparable ISO string, or undefined for "no lower bound". Throws on an invalid date. */
export function sinceKey(since: string | Date | undefined): string | undefined {
  if (since === undefined) return undefined;
  const d = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(d.getTime())) throw new RangeError('invalid since date');
  return d.toISOString();
}

/** An in-memory source (tests, and callers that already hold records). Later records replace earlier ones with the same kind and id. */
export function memoryEvidenceSource(records: readonly EvidenceRecord[]): EvidenceSource {
  const byKey = new Map<string, EvidenceRecord>();
  for (const r of records) byKey.set(`${r.kind}\u0000${r.id}`, r);
  const all = [...byKey.values()];
  return {
    kinds: () => [...new Set(all.map((r) => r.kind))].sort(),
    resolve: (kind, id) => {
      const r = byKey.get(`${kind}\u0000${id}`);
      return r === undefined ? { found: false } : { found: true, summary: r.summary, occurred: r.occurred, attributes: r.attributes };
    },
    list: (kind, since) => {
      const key = sinceKey(since);
      return all
        .filter((r) => r.kind === kind && (key === undefined || r.occurred >= key))
        .sort((a, b) => (a.occurred < b.occurred ? -1 : a.occurred > b.occurred ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
