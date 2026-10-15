// Generic JSON POST for the shared LLM layer (Phase 14). Like the embeddings
// client, this is in `src/net/` because network APIs may appear nowhere else
// (I3, a source scan test). Every call re-checks the URL against the host
// policy, refuses redirects, has a timeout, and caps the response size.
// Callers (src/llm/) send only already-scrubbed text (I5).

import { checkBaseUrl } from './hosts.js';

export const DEFAULT_POST_TIMEOUT_MS = 120_000;
/** A response larger than this is refused. */
export const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;

export class NetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetError';
  }
}

export interface PostJsonOptions {
  allowedHosts: readonly string[];
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) throw new NetError('response too large');
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new NetError('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * POST `body` as JSON to `baseUrl` + `path` and return the parsed JSON
 * response. Rejects with NetError (never including request or response
 * bodies in the message, which may hold archive text or keys).
 */
export async function postJson(baseUrl: string, urlPath: string, body: unknown, opts: PostJsonOptions): Promise<unknown> {
  const base = checkBaseUrl(baseUrl, opts.allowedHosts);
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(urlPath)) throw new NetError('invalid request path');
  let res: Response;
  try {
    res = await fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new NetError(`server unreachable (${err instanceof Error ? err.name : 'error'})`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new NetError(`server returned HTTP ${res.status}`);
  }
  const text = await readCapped(res, opts.maxResponseBytes ?? MAX_JSON_RESPONSE_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NetError('server returned invalid JSON');
  }
}
