// Phase 12: optional local embeddings and hybrid search. A mock Ollama server
// on loopback maps text to topic vectors, so "semantic" similarity is exact.

import { after, afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { ConfigError, parseConfig } from '../src/config.js';
import { runReindex } from '../src/cli/index-commands.js';
import { closeIndex, openIndex, reindex } from '../src/index/indexer.js';
import { chunkKey, fuseRrf, nearestChunks, RRF_K, rank, type RankItem } from '../src/index/rank.js';
import { scoreVectors, syncEmbeddings, vectorCount } from '../src/index/vectors.js';
import { dispatch, renderContent, ToolRegistry, type DispatchContext } from '../src/mcp/dispatch.js';
import { registerReadTools } from '../src/mcp/tools.js';
import { checkBaseUrl, isLoopbackHost } from '../src/net/hosts.js';
import { createEmbedder, createOllamaEmbedder, type Embedder } from '../src/net/ollama.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import { realTmpDir, repoRoot, rmrf } from './helpers.js';

const bases: string[] = [];
const servers: http.Server[] = [];
after(() => {
  for (const b of bases) rmrf(b);
  for (const s of servers) s.close();
});
afterEach(() => mock.restoreAll());

// Topics: animals, vehicles, cooking. A text's vector counts topic words; no topic words gives a constant "other" axis.
const TOPICS = [/\b(cat|feline|kitten|pet|sofa)\b/gi, /\b(car|engine|tires?|vehicle)\b/gi, /\b(soup|recipe|kitchen)\b/gi];
function vectorOf(text: string): number[] {
  const v = TOPICS.map((re) => (text.match(re) ?? []).length);
  return [...v, v.every((x) => x === 0) ? 1 : 0];
}

interface Mock {
  url: string;
  requests: { model: string; input: string[] }[];
  fail: boolean;
  close(): Promise<void>;
}

async function mockServer(): Promise<Mock> {
  const m: Mock = { url: '', requests: [], fail: false, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (m.fail) {
        res.writeHead(500).end('boom');
        return;
      }
      const parsed = JSON.parse(body) as { model: string; input: string[] };
      m.requests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: parsed.model, embeddings: parsed.input.map(vectorOf) }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  m.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  m.close = () => new Promise((r) => server.close(() => r()));
  return m;
}

interface Env {
  base: string;
  vault: string;
  stateDir: SafePath;
  env: Record<string, string>;
  write(name: string, text: string): void;
  config(embeddings?: Record<string, unknown>, extra?: Record<string, unknown>): void;
}

function makeEnv(): Env {
  const base = realTmpDir('ebrain-p12-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const e: Env = {
    base, vault, stateDir, env: { EBRAIN_CONFIG: configPath, HOME: base },
    write: (name, text) => fs.writeFileSync(path.join(vault, name), text),
    config: (embeddings, extra = {}) =>
      fs.writeFileSync(
        configPath,
        JSON.stringify({ vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox', ...(embeddings ? { embeddings } : {}), ...extra }),
        { mode: 0o600 },
      ),
  };
  e.write('Pets.md', '# Pets\n\nOur feline naps on the sofa all afternoon.\n');
  e.write('Cars.md', '# Cars\n\nThe engine needs new tires before winter.\n');
  e.write('Soup.md', '# Soup\n\nA kitchen recipe with leeks.\n');
  return e;
}

async function reindexOut(e: Env, ...args: string[]) {
  return runReindex(args, { env: e.env, homeDir: e.base });
}

function searchTool(e: Env, embedder?: Embedder) {
  const index = openIndex({ vaultPath: e.vault, stateDir: e.stateDir });
  const registry = new ToolRegistry();
  registerReadTools({ vaultPath: e.vault, index, mode: 'read-only', embedder }, registry);
  const ctx: DispatchContext = { mode: 'read-only', principal: { id: 't', type: 'human' }, maxCharsPerCall: 10000, registry };
  return {
    async paths(query: string): Promise<{ paths: string[]; header: Record<string, unknown> }> {
      const r = await dispatch(ctx, 'search', { query });
      assert.ok(!r.isError, JSON.stringify(r));
      const text = renderContent(r.content, 100000).text;
      const header = JSON.parse(text.split('\n', 1)[0]!) as Record<string, unknown>;
      const paths = [...text.matchAll(/"path":"([^"]+)"/g)].map((m) => m[1]!);
      return { paths, header };
    },
    close: () => closeIndex(index),
  };
}

describe('base URL policy', () => {
  it('accepts loopback by default and rejects other hosts unless allowlisted', () => {
    assert.equal(checkBaseUrl('http://127.0.0.1:11434', []), 'http://127.0.0.1:11434');
    assert.equal(checkBaseUrl('http://localhost:11434/', []), 'http://localhost:11434');
    assert.equal(checkBaseUrl('http://[::1]:11434', []), 'http://[::1]:11434');
    assert.throws(() => checkBaseUrl('http://embed.example.com:11434', []), /not in network\.allowedHosts/);
    assert.equal(checkBaseUrl('https://embed.example.com', ['embed.example.com']), 'https://embed.example.com');
    assert.throws(() => checkBaseUrl('http://127.0.0.1.evil.test', []), /allowedHosts/);
    for (const bad of ['ftp://127.0.0.1', 'http://u:p@127.0.0.1', 'http://127.0.0.1/?q=1', 'not a url']) {
      assert.throws(() => checkBaseUrl(bad, []), (err: Error) => err.name === 'HostPolicyError', bad);
    }
    assert.equal(isLoopbackHost('127.300.0.1'), false);
  });

  it('config load rejects a non-allowlisted remote host and accepts an allowlisted one', () => {
    const base = { vaultPath: '/abs/vault', principal: { id: 'c', type: 'human' }, mode: 'inbox' };
    const parse = (embeddings: unknown, hosts: string[] = []) => parseConfig({ ...base, network: { allowedHosts: hosts }, embeddings }, { homeDir: '/h' });
    assert.throws(() => parse({ provider: 'ollama', baseUrl: 'http://gpu.example.com:11434' }), (e: unknown) => e instanceof ConfigError && /embeddings\.baseUrl/.test(e.message));
    // Rejected even when the provider is none: a bad URL is never accepted silently.
    assert.throws(() => parse({ provider: 'none', baseUrl: 'http://gpu.example.com:11434' }), ConfigError);
    assert.equal(parse({ provider: 'ollama', baseUrl: 'http://gpu.example.com:11434' }, ['gpu.example.com']).embeddings.baseUrl, 'http://gpu.example.com:11434');
    const d = parse(undefined).embeddings;
    assert.deepEqual(d, { provider: 'none', model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:11434', store: 'blob' });
    assert.throws(() => parse({ provider: 'ollama', model: '' }), ConfigError);
    assert.throws(() => parse({ provider: 'ollama', store: 'sqlite-vec' }), ConfigError);
    assert.throws(() => parse({ provider: 'ollama', extra: 1 }), ConfigError);
  });
});

describe('provider none', () => {
  it('invokes no src/net code path: no embedder, no fetch, BM25 search still works', async () => {
    const e = makeEnv();
    e.config();
    const fetchSpy = mock.method(globalThis, 'fetch', async () => {
      throw new Error('network used');
    });
    assert.equal(createEmbedder({ provider: 'none', model: 'm', baseUrl: 'http://127.0.0.1:1', store: 'blob' }, []), undefined);
    const r = await reindexOut(e);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!/embeddings/.test(r.stdout), 'no embeddings line without a provider');
    const t = searchTool(e);
    const out = await t.paths('feline');
    assert.deepEqual(out.paths, ['Pets.md']);
    assert.equal(out.header['embeddings'], undefined);
    t.close();
    assert.equal(fetchSpy.mock.callCount(), 0);
  });

  it('no network API appears in src/ outside src/net/', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.split(path.sep).join('/').includes('/src/net/')) {
          const text = fs.readFileSync(full, 'utf8');
          if (/from 'node:(?:net|http|https|http2|dgram|tls)'|\bfetch\(|XMLHttpRequest|new WebSocket/.test(text)) offenders.push(full);
        }
      }
    };
    walk(path.join(repoRoot(), 'src'));
    assert.deepEqual(offenders, []);
  });
});

describe('reindex embeds; hybrid search finds what BM25 misses', () => {
  it('a semantically related note appears only with embeddings', async () => {
    const m = await mockServer();
    const e = makeEnv();
    e.config({ provider: 'ollama', model: 'm1', baseUrl: m.url });
    const r = await reindexOut(e);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /embeddings \(ollama, m1\): embedded 3, unchanged 0, failed 0\n/);

    // "cat" never occurs in any note, so BM25 alone finds nothing.
    const bm25 = searchTool(e);
    assert.deepEqual((await bm25.paths('cat')).paths, []);
    bm25.close();

    const embedder = createOllamaEmbedder(m.url, 'm1', []);
    const hybrid = searchTool(e, embedder);
    const out = await hybrid.paths('cat');
    assert.deepEqual(out.paths, ['Pets.md']);
    assert.equal(out.header['embeddings'], 'hybrid');
    // A BM25 hit on one note and a vector hit on another are both returned, deterministically.
    const mixed = await hybrid.paths('engine');
    assert.deepEqual(mixed.paths, ['Cars.md']);
    hybrid.close();
  });

  it('embeds only new or changed chunks and cleans up removed ones', async () => {
    const m = await mockServer();
    const e = makeEnv();
    e.config({ provider: 'ollama', model: 'm1', baseUrl: m.url });
    await reindexOut(e);
    m.requests.length = 0;
    const again = await reindexOut(e);
    assert.match(again.stdout, /embedded 0, unchanged 3, failed 0/);
    assert.equal(m.requests.length, 0, 'no request when nothing changed');

    e.write('Pets.md', '# Pets\n\nOur kitten naps on the sofa all afternoon.\n');
    e.write('New.md', '# New\n\nA second kitchen recipe.\n');
    const edited = await reindexOut(e);
    assert.match(edited.stdout, /embedded 2, unchanged 2, failed 0/);
    assert.deepEqual(m.requests.flatMap((r) => r.input).map((t) => t.trim()).sort(), ['# New\n\nA second kitchen recipe.', '# Pets\n\nOur kitten naps on the sofa all afternoon.']);

    fs.rmSync(path.join(e.vault, 'Soup.md'));
    await reindexOut(e);
    const h = openIndex({ vaultPath: e.vault, stateDir: e.stateDir });
    assert.equal(vectorCount(h.db), 3);
    closeIndex(h);
  });

  it('switching the model re-embeds every chunk', async () => {
    const m = await mockServer();
    const e = makeEnv();
    e.config({ provider: 'ollama', model: 'm1', baseUrl: m.url });
    await reindexOut(e);
    m.requests.length = 0;
    e.config({ provider: 'ollama', model: 'm2', baseUrl: m.url });
    const r = await reindexOut(e);
    assert.match(r.stdout, /embeddings \(ollama, m2\): embedded 3, unchanged 0, failed 0/);
    assert.ok(m.requests.every((q) => q.model === 'm2'));
    assert.equal(m.requests.flatMap((q) => q.input).length, 3);
    const h = openIndex({ vaultPath: e.vault, stateDir: e.stateDir });
    const rows = h.db.prepare('SELECT model, dimensions, chunk_rev FROM chunk_vectors').all() as { model: string; dimensions: number; chunk_rev: string }[];
    assert.equal(rows.length, 3);
    assert.ok(rows.every((x) => x.model === 'm2' && x.dimensions === 4 && /^[0-9a-f]{16}$/.test(x.chunk_rev)));
    // Vectors of the old model are never used by a search under the new one.
    assert.equal(scoreVectors(h.db, 'm1', new Float32Array([1, 0, 0, 0])).length, 0);
    closeIndex(h);
  });

  it('reindex --full keeps current vectors (same content, same model)', async () => {
    const m = await mockServer();
    const e = makeEnv();
    e.config({ provider: 'ollama', model: 'm1', baseUrl: m.url });
    await reindexOut(e);
    m.requests.length = 0;
    const r = await reindexOut(e, '--full');
    assert.match(r.stdout, /embedded 0, unchanged 3, failed 0/);
    assert.equal(m.requests.length, 0);
  });

  it('identical chunk text elsewhere reuses its vector', async () => {
    const m = await mockServer();
    const e = makeEnv();
    e.config({ provider: 'ollama', model: 'm1', baseUrl: m.url });
    await reindexOut(e);
    m.requests.length = 0;
    e.write('Copy.md', '# Cars\n\nThe engine needs new tires before winter.\n');
    const r = await reindexOut(e);
    assert.match(r.stdout, /embedded 0, unchanged 4, failed 0/);
    assert.equal(m.requests.length, 0);
  });
});

describe('failures degrade to BM25', () => {
  it('an unreachable or failing server is a counted warning, not a failed reindex', async () => {
    const m = await mockServer();
    const e = makeEnv();
    e.config({ provider: 'ollama', model: 'm1', baseUrl: m.url });
    m.fail = true;
    const r = await reindexOut(e);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^reindex \(hash\): 3 notes; added 3/);
    assert.match(r.stdout, /embeddings \(ollama, m1\): embedded 0, unchanged 0, failed 3; warnings 1: embedding server returned HTTP 500/);
    await m.close();
    const down = await reindexOut(e);
    assert.equal(down.code, 0);
    assert.match(down.stdout, /failed 3; warnings 1: embedding server unreachable/);

    // Search still answers from BM25 and says embeddings were unavailable.
    const t = searchTool(e, createOllamaEmbedder(m.url, 'm1', []));
    const out = await t.paths('feline');
    assert.deepEqual(out.paths, ['Pets.md']);
    assert.equal(out.header['embeddings'], 'unavailable');
    t.close();
  });

  it('a partial failure keeps the vectors already stored and retries the rest next time', async () => {
    const e = makeEnv();
    for (let i = 0; i < 20; i++) e.write(`n${i}.md`, `# N${i}\n\nnote ${i} kitchen\n`);
    const h = openIndex({ vaultPath: e.vault, stateDir: e.stateDir });
    reindex(h);
    let calls = 0;
    const flaky: Embedder = {
      provider: 'ollama', model: 'm1',
      async embed(texts) {
        if (++calls > 1) throw new Error('embedding server unreachable (test)');
        return texts.map(vectorOf);
      },
    };
    const first = await syncEmbeddings(h.db, flaky);
    assert.equal(first.embedded, 16);
    assert.equal(first.failed, 7);
    assert.equal(first.warnings, 1);
    assert.equal(vectorCount(h.db), 16);
    const ok: Embedder = { provider: 'ollama', model: 'm1', embed: async (t) => t.map(vectorOf) };
    const second = await syncEmbeddings(h.db, ok);
    assert.equal(second.embedded, 7);
    assert.equal(second.unchanged, 16);
    closeIndex(h);
  });

  it('a malformed response is refused', async () => {
    const server = http.createServer((_req, res) => res.writeHead(200).end(JSON.stringify({ embeddings: [[1, 'x']] })));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await assert.rejects(createOllamaEmbedder(url, 'm', []).embed(['a']), /malformed vector/);
  });
});

describe('I5: only scrubbed text leaves the process', () => {
  it('chunk text and the search query are scrubbed before the request', async () => {
    const m = await mockServer();
    const e = makeEnv();
    const secret = 'AKIAFAKEFAKEFAKEFAKE';
    e.write('Keys.md', `# Keys\n\nThe cat key is ${secret} for the pet door.\n`);
    e.config({ provider: 'ollama', model: 'm1', baseUrl: m.url });
    await reindexOut(e);
    const t = searchTool(e, createOllamaEmbedder(m.url, 'm1', []));
    await t.paths(`cat ${secret}`);
    t.close();
    const sent = m.requests.flatMap((r) => r.input).join('\n');
    assert.ok(sent.includes('[REDACTED:'), 'redaction markers were sent');
    assert.ok(!sent.includes(secret), 'the secret never reached the server');
  });
});

describe('Reciprocal Rank Fusion', () => {
  it('scores 1/(k+rank) per list, with ties broken by path then ordinal', () => {
    const bm25 = [
      { path: 'b.md', ordinal: 0, bm25: -2 },
      { path: 'a.md', ordinal: 1, bm25: -2 },
      { path: 'a.md', ordinal: 0, bm25: -2 },
    ];
    const vectors = [{ path: 'c.md', ordinal: 0, cosine: 0.9 }, { path: 'a.md', ordinal: 0, cosine: 0.5 }];
    const f = fuseRrf(bm25, vectors);
    // bm25 order: a.md#0, a.md#1, b.md#0 (equal scores tie-break); vectors: c.md#0, a.md#0.
    assert.equal(f.get(chunkKey({ path: 'a.md', ordinal: 0 })), 1 / (RRF_K + 1) + 1 / (RRF_K + 2));
    assert.equal(f.get(chunkKey({ path: 'a.md', ordinal: 1 })), 1 / (RRF_K + 2));
    assert.equal(f.get(chunkKey({ path: 'b.md', ordinal: 0 })), 1 / (RRF_K + 3));
    assert.equal(f.get(chunkKey({ path: 'c.md', ordinal: 0 })), 1 / (RRF_K + 1));
  });

  it('rank() orders by fused score within a tier, ties by path then ordinal, independent of input order', () => {
    const mk = (path: string, ordinal: number, fused: number): RankItem => ({ path, ordinal, folderClass: 'curated', fused, bm25: 0 });
    const items = [mk('z.md', 0, 0.02), mk('b.md', 1, 0.01), mk('b.md', 0, 0.01), mk('a.md', 0, 0.01)];
    const expected = ['z.md#0', 'a.md#0', 'b.md#0', 'b.md#1'];
    for (const input of [items, [...items].reverse(), [items[2]!, items[0]!, items[3]!, items[1]!]]) {
      assert.deepEqual(rank(input).map((r) => `${r.item.path}#${r.item.ordinal}`), expected);
    }
  });

  it('nearestChunks applies the cosine floor and the limit deterministically', () => {
    const scored = [
      { path: 'a.md', ordinal: 0, cosine: 0.1 },
      { path: 'b.md', ordinal: 0, cosine: 0.8 },
      { path: 'a.md', ordinal: 0 + 1, cosine: 0.8 },
      { path: 'c.md', ordinal: 0, cosine: 0.5 },
    ];
    assert.deepEqual(nearestChunks(scored, 2).map((s) => chunkKey(s)), [chunkKey({ path: 'a.md', ordinal: 1 }), chunkKey({ path: 'b.md', ordinal: 0 })]);
  });
});
