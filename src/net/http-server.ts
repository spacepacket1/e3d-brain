// Optional MCP over Streamable HTTP (Phase 15), off by default. Binds to a
// loopback address only and requires a per-principal bearer token (token.ts).
// Intended for the owner to tunnel (for example over a private network);
// public exposure is unsupported. Stateless: each POST gets its own SDK server
// over the shared dispatcher, so mode, fencing, caps, and audit are unchanged.
// Logs never contain tokens, tool arguments, or note text.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { LoadedConfig } from '../config.js';
import { ensureStateDir } from '../config.js';
import { createMcpRuntime, createSdkServer } from '../mcp/server.js';
import { isLoopbackHost } from './hosts.js';
import { verifyToken } from './token.js';

export const DEFAULT_HTTP_PORT = 8787;
export const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;

export class HttpBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpBindError';
  }
}

/** Normalize a bind host. Throws unless it is a loopback address. */
export function checkBindHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return '127.0.0.1';
  const bare = h.replace(/^\[|\]$/g, '');
  if (bare === '::1') return '::1';
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || !isLoopbackHost(h)) {
    throw new HttpBindError(`refusing to bind ${JSON.stringify(host)}: the HTTP transport serves loopback addresses only`);
  }
  return h;
}

export interface HttpServerOptions {
  loaded: LoadedConfig;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  log?: (line: string) => void;
}

export interface RunningHttpServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

function reply(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function hostnameOf(value: string): string {
  const m = /^(\[[^\]]+\]|[^:]*)(?::\d+)?$/.exec(value.trim());
  return (m?.[1] ?? '').toLowerCase();
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpBindError('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Start serving. Throws before listening if the host is not loopback or the config/index is unusable. */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`ebrain mcp: ${line}\n`));
  const host = checkBindHost(opts.host ?? '127.0.0.1');
  const port = opts.port ?? DEFAULT_HTTP_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HttpBindError('invalid port');
  const { config } = opts.loaded;
  const runtime = createMcpRuntime(opts.loaded);
  const stateDir = ensureStateDir(config);
  const principal = config.principal.id;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // Auth first: an unauthenticated caller learns nothing else.
    const m = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (m === null || !verifyToken(stateDir, principal, m[1]!)) {
      reply(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      return;
    }
    // DNS-rebinding guard: Host and any Origin must be loopback names.
    if (!isLoopbackHost(hostnameOf(req.headers.host ?? '')) && hostnameOf(req.headers.host ?? '') !== '[::1]') {
      reply(res, 403, 'forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let ok = false;
      try {
        ok = isLoopbackHost(new URL(origin).hostname);
      } catch {
        ok = false;
      }
      if (!ok) {
        reply(res, 403, 'forbidden origin');
        return;
      }
    }
    if ((req.url ?? '').split('?')[0] !== MCP_PATH) {
      reply(res, 404, 'not found');
      return;
    }
    if (req.method !== 'POST') {
      reply(res, 405, 'method not allowed', { allow: 'POST' });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      reply(res, err instanceof HttpBindError ? 413 : 400, err instanceof HttpBindError ? 'body too large' : 'invalid JSON');
      return;
    }
    const server = createSdkServer(runtime.ctx, log);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, 'internal error');
      else res.end();
    });
  });
  httpServer.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  }).catch((err) => {
    runtime.close();
    throw err;
  });
  const addr = httpServer.address() as AddressInfo;
  const shown = host.includes(':') ? `[${host}]` : host;
  const url = `http://${shown}:${addr.port}${MCP_PATH}`;
  log(`serving ${runtime.toolCount} tools over HTTP at ${url} (principal ${principal}, mode ${config.mode}); loopback only, tunnel it yourself, never expose publicly`);
  return {
    host,
    port: addr.port,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => {
          runtime.close();
          log('stopped');
          resolve();
        });
        httpServer.closeAllConnections();
      }),
  };
}
