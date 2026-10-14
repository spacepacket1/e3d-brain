// Phase 15: optional loopback HTTP transport. Spawns `ebrain mcp --http` on
// port 0, checks bind refusal, bearer-token handling, token storage (hash
// only), and that two instances (different config, vault, state dir, and
// principal) cannot read each other's data.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { realTmpDir, repoRoot, rmrf } from './helpers.js';

const cli = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
const bases: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const b of bases) rmrf(b);
});

interface Inst {
  base: string;
  stateDir: string;
  config: string;
}

function makeInst(principal: string, canary: string): Inst {
  const base = realTmpDir('ebrain-p15-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'curated'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'curated', 'Note.md'), `---\nstatus: accepted\n---\n# Note\n${canary} unique words here\n`);
  const stateDir = path.join(base, 'state');
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ vaultPath: vault, stateDir, principal: { id: principal, type: 'human' }, mode: 'inbox' }), { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  return { base, stateDir, config };
}

const env = (i: Inst) => ({ PATH: process.env.PATH ?? '', HOME: i.base, EBRAIN_CONFIG: i.config });
const eb = (i: Inst, ...args: string[]) => spawnSync(process.execPath, [cli(), ...args], { env: env(i), encoding: 'utf8' });

function token(i: Inst, principal: string): string {
  const r = eb(i, 'token', 'create', '--principal', principal);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

async function serve(i: Inst): Promise<string> {
  const child = spawn(process.execPath, [cli(), 'mcp', '--http', '--port', '0'], { env: env(i), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr!.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    child.stderr!.on('data', (c: string) => {
      err += c;
      const m = /at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(err);
      if (m) resolve(m[1]!);
    });
    child.on('exit', () => reject(new Error(`exited: ${err}`)));
  });
}

const rpc = (method: string, params: unknown = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
async function post(url: string, body: string, auth?: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth === undefined ? {} : { authorization: auth }), ...extra },
    body,
  });
}
const init = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });

function allFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) allFiles(f, out);
    else out.push(f);
  }
  return out;
}

describe('ebrain mcp --http', () => {
  it('refuses non-loopback hosts', () => {
    const i = makeInst('alice', 'zebra');
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '10.0.0.1']) {
      const r = eb(i, 'mcp', '--http', '--host', host, '--port', '0');
      assert.equal(r.status, 1, host);
      assert.match(r.stderr, /loopback/, host);
    }
  });

  it('token create is per-principal, 32+ bytes, stored hashed only', () => {
    const i = makeInst('alice', 'zebra');
    const t = token(i, 'alice');
    assert.match(t, /^ebt_alice\.[A-Za-z0-9_-]{43}$/);
    const secret = t.split('.')[1]!;
    for (const f of allFiles(i.stateDir)) {
      const text = fs.readFileSync(f, 'latin1');
      assert.ok(!text.includes(secret), `plaintext token in ${f}`);
    }
    assert.equal(fs.statSync(path.join(i.stateDir, 'http-tokens.json')).mode & 0o777, 0o600);
    const other = eb(i, 'token', 'create', '--principal', 'bob');
    assert.equal(other.status, 1);
    assert.equal(eb(i, 'token', 'create').status, 2);
  });

  it('rejects missing, wrong, and malformed tokens; accepts the valid one', async () => {
    const i = makeInst('alice', 'zebra');
    const t = token(i, 'alice');
    const url = await serve(i);
    const secret = t.split('.')[1]!;
    for (const auth of [undefined, 'Bearer', 'Bearer nope', `Basic ${secret}`, `Bearer ${secret}`, `Bearer ebt_alice.${'A'.repeat(43)}`, `Bearer ${t}x`, `Bearer ebt_bob.${secret}`]) {
      const r = await post(url, init, auth);
      assert.equal(r.status, 401, String(auth));
    }
    const ok = await post(url, init, `Bearer ${t}`);
    assert.equal(ok.status, 200);
    const tools = await post(url, rpc('tools/list', {}, 2), `Bearer ${t}`);
    const names = ((await tools.json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
    assert.ok(names.includes('search'));
    // Wrong Origin and non-POST are refused after auth.
    assert.equal((await post(url, init, `Bearer ${t}`, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${t}` } })).status, 405);
    // Rotation invalidates the old token.
    const t2 = token(i, 'alice');
    assert.equal((await post(url, init, `Bearer ${t}`)).status, 401);
    assert.equal((await post(url, init, `Bearer ${t2}`)).status, 200);
  });

  it('two instances cannot read each other or use each other\'s tokens', async () => {
    const a = makeInst('alice', 'zebraalpha');
    const b = makeInst('bob', 'yakbravo');
    const ta = token(a, 'alice');
    const tb = token(b, 'bob');
    const ua = await serve(a);
    const ub = await serve(b);
    assert.notEqual(ua, ub);
    assert.equal((await post(ua, init, `Bearer ${tb}`)).status, 401);
    assert.equal((await post(ub, init, `Bearer ${ta}`)).status, 401);
    const search = async (url: string, tok: string, q: string) => {
      const r = await post(url, rpc('tools/call', { name: 'search', arguments: { query: q } }, 3), `Bearer ${tok}`);
      return JSON.stringify(await r.json());
    };
    assert.match(await search(ua, ta, 'zebraalpha'), /zebraalpha/);
    assert.ok(!/yakbravo/.test(await search(ua, ta, 'yakbravo')));
    assert.match(await search(ub, tb, 'yakbravo'), /yakbravo/);
    assert.ok(!/zebraalpha/.test(await search(ub, tb, 'zebraalpha')));
  });

  it('a shared state dir still binds a token to its principal', () => {
    const a = makeInst('alice', 'zebra');
    const ta = token(a, 'alice');
    // A second instance with another principal and the same state dir cannot use alice's token.
    const b = makeInst('bob', 'yak');
    fs.writeFileSync(b.config, JSON.stringify({ vaultPath: path.join(b.base, 'vault'), stateDir: a.stateDir, principal: { id: 'bob', type: 'human' }, mode: 'inbox' }), { mode: 0o600 });
    return serve(b).then(async (url) => {
      assert.equal((await post(url, init, `Bearer ${ta}`)).status, 401);
    });
  });
});
