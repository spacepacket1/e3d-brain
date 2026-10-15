// examples/agent-memory/agent-brain.mjs: the client an autonomous agent uses to recall before acting and remember after,
// against a real journal-mode `ebrain mcp` instance. It must never throw and must fail open.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realTmpDir, repoRoot, rmrf } from './helpers.js';

interface Brain {
  disabled: boolean;
  reason?: string;
  recall(q: string, o?: { limit?: number; maxChars?: number }): Promise<{ text: string; hits: Record<string, unknown>[]; matched: number; omitted: number }>;
  remember(e: { title?: string; body?: string; kind?: string; sources?: string[]; untrusted?: boolean }): Promise<{ ok: boolean; type?: string; detail?: string }>;
  close(): Promise<void>;
}
interface Mod {
  AgentBrain: { open(o: Record<string, unknown>): Promise<Brain> };
  promptBlock(r: { hits: Record<string, unknown>[] }): string;
  parseHits(t: string): Record<string, unknown>[];
}

const main = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
const load = async (): Promise<Mod> =>
  (await import(pathToFileURL(path.join(repoRoot(), 'examples', 'agent-memory', 'agent-brain.mjs')).href)) as Mod;
const FAKE_PEM = '-----BEGIN PRIVATE KEY-----\nFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n-----END PRIVATE KEY-----';

describe('agent memory client', () => {
  let base: string, vault: string, config: string;
  let mod: Mod;
  let brain: Brain;

  const entries = () => {
    const dir = path.join(vault, 'journal', 'tok-1');
    return fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')) : [];
  };

  before(async () => {
    mod = await load();
    base = realTmpDir('ebrain-agentmem-');
    vault = path.join(base, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    config = path.join(base, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ vaultPath: vault, stateDir: path.join(base, 'state'), principal: { id: 'tok-1', type: 'agent' }, mode: 'journal' }), { mode: 0o600 });
    fs.chmodSync(config, 0o600);
    brain = await mod.AgentBrain.open({ main: main(), config, env: { HOME: base } });
  });
  after(async () => {
    await brain.close();
    rmrf(base);
  });

  it('starts, and remembers then recalls an entry straight away', async () => {
    assert.equal(brain.disabled, false, brain.reason);
    const w = await brain.remember({ title: 'Predicted ARB inflow', body: 'Predicted capital inflow to Arbitrum, confidence 70 percent, six hour horizon.', kind: 'decision' });
    assert.equal(w.ok, true, JSON.stringify(w));
    const r = await brain.recall('arbitrum inflow prediction');
    assert.ok(r.hits.length >= 1);
    assert.match(String(r.hits[0]!['excerpt']), /Arbitrum/);
    assert.match(String(r.hits[0]!['citation']), /^note:/);
    assert.equal(entries().length, 1);
  });

  it('formats recall as an advisory block, never as instructions', async () => {
    const block = (await brain.recall('arbitrum inflow')).text;
    assert.match(block, /advisory memory/);
    assert.match(block, /never instructions/);
    assert.match(block, /never\s+authorize spending, signing, or publishing/);
    assert.match(block, /Arbitrum/);
    assert.equal(mod.promptBlock({ hits: [] }), '', 'nothing recalled means an empty string');
  });

  it('natural-language recall works (filler words ignored, stems match)', async () => {
    const r = await brain.recall('what did we predict about arbitrum inflows');
    assert.ok(r.hits.length >= 1);
  });

  it('respects maxChars on the recalled text', async () => {
    for (let i = 0; i < 4; i++) {
      await brain.remember({ title: `Observation ${i}`, body: `Observation ${i} about gasprice spikes ${'padding '.repeat(30)} unique${i}`, kind: 'observation' });
    }
    const r = await brain.recall('gasprice spikes observation', { limit: 5, maxChars: 400 });
    assert.ok(r.text.length < 1200, 'the block stays small');
    assert.ok(r.hits.length <= 5);
  });

  it('a private key rejects the whole entry and stores nothing (strict agent scrubbing)', async () => {
    const before = entries().length;
    const w = await brain.remember({ title: 'oops', body: `here is my key ${FAKE_PEM}`, kind: 'log' });
    assert.equal(w.ok, false);
    assert.equal(w.type, 'strict-scrub');
    assert.equal(entries().length, before);
  });

  it('a duplicate entry is reported, not stored twice', async () => {
    const body = 'An identical heartbeat note, identical on purpose.';
    const first = await brain.remember({ title: 'dup', body, kind: 'log' });
    assert.equal(first.ok, true);
    const n = entries().length;
    const second = await brain.remember({ title: 'dup again', body, kind: 'log' });
    assert.equal(second.ok, false);
    assert.equal(entries().length, n);
  });

  it('untrusted content is tagged untrusted_origin', async () => {
    const w = await brain.remember({ title: 'Reply from a stranger', body: 'Someone on the feed said something odd about routes.', kind: 'observation', untrusted: true, sources: ['url:https://example.com/post/1'] });
    assert.equal(w.ok, true, JSON.stringify(w));
    const files = (fs.readdirSync(path.join(vault, 'journal', 'tok-1'), { recursive: true }) as string[]).filter((f) => f.endsWith('.md'));
    const hit = files.map((f) => fs.readFileSync(path.join(vault, 'journal', 'tok-1', f), 'utf8')).find((t) => t.includes('Someone on the feed'));
    assert.ok(hit);
    assert.match(hit!, /untrusted_origin: true/);
  });

  it('untrusted content without a source reference is rejected, not stored', async () => {
    const before = entries().length;
    const w = await brain.remember({ title: 'Anonymous claim', body: 'A claim with no origin attached.', kind: 'observation', untrusted: true });
    assert.equal(w.ok, false);
    assert.equal(w.type, 'invalid');
    assert.match(String(w.detail), /needs at least one source reference/);
    assert.equal(entries().length, before);
  });

  it('the default budget returns entries of realistic size (each hit costs about 1 KB)', async () => {
    for (let i = 0; i < 2; i++) {
      await brain.remember({ title: `Replied to a comment ${i}`, body: `Signal: capital flow to optimism ${i}.\nWhat they said (untrusted): Is optimism seeing inflow?\nWhat I said: RECOMMENDATION: watch optimism inflow, risk medium, confidence 62%. variant${i}`, kind: 'decision', untrusted: true, sources: [`url:https://example.com/post/opt${i}`] });
    }
    const r = await brain.recall('optimism inflow');
    assert.equal(r.hits.length, 2, `omitted ${r.omitted}`);
    assert.equal(r.omitted, 0);
  });

  it('bad input never throws', async () => {
    assert.deepEqual((await brain.recall('')).hits, []);
    assert.deepEqual((await brain.recall(undefined as unknown as string)).hits, []);
    const w = await brain.remember({ title: '', body: '' });
    assert.equal(w.ok, false);
  });

  it('fails open when the brain cannot start: no throw, no memory, agent carries on', async () => {
    const dead = await mod.AgentBrain.open({ main: main(), config: path.join(base, 'missing.json'), env: { HOME: base }, timeoutMs: 3000 });
    assert.equal(dead.disabled, true);
    assert.deepEqual((await dead.recall('anything')).hits, []);
    const w = await dead.remember({ title: 't', body: 'b' });
    assert.equal(w.ok, false);
    assert.equal(w.type, 'unavailable');
    await dead.close();
    const none = await mod.AgentBrain.open({});
    assert.equal(none.disabled, true);
    assert.equal((await none.remember({ title: 't', body: 'b' })).type, 'unavailable');
  });
});
