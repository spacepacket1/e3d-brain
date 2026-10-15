// Citation resolution (cognition Phase 3). Combines note citations (checked
// against the index's current revisions) with evidence citations (`thesis:`,
// `outcome:`, looked up in a local `EvidenceSource`). Pure apart from the
// lookups it is handed: nothing here touches the filesystem or the network.
//
//   resolved    the cited thing exists locally (and, for a note, at that rev)
//   unresolved  well-formed, but not found locally (or not locally resolvable:
//               `commit:` and `url:` are never fetched; `ref:` needs a lookup)
//   stale       a note citation whose note has moved on to another rev
//   malformed   not a canonical citation string
//
// A status is a fact about one run, not about the brain: `CitationResolver`
// caches results for its own lifetime only, and nothing here persists them.

import { checkNoteCitation, parseCitation, type Citation, type NoteLookup } from './citation.js';
import type { EvidenceResolution, EvidenceSource } from '../evidence/source.js';

export type CitationStatus = 'resolved' | 'unresolved' | 'stale' | 'malformed';

export interface CitationResolution {
  status: CitationStatus;
  /** The parsed citation (absent when malformed). */
  citation?: Citation;
  /** Short reason; never contains note or record text. */
  detail: string;
  /** The evidence record, for a resolved `thesis:`/`outcome:` citation. */
  evidence?: Extract<EvidenceResolution, { found: true }>;
}

export interface ResolveContext {
  /** Current note revisions by id (the index in production). Without it, note citations are unresolved. */
  notes?: NoteLookup;
  /** Local evidence. Without it, `thesis:`/`outcome:` citations are unresolved. */
  evidence?: EvidenceSource;
  /** Whether a reference passage exists locally (refs.db). Without it, `ref:` citations are unresolved. */
  refs?: (refId: string, chapter: string, ordinal: number) => boolean;
}

/** Resolve one citation string. Uncached; see `CitationResolver`. */
export function resolveCitation(cite: unknown, ctx: ResolveContext): CitationResolution {
  const parsed = parseCitation(cite);
  if (!parsed.ok) return { status: 'malformed', detail: parsed.error };
  const c = parsed.citation;
  switch (c.kind) {
    case 'note': {
      if (ctx.notes === undefined) return { status: 'unresolved', citation: c, detail: 'no note index available' };
      const f = checkNoteCitation(c, ctx.notes);
      if (f === 'fresh') return { status: 'resolved', citation: c, detail: 'note at the cited rev' };
      if (f === 'stale') return { status: 'stale', citation: c, detail: 'note changed since it was cited' };
      return { status: 'unresolved', citation: c, detail: 'no note with this id' };
    }
    case 'thesis':
    case 'outcome': {
      if (ctx.evidence === undefined) return { status: 'unresolved', citation: c, detail: 'no evidence source configured' };
      const r = ctx.evidence.resolve(c.kind, c.id);
      if (!r.found) return { status: 'unresolved', citation: c, detail: `no ${c.kind} record with this id in local evidence` };
      return { status: 'resolved', citation: c, detail: `${c.kind} record found`, evidence: r };
    }
    case 'ref':
      if (ctx.refs === undefined) return { status: 'unresolved', citation: c, detail: 'no reference library available' };
      return ctx.refs(c.refId, c.chapter, c.ordinal)
        ? { status: 'resolved', citation: c, detail: 'reference passage found' }
        : { status: 'unresolved', citation: c, detail: 'no such reference passage' };
    case 'commit':
    case 'url':
      return { status: 'unresolved', citation: c, detail: `${c.kind} citations are not resolved (local only, no network)` };
  }
}

/** Per-run resolver: each distinct citation is resolved once and cached for this object's lifetime only. */
export class CitationResolver {
  private readonly cache = new Map<string, CitationResolution>();

  constructor(private readonly ctx: ResolveContext) {}

  resolve(cite: string): CitationResolution {
    let r = this.cache.get(cite);
    if (r === undefined) {
      r = resolveCitation(cite, this.ctx);
      this.cache.set(cite, r);
    }
    return r;
  }

  /** How many distinct citations this run has resolved. */
  get size(): number {
    return this.cache.size;
  }
}
