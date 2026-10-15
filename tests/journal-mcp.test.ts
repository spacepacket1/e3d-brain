// Phase 9 integration: spawned `ebrain mcp` servers. Tool lists per mode
// match expectedTools(<mode>, 9); two concurrent appends to one target name
// give one file and one error; rate, total-size, and duplicate limits hold
// across two server processes sharing one journal (and are audited); a fresh
// entry is searchable at once; two agents with separate vaults cannot read
// each other's journals; the owner CLI (`import agent-workspace`, `journal
// prune`).

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORBIDDEN_TOOL_NAME } from '../src/mcp/dispatch.js';
import { realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';
import { header, McpProcess, results, type ToolResponse } from './mcp-client.js';
import { fake } from './scrub-fixtures.js';
import { checkToolsSincePhase, expectedTools, TOOL_MODES, type ToolMode } from './tool-registry.js';

const PHASE = 9;
const cli = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
const bases: string[] = [];
after(() => {
  for (const b of bases) rmrf(b);
});

interface Instance {
  base: string;
  vault: string;
  stateDir: string;
  config: string;
}

function makeInstance(mode: ToolMode, opts: { id?: string; journal?: Record<string, number> } = {}): Instance {
  const base = realTmpDir('ebrain-p9i-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault);
  const stateDir = path.join(base, 'state');
  const config = path.join(base, 'config.json');
  const type = mode === 'journal' ? 'agent' : 'human';
  const body: Record<string, unknown> = { vaultPath: vault, stateDir, principal: { id: opts.id ?? 'agent-1', type }, mode };
  if (opts.journal !== undefined) body['journal'] = opts.journal;
  fs.writeFileSync(config, JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  return { base, vault, stateDir, config };
}

function run(inst: Instance, args: string[], cwd?: string) {
  const res = spawnSync(process.execPath, [cli(), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: inst.base, EBRAIN_CONFIG: inst.config },
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function auditLines(stateDir: string): Record<string, unknown>[] {
  const file = path.join(stateDir, 'audit.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

function entryFiles(vault: string, pid: string): string[] {
  const out: string[] = [];
  const root = path.join(vault, 'journal', pid);
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else out.push(path.join(d, e.name));
    }
  };
  walk(root);
  return out;
}

function text(r: ToolResponse): string {
  return r.content[0]!.text;
}

async function withServers<T>(configs: string[], fn: (ms: McpProcess[]) => Promise<T>): Promise<T> {
  const ms = configs.map((c) => new McpProcess(c));
  try {
    await Promise.all(ms.map((m) => m.initialize()));
    return await fn(ms);
  } finally {
    await Promise.all(ms.map((m) => m.close()));
  }
}

describe('ebrain mcp: journal tools by mode', () => {
  for (const mode of TOOL_MODES) {
    it(`mode ${mode}: tools/list matches expectedTools(${mode}, ${PHASE})`, async () => {
      const inst = makeInstance(mode);
      await withServers([inst.config], async ([m]) => {
        const listed = await m!.listTools();
        // Exactly the phase-9 tools, plus only later-phase registry tools of this mode.
        assert.equal(checkToolsSincePhase(listed, mode, PHASE), undefined);
        for (const name of listed) assert.ok(!FORBIDDEN_TOOL_NAME.test(name), name);
        for (const name of listed) assert.ok(!/accept|promote|edit|delete|move|overwrite|run|job|start/.test(name), name);
        assert.equal(listed.includes('journal_append'), mode === 'journal');
        if (mode !== 'journal') {
          const r = await m!.call('journal_append', { title: 'x', body: 'y' });
          assert.equal(r.isError, true);
          assert.ok(!fs.existsSync(path.join(inst.vault, 'journal')) || entryFiles(inst.vault, 'agent-1').length === 0);
        }
      });
    });
  }
});

describe('create-only under a race', () => {
  it('two concurrent appends to the same target name produce one file and one error', async () => {
    const base = realTmpDir('ebrain-p9r-');
    bases.push(base);
    const vault = path.join(base, 'vault');
    const state = path.join(base, 'state');
    fs.mkdirSync(vault);
    fs.mkdirSync(state, { mode: 0o700 });
    const gate = path.join(base, 'go');
    const worker = path.join(repoRoot(), 'dist', 'tests', 'journal-worker.js');
    const spawnWorker = (body: string) =>
      new Promise<string>((resolve, reject) => {
        const c = spawn(process.execPath, [worker, 'append', vault, state, gate, body], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        c.stdout.on('data', (d: Buffer) => (out += d.toString()));
        c.stderr.on('data', (d: Buffer) => (err += d.toString()));
        c.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
      });
    const both = Promise.all([spawnWorker('body from one'), spawnWorker('body from two')]);
    setTimeout(() => fs.writeFileSync(gate, ''), 150);
    const outcomes = (await both).sort();
    assert.deepEqual(outcomes, ['exists', 'ok']);
    const files = entryFiles(vault, 'racer');
    assert.deepEqual(files.map((f) => path.relative(vault, f)), [path.join('journal', 'racer', '2026', '20261014-120000-same.md')]);
  });
});

describe('limits hold across two server processes on one journal', () => {
  it('rate: exactly maxEntriesPerHour entries are created; the rest are rejected and audited', async () => {
    const inst = makeInstance('journal', { journal: { maxEntriesPerHour: 4 } });
    await withServers([inst.config, inst.config], async (ms) => {
      const calls = ms.flatMap((m, i) => Array.from({ length: 4 }, (_, j) => m.call('journal_append', { title: `s${i} e${j}`, body: `server ${i} entry ${j}` })));
      const rs = await Promise.all(calls);
      assert.equal(rs.filter((r) => r.isError !== true).length, 4, rs.map(text).join('\n'));
      assert.equal(rs.filter((r) => r.structuredContent?.error.type === 'limit').length, 4);
    });
    assert.equal(entryFiles(inst.vault, 'agent-1').length, 4);
    const rejected = auditLines(inst.stateDir).filter((l) => l['outcome'] === 'rejected');
    assert.equal(rejected.length, 4);
    for (const l of rejected) assert.deepEqual(l['error'], { type: 'limit', code: 'rate' });
  });

  it('duplicate: the same body from two servers creates one entry; the other gets the existing path', async () => {
    const inst = makeInstance('journal');
    const rs = await withServers([inst.config, inst.config], (ms) =>
      Promise.all(ms.map((m, i) => m.call('journal_append', { title: `dup ${i}`, body: 'identical heartbeat body' }))));
    const ok = rs.filter((r) => r.isError !== true);
    const dup = rs.filter((r) => r.isError === true);
    assert.equal(ok.length, 1);
    assert.equal(dup.length, 1);
    assert.ok(text(dup[0]!).includes(String(header(ok[0]!)['path'])), text(dup[0]!));
    assert.equal(entryFiles(inst.vault, 'agent-1').length, 1);
    assert.deepEqual(auditLines(inst.stateDir).find((l) => l['outcome'] === 'rejected')!['error'], { type: 'limit', code: 'duplicate' });
  });

  it('total size: the journal never exceeds maxTotalMB', async () => {
    const budget = 1400;
    const inst = makeInstance('journal', { journal: { maxTotalMB: budget / (1024 * 1024) } });
    const rs = await withServers([inst.config, inst.config], (ms) =>
      Promise.all(ms.flatMap((m, i) => Array.from({ length: 4 }, (_, j) => m.call('journal_append', { title: `t${i}x${j}`, body: `size test ${i} ${j}` })))));
    const files = entryFiles(inst.vault, 'agent-1');
    const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    assert.ok(total <= budget, `${total} > ${budget}`);
    assert.ok(files.length >= 1 && files.length < 8);
    assert.equal(rs.filter((r) => r.isError === true).length, 8 - files.length);
    const codes = auditLines(inst.stateDir).filter((l) => l['outcome'] === 'rejected').map((l) => (l['error'] as { code: string }).code);
    assert.ok(codes.length === 8 - files.length && codes.every((c) => c === 'total-size'), codes.join(','));
  });

  it('strict scrub over MCP: a fake API key stores nothing', async () => {
    const inst = makeInstance('journal');
    const key = fake.openai();
    const r = await withServers([inst.config], ([m]) => m!.call('journal_append', { title: 'k', body: `key ${key}` }));
    assert.equal(r.structuredContent?.error.type, 'strict-scrub');
    assert.equal(entryFiles(inst.vault, 'agent-1').length, 0);
    assert.ok(!fs.readFileSync(path.join(inst.stateDir, 'audit.jsonl'), 'utf8').includes(key));
  });
});

describe('isolation and freshness', () => {
  it('a fresh entry is searchable at once; two agents with separate vaults cannot read each other', async () => {
    const a = makeInstance('journal', { id: 'agent-a' });
    const b = makeInstance('journal', { id: 'agent-b' });
    await withServers([a.config, b.config], async ([ma, mb]) => {
      const ha = header(await ma!.call('journal_append', { title: 'alpha', body: 'alphaprivatemarker' }));
      await mb!.call('journal_append', { title: 'beta', body: 'betaprivatemarker' });
      assert.equal(results(await ma!.call('search', { query: 'alphaprivatemarker' })).length, 1);
      assert.equal(results(await mb!.call('search', { query: 'betaprivatemarker' })).length, 1);
      assert.equal(results(await ma!.call('search', { query: 'betaprivatemarker' })).length, 0);
      assert.equal(results(await mb!.call('search', { query: 'alphaprivatemarker' })).length, 0);
      assert.equal((await mb!.call('read_note', { path: String(ha['path']) })).isError, true);
      assert.equal(results(await mb!.call('journal_list', {})).every((r) => String(r['path']).startsWith('journal/agent-b/')), true);
      assert.equal(results(await mb!.call('list_notes', {})).length, 1);
    });
    assert.ok(!fs.existsSync(path.join(a.vault, 'journal', 'agent-b')));
    assert.ok(!fs.existsSync(path.join(b.vault, 'journal', 'agent-a')));
  });
});

describe('owner CLI: import agent-workspace and journal prune', () => {
  it('import refuses another principal, imports once, skips a private key, never touches the source', () => {
    const inst = makeInstance('journal', { id: 'agent-w' });
    const ws = path.join(inst.base, 'agents', 'workspace');
    fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Memory\n\nlong-term facts\n');
    fs.writeFileSync(path.join(ws, 'GOALS.md'), '# Goals\n\n- one\n');
    fs.writeFileSync(path.join(ws, 'memory', '2026-10-13.md'), 'yesterday\n');
    const label = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ');
    fs.writeFileSync(path.join(ws, 'memory', '2026-10-14.md'), `today\n-----BEGIN ${label}-----\n${fake.pemBody(3)}\n-----END ${label}-----\n`);
    const sum = treeChecksum(ws);

    const wrong = run(inst, ['import', 'agent-workspace', ws, '--principal', 'someone-else']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /does not match the configured principal/);
    assert.ok(!fs.existsSync(path.join(inst.vault, 'journal')));

    const first = run(inst, ['import', 'agent-workspace', 'agents/workspace', '--principal', 'agent-w'], inst.base);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /3 imported, 0 unchanged, 1 skipped/);
    assert.match(first.out, /skipped memory\/2026-10-14\.md: strict scrub/);
    const second = run(inst, ['import', 'agent-workspace', ws, '--principal', 'agent-w']);
    assert.match(second.out, /0 imported, 3 unchanged, 1 skipped/);
    assert.equal(treeChecksum(ws), sum);
    assert.equal(entryFiles(inst.vault, 'agent-w').length, 3);
    assert.equal(run(inst, ['import', 'agent-workspace', ws]).code, 2);
  });

  it('journal prune archives expired entries (never deletes) and search hides them meanwhile', async () => {
    const inst = makeInstance('journal', { id: 'agent-p' });
    const dir = path.join(inst.vault, 'journal', 'agent-p', '2026');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '20260101-000000-old.md'), '---\nstatus: journal\nexpires: 2026-02-01T00:00:00Z\n---\n# old\n\nprunemarker old\n');
    fs.writeFileSync(path.join(dir, '20260101-000001-live.md'), '---\nstatus: journal\nexpires: 2099-01-01T00:00:00Z\n---\n# live\n\nprunemarker live\n');
    await withServers([inst.config], async ([m]) => {
      assert.equal(results(await m!.call('search', { query: 'prunemarker' })).length, 1);
      assert.equal(results(await m!.call('search', { query: 'prunemarker', include_expired: true })).length, 2);
    });
    const dry = run(inst, ['journal', 'prune', '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /would archive journal\/agent-p\/2026\/20260101-000000-old\.md/);
    assert.ok(fs.existsSync(path.join(dir, '20260101-000000-old.md')));
    const r = run(inst, ['journal', 'prune']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 archived, 0 skipped/);
    assert.ok(fs.existsSync(path.join(inst.vault, 'journal', '_archive', 'agent-p', '2026', '20260101-000000-old.md')));
    assert.ok(fs.existsSync(path.join(dir, '20260101-000001-live.md')));
    assert.ok(!fs.existsSync(path.join(dir, '20260101-000000-old.md')));
  });
});
