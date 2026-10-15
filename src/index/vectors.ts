// Optional chunk embeddings (Phase 12). Vectors live in `chunk_vectors` as
// unit-length float32 BLOBs; similarity search is brute-force cosine, which is
// exact and fast enough at personal-vault scale. A vector is valid while its
// `chunk_rev` (content hash) and `model` still match the chunk: editing a
// chunk or changing `embeddings.model` makes it stale, and the next
// `ebrain reindex` re-embeds it. Only already-scrubbed text is sent (I5).
//
// Ordering is not done here: `rank.ts` selects, fuses, and orders (I13).

import type { Db } from './db.js';
import type { Embedder } from '../net/ollama.js';
import { scrubForWrite } from '../scrub/scrub.js';

/** Chunks per embedding request. */
export const EMBED_BATCH = 16;

export interface EmbedSummary {
  provider: string;
  model: string;
  embedded: number;
  /** Chunks whose vector was already current (or copied from an identical chunk). */
  unchanged: number;
  /** Chunks left without a vector because the embedding server failed. */
  failed: number;
  /** Warnings, counted in the reindex summary; never thrown. */
  warnings: number;
  /** Why embedding stopped, without any text. */
  warning?: string;
}

export interface ScoredChunk {
  path: string;
  ordinal: number;
  cosine: number;
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Buffer, dimensions: number): Float32Array | undefined {
  if (b.byteLength !== dimensions * 4) return undefined;
  const copy = new Uint8Array(b); // aligned copy
  return new Float32Array(copy.buffer, 0, dimensions);
}

/** Scale to unit length; undefined for an all-zero vector. */
export function normalize(v: readonly number[]): Float32Array | undefined {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!(norm > 0) || !Number.isFinite(norm)) return undefined;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

interface MissingChunk {
  note_path: string;
  ordinal: number;
  chunk_rev: string;
  text: string;
}

/** Text for an embedding request: scrubbed, non-strict (secrets become `[REDACTED:<type>]`). */
export function scrubbedForEmbedding(text: string, extraPatterns: readonly string[] = []): string {
  return scrubForWrite(text, { extraPatterns }).text;
}

/**
 * Bring `chunk_vectors` in line with `chunks`: drop vectors of another model
 * or of chunks that no longer exist, then embed chunks that lack a current
 * vector. Embedding failures stop the run and are reported in the summary.
 */
export async function syncEmbeddings(db: Db, embedder: Embedder, opts: { extraPatterns?: readonly string[] } = {}): Promise<EmbedSummary> {
  const out: EmbedSummary = { provider: embedder.provider, model: embedder.model, embedded: 0, unchanged: 0, failed: 0, warnings: 0 };
  db.prepare('DELETE FROM chunk_vectors WHERE model <> ?').run(embedder.model);
  const missing = db
    .prepare(
      `SELECT c.note_path AS note_path, c.ordinal AS ordinal, c.chunk_rev AS chunk_rev, c.text AS text
       FROM chunks c LEFT JOIN chunk_vectors v
         ON v.note_path = c.note_path AND v.ordinal = c.ordinal AND v.chunk_rev = c.chunk_rev
       WHERE v.note_path IS NULL ORDER BY c.note_path, c.ordinal`,
    )
    .all() as MissingChunk[];
  const total = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  out.unchanged = total - missing.length;

  const insert = db.prepare(
    'INSERT OR REPLACE INTO chunk_vectors (note_path, ordinal, chunk_rev, model, dimensions, vector) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const sameContent = db.prepare('SELECT dimensions, vector FROM chunk_vectors WHERE chunk_rev = ? AND model = ? LIMIT 1');
  // Identical text elsewhere already has a vector: copy it instead of asking the server again.
  const todo: MissingChunk[] = [];
  const copies: { c: MissingChunk; dimensions: number; vector: Buffer }[] = [];
  for (const c of missing) {
    const same = sameContent.get(c.chunk_rev, embedder.model) as { dimensions: number; vector: Buffer } | undefined;
    if (same === undefined) todo.push(c);
    else copies.push({ c, ...same });
  }
  db.transaction(() => {
    for (const { c, dimensions, vector } of copies) insert.run(c.note_path, c.ordinal, c.chunk_rev, embedder.model, dimensions, vector);
  })();
  out.unchanged += copies.length;

  const dims = db.prepare('SELECT dimensions FROM chunk_vectors LIMIT 1').get() as { dimensions: number } | undefined;
  let expected = dims?.dimensions;
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    try {
      const vectors = await embedder.embed(batch.map((c) => scrubbedForEmbedding(c.text, opts.extraPatterns)));
      const units = vectors.map((v) => normalize(v));
      expected ??= vectors[0]?.length;
      if (units.some((u) => u === undefined || u.length !== expected)) throw new Error('embedding server returned an unusable vector');
      db.transaction(() => {
        batch.forEach((c, j) => insert.run(c.note_path, c.ordinal, c.chunk_rev, embedder.model, expected, toBlob(units[j]!)));
      }).immediate();
      out.embedded += batch.length;
    } catch (err) {
      out.failed = todo.length - out.embedded;
      out.warnings = 1;
      out.warning = err instanceof Error ? err.message : 'embedding failed';
      break;
    }
  }
  db.prepare(
    `DELETE FROM chunk_vectors WHERE NOT EXISTS (
       SELECT 1 FROM chunks c WHERE c.note_path = chunk_vectors.note_path AND c.ordinal = chunk_vectors.ordinal AND c.chunk_rev = chunk_vectors.chunk_rev)`,
  ).run();
  return out;
}

/** Cosine similarity of `query` (unit length) with every current vector of `model` and the query's dimensions. Unordered. */
export function scoreVectors(db: Db, model: string, query: Float32Array): ScoredChunk[] {
  const rows = db
    .prepare(
      `SELECT v.note_path AS path, v.ordinal AS ordinal, v.dimensions AS dimensions, v.vector AS vector
       FROM chunk_vectors v JOIN chunks c ON c.note_path = v.note_path AND c.ordinal = v.ordinal AND c.chunk_rev = v.chunk_rev
       WHERE v.model = ? AND v.dimensions = ?`,
    )
    .all(model, query.length) as { path: string; ordinal: number; dimensions: number; vector: Buffer }[];
  const out: ScoredChunk[] = [];
  for (const r of rows) {
    const v = fromBlob(r.vector, r.dimensions);
    if (v === undefined) continue;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i]! * query[i]!;
    out.push({ path: r.path, ordinal: r.ordinal, cosine: dot });
  }
  return out;
}

export function vectorCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors').get() as { n: number }).n;
}
