// Ollama embeddings client (Phase 12). With the HTTP server of Phase 15, the
// only module family allowed to touch the network (I3, a source scan test).
// Callers pass already-scrubbed text (I5); nothing else is ever sent.

import type { EmbeddingsConfig } from '../config.js';
import { checkBaseUrl } from './hosts.js';

export const EMBED_TIMEOUT_MS = 60_000;
/** A response larger than this is refused (a hostile or broken server cannot exhaust memory). */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedError';
  }
}

export interface Embedder {
  provider: string;
  model: string;
  /** One vector per input text, in order. Rejects with EmbedError. */
  embed(texts: readonly string[]): Promise<number[][]>;
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new EmbedError('response too large');
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new EmbedError('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOllamaEmbedder(baseUrl: string, model: string, allowedHosts: readonly string[]): Embedder {
  // Re-checked here as well as at config load: this is the call site.
  const base = checkBaseUrl(baseUrl, allowedHosts);
  return {
    provider: 'ollama',
    model,
    async embed(texts) {
      let res: Response;
      try {
        res = await fetch(`${base}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
          redirect: 'error',
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (err) {
        throw new EmbedError(`embedding server unreachable (${err instanceof Error ? err.name : 'error'})`);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new EmbedError(`embedding server returned HTTP ${res.status}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readCapped(res));
      } catch (err) {
        if (err instanceof EmbedError) throw err;
        throw new EmbedError('embedding server returned invalid JSON');
      }
      const vectors = (parsed as { embeddings?: unknown } | null)?.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new EmbedError('embedding server returned the wrong number of vectors');
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
          throw new EmbedError('embedding server returned a malformed vector');
        }
      }
      return vectors as number[][];
    },
  };
}

/** The configured embedder, or undefined for provider `none` (no network code is touched). */
export function createEmbedder(cfg: EmbeddingsConfig, allowedHosts: readonly string[]): Embedder | undefined {
  if (cfg.provider === 'none') return undefined;
  return createOllamaEmbedder(cfg.baseUrl, cfg.model, allowedHosts);
}
