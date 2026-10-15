// Cognition Phase 8: `report_use`, the usage and query logs, the `note_usage`
// rollup, the bounded ranking nudge, and the `gaps` job. Covered: report_use in
// every mode (accepted, state-dir only, vault checksum unchanged, 0600, labeled
// self_reported) and its refusals (unknown or foreign recall, ids outside the
// recall, oversized batch, repeated ids, malformed or secret-bearing
// outcome_ref, rate and size limits); repeats ignored; rollups rebuilt
// identically; evidence-linked counting rules; `rank.usageBoost` (off: no
// effect; on: evidence-linked only, at most one place, self-reported never);
// the opt-in query log (off: no file; on: scrubbed, credentials not logged,
// retention prune); `gaps` clustering and proposals; forget's use of usage.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCognition } from '../src/cli/cognition-commands.js';
import { runQueries, runIds } from '../src/cli/undo-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { clusterQueries, clusterHash, queryTokens, rankGaps } from '../src/cognition/jobs/gaps.js';
import { analyzeForget } from '../src/cognition/jobs/forget.js';
import { ConfigError, parseConfig, type Config } from '../src/config.js';
import { memoryEvidenceSource } from '../src/evidence/source.js';
import { allNoteRows } from '../src/index/query.js';
import { closeIndex, openIndex, refreshIndex } from '../src/index/indexer.js';
import { rank, type RankItem } from '../src/index/rank.js';
import { dispatch } from '../src/mcp/dispatch.js';
import { createMcpRuntime } from '../src/mcp/server.js';
import { pruneQueries, readQueries, scrubQuery, type QueryRecord } from '../src/recall/queries.js';
import { MAX_USAGE_FILE_BYTES, readUsage, recordUsage, UsageError, USAGE_RATE_LIMIT } from '../src/recall/usage.js';
import { computeNoteUsage, rebuildNoteUsage, readNoteUsage, usageNetByNote } from '../src/recall/usage-rollup.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { mode as fileMode, realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';
import { fake } from './scrub-fixtures.js';
import { TOOL_MODES, type ToolMode } from './tool-registry.js';

const bases: string[] = [];
after(() => {
  for (const b of bases) rmrf(b);
});

const NOW = new Date('2026-10-14T12:00:00Z');

interface Inst {
  vault: string;
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  config: Config;
}

function setup(opts: { mode?: ToolMode; extra?: Record<string, unknown> } = {}): Inst {
  const base = realTmpDir('ebrain-cog8-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const mode = opts.mode ?? 'inbox';
  const raw: Record<string, unknown> = {
    vaultPath: vault, stateDir, principal: { id: 'tester', type: mode === 'journal' ? 'agent' : 'human' }, mode,
    inbox: { maxPendingProposals: 200 }, cognition: { maxProposalsPerRun: 200 }, ...opts.extra,
  };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  return { vault, stateDir, configPath, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '' }, config: parseConfig(raw) };
}

function note(inst: Inst, rel: string, title: string, body: string, extra = ''): void {
  const abs = path.join(inst.vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\ntitle: ${title}\ncreated: 2026-01-01\n${extra}---\n${body}\n`);
}

function assignIds(inst: Inst): void {
  const r = runIds(['assign'], { env: inst.env, now: () => NOW });
  assert.equal(r.code, 0, r.stderr);
}

function noteIds(inst: Inst): Map<string, string> {
  const h = openIndex({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) });
  try {
    refreshIndex(h);
    return new Map(allNoteRows(h.db).map((r) => [r.path, r.id]));
  } finally {
    closeIndex(h);
  }
}

async function searchOnce(inst: Inst, query: string, mode: ToolMode = inst.config.mode): Promise<{ recallId: string; text: string }> {
  const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
  try {
    const r = await dispatch(rt.ctx, 'search', { query });
    assert.equal(r.isError, undefined, mode);
    const text = r.content[0]!.text;
    return { recallId: /"recall_id":"([A-Za-z0-9_]+)"/.exec(text)![1]!, text };
  } finally {
    rt.close();
  }
}

function recallsFile(inst: Inst, lines: { id: string; principal?: string; ts?: string; ids: string[] }[]): void {
  const text = lines.map((l) => JSON.stringify({ recall_id: l.id, ts: l.ts ?? '2026-10-14T10:00:00.000Z', principal: l.principal ?? 'tester', ids: l.ids.map((id) => ({ id, rev: 'abc' })) })).join('\n');
  fs.writeFileSync(path.join(inst.stateDir, 'recalls.jsonl'), `${text}\n`, { mode: 0o600 });
}

const sp = (inst: Inst) => ensurePrivateDir(inst.stateDir);

// ---- report_use ----

describe('report_use over MCP', () => {
  for (const mode of TOOL_MODES) {
    it(`mode ${mode}: accepts a valid report, writes only the state directory (0600), labels it self_reported`, async () => {
      const inst = setup({ mode });
      note(inst, 'notes/a.md', 'Alpha', 'zebra stripes are unique');
      note(inst, 'notes/b.md', 'Beta', 'zebra herds migrate');
      assignIds(inst);
      const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
      try {
        const s = await dispatch(rt.ctx, 'search', { query: 'zebra' });
        const recallId = /"recall_id":"([A-Za-z0-9_]+)"/.exec(s.content[0]!.text)![1]!;
        const ids = noteIds(inst);
        const before = treeChecksum(inst.vault);
        const r = await dispatch(rt.ctx, 'report_use', { recall_id: recallId, note_ids: [ids.get('notes/a.md')!], helpful: true });
        assert.equal(r.isError, undefined, JSON.stringify(r));
        assert.match(r.content[0]!.text, /"recorded":1/);
        assert.match(r.content[0]!.text, /self_reported/);
        assert.equal(treeChecksum(inst.vault), before, 'the vault is untouched');
        const file = path.join(inst.stateDir, 'usage.jsonl');
        assert.equal(fileMode(file), 0o600);
        const events = readUsage(sp(inst));
        assert.equal(events.length, 1);
        assert.equal(events[0]!.label, 'self_reported');
        assert.equal(events[0]!.principal, 'tester');
        assert.equal(events[0]!.note_id, ids.get('notes/a.md'));
        // A second report of the same pair is ignored, not an error.
        const again = await dispatch(rt.ctx, 'report_use', { recall_id: recallId, note_ids: [ids.get('notes/a.md')!], helpful: false });
        assert.equal(again.isError, undefined);
        assert.match(again.content[0]!.text, /"recorded":0,"ignored_duplicates":1/);
        assert.equal(readUsage(sp(inst)).length, 1);
        assert.equal(readUsage(sp(inst))[0]!.helpful, true, 'first report wins');
        assert.equal(treeChecksum(inst.vault), before);
      } finally {
        rt.close();
      }
    });
  }

  it('rejects an unknown recall_id, another principal\'s recall, ids not in the recall, oversized and repeated batches, bad outcome_refs', async () => {
    const inst = setup();
    note(inst, 'notes/a.md', 'Alpha', 'body');
    assignIds(inst);
    const [idA] = [...noteIds(inst).values()];
    recallsFile(inst, [{ id: 'r_mine', ids: [idA!] }, { id: 'r_theirs', principal: 'someone_else', ids: [idA!] }]);
    const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
    try {
      const bad: Record<string, unknown>[] = [
        { recall_id: 'r_unknown', note_ids: [idA] },
        { recall_id: 'r_theirs', note_ids: [idA] },
        { recall_id: 'r_mine', note_ids: ['not_in_that_recall'] },
        { recall_id: 'r_mine', note_ids: Array.from({ length: 26 }, (_, i) => `n${i}`) },
        { recall_id: 'r_mine', note_ids: [idA, idA] },
        { recall_id: 'r_mine', outcome_ref: 'not a citation' },
        { recall_id: 'r_mine', outcome_ref: 'outcome:' },
        { recall_id: 'r_mine', outcome_ref: `url:https://example.com/?k=${fake.openai()}` },
        { recall_id: 'r_mine', note_ids: [idA], extra: 1 },
        { recall_id: 'bad id with spaces' },
        { note_ids: [idA] },
      ];
      for (const args of bad) {
        const r = await dispatch(rt.ctx, 'report_use', args);
        assert.equal(r.isError, true, JSON.stringify(args).slice(0, 80));
      }
      assert.ok(!fs.existsSync(path.join(inst.stateDir, 'usage.jsonl')), 'nothing was recorded');
      const ok = await dispatch(rt.ctx, 'report_use', { recall_id: 'r_mine', note_ids: [idA], outcome_ref: 'outcome:oc_1' });
      assert.equal(ok.isError, undefined);
      // Neither the id nor a secret reaches the audit log through a refused call.
      const audit = fs.readdirSync(inst.stateDir).filter((n) => n.startsWith('audit')).map((n) => fs.readFileSync(path.join(inst.stateDir, n), 'utf8')).join('');
      assert.ok(audit.includes('report_use'));
      assert.ok(!audit.includes('sk-'));
    } finally {
      rt.close();
    }
  });
});

describe('recordUsage limits', () => {
  it('rate limits per principal and caps the file size', () => {
    const inst = setup();
    const recalls = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, ids: Array.from({ length: 25 }, (_, k) => `n${i}_${k}`) }));
    recallsFile(inst, recalls);
    const at = () => NOW;
    let n = 0;
    for (let i = 0; i < 4; i++) n += recordUsage(sp(inst), 'tester', { recall_id: `r${i}`, note_ids: recalls[i]!.ids }, { now: at }).recorded;
    assert.equal(n, USAGE_RATE_LIMIT);
    assert.throws(() => recordUsage(sp(inst), 'tester', { recall_id: 'r4', note_ids: recalls[4]!.ids.slice(0, 1) }, { now: at }), (e: unknown) => e instanceof UsageError && e.type === 'limit' && e.code === 'rate');
    // A minute later the window has passed.
    const later = () => new Date(NOW.getTime() + 61_000);
    assert.equal(recordUsage(sp(inst), 'tester', { recall_id: 'r4', note_ids: recalls[4]!.ids.slice(0, 1) }, { now: later }).recorded, 1);

    const full = setup();
    recallsFile(full, [{ id: 'r', ids: ['n1'] }]);
    fs.writeFileSync(path.join(full.stateDir, 'usage.jsonl'), `${'x'.repeat(MAX_USAGE_FILE_BYTES)}\n`, { mode: 0o600 });
    assert.throws(() => recordUsage(sp(full), 'tester', { recall_id: 'r', note_ids: ['n1'] }), (e: unknown) => e instanceof UsageError && e.code === 'usage-log-full');
  });

  it('a report without note_ids is one recall-level event that no note rollup counts', () => {
    const inst = setup();
    recallsFile(inst, [{ id: 'r', ids: ['n1', 'n2'] }]);
    assert.equal(recordUsage(sp(inst), 'tester', { recall_id: 'r', helpful: true }).recorded, 1);
    assert.equal(recordUsage(sp(inst), 'tester', { recall_id: 'r' }).recorded, 0);
    assert.deepEqual(computeNoteUsage(sp(inst)).map((r) => r.reported_used), [0, 0]);
  });
});

// ---- rollups ----

const T0 = '2026-10-14T10:00:00.000Z';
const evidence = memoryEvidenceSource([
  { kind: 'outcome', id: 'oc_good', occurred: '2026-10-15T00:00:00.000Z', summary: 'won', attributes: { result: 'good' } },
  { kind: 'outcome', id: 'oc_bad', occurred: '2026-10-15T00:00:00.000Z', summary: 'lost', attributes: { success: false } },
  { kind: 'outcome', id: 'oc_early', occurred: '2026-10-01T00:00:00.000Z', summary: 'before the recall', attributes: { result: 'good' } },
  { kind: 'outcome', id: 'oc_plain', occurred: '2026-10-15T00:00:00.000Z', summary: 'no verdict', attributes: {} },
]);

function usageFixture(): Inst {
  const inst = setup();
  recallsFile(inst, [
    { id: 'r1', ts: T0, ids: ['n1', 'n2', 'n3'] },
    { id: 'r2', ts: T0, ids: ['n1', 'n2'] },
  ]);
  const report = (recall_id: string, note_ids: string[], extra: { outcome_ref?: string; helpful?: boolean } = {}) =>
    recordUsage(sp(inst), 'tester', { recall_id, note_ids, ...extra }, { now: () => NOW });
  report('r1', ['n1'], { outcome_ref: 'outcome:oc_good' });
  report('r1', ['n2'], { outcome_ref: 'outcome:oc_bad' });
  report('r1', ['n3'], { outcome_ref: 'outcome:oc_early' });
  report('r2', ['n1'], { outcome_ref: 'outcome:oc_missing' });
  report('r2', ['n2'], { outcome_ref: 'outcome:oc_plain', helpful: false });
  return inst;
}

describe('note_usage rollup', () => {
  it('counts recalls, self-reported use, and only evidence-linked outcomes that resolve, follow the recall, and carry a verdict', () => {
    const inst = usageFixture();
    const rows = computeNoteUsage(sp(inst), evidence);
    assert.deepEqual(rows, [
      { id: 'n1', recalls: 2, reported_used: 2, evidence_linked_good: 1, evidence_linked_bad: 0 },
      { id: 'n2', recalls: 2, reported_used: 1, evidence_linked_good: 0, evidence_linked_bad: 1 },
      { id: 'n3', recalls: 1, reported_used: 1, evidence_linked_good: 0, evidence_linked_bad: 0 },
    ]);
    // Without an evidence source nothing is evidence-linked; self-reported counts are unchanged.
    const bare = computeNoteUsage(sp(inst));
    assert.deepEqual(bare.map((r) => [r.reported_used, r.evidence_linked_good, r.evidence_linked_bad]), [[2, 0, 0], [1, 0, 0], [1, 0, 0]]);
  });

  it('is derived: dropping the table and rebuilding gives identical rows, in a fresh index too', () => {
    const inst = usageFixture();
    const h = openIndex({ vaultPath: inst.vault, stateDir: sp(inst) });
    try {
      const first = rebuildNoteUsage(h.db, sp(inst), evidence);
      const stored = readNoteUsage(h.db);
      assert.deepEqual(stored, first);
      h.db.exec('DROP TABLE note_usage');
      assert.deepEqual(readNoteUsage(h.db), []);
      assert.deepEqual(rebuildNoteUsage(h.db, sp(inst), evidence), first);
      assert.deepEqual(readNoteUsage(h.db), stored);
      assert.deepEqual([...usageNetByNote(h.db)], [['n1', 1], ['n2', -1]]);
    } finally {
      closeIndex(h);
    }
  });

  it('self-reported events alone never produce a net', () => {
    const inst = setup();
    recallsFile(inst, [{ id: 'r1', ts: T0, ids: ['n1'] }]);
    recordUsage(sp(inst), 'tester', { recall_id: 'r1', note_ids: ['n1'], helpful: true });
    const h = openIndex({ vaultPath: inst.vault, stateDir: sp(inst) });
    try {
      rebuildNoteUsage(h.db, sp(inst), evidence);
      assert.equal(usageNetByNote(h.db).size, 0);
      assert.equal(readNoteUsage(h.db)[0]!.reported_used, 1);
    } finally {
      closeIndex(h);
    }
  });

  it('`cognition stats usage` prints the rollup and writes nothing to the vault', async () => {
    const inst = usageFixture();
    fs.mkdirSync(path.join(inst.stateDir, 'evidence'));
    fs.writeFileSync(
      path.join(inst.stateDir, 'evidence', 'e.jsonl'),
      `${JSON.stringify({ kind: 'outcome', id: 'oc_good', occurred: '2026-10-15T00:00:00Z', summary: 'won', attributes: { result: 'good' } })}\n`,
    );
    const before = treeChecksum(inst.vault);
    const r = await runCognition(['stats', 'usage'], { env: inst.env, now: () => NOW });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /3 notes recalled or reported/);
    assert.match(r.stdout, /5 recalls, 4 reported used \(self-reported\), 1 evidence-linked good, 0 evidence-linked bad/);
    assert.match(r.stdout, /rank\.usageBoost is off/);
    assert.match(r.stdout, /n1: recalls 2; reported used 2 \(self-reported\); evidence-linked 1 good, 0 bad/);
    assert.equal(treeChecksum(inst.vault), before);
    assert.equal((await runCognition(['stats', 'nope'], { env: inst.env })).code, 2);
  });
});

// ---- ranking ----

const item = (p: string, usageNet?: number): RankItem => ({ path: p, folderClass: 'curated', ...(usageNet === undefined ? {} : { usageNet }) });
const order = (items: RankItem[], boost: boolean): string[] => rank(items, boost ? { usageBoost: true } : {}).map((r) => r.item.path);

describe('rank.usageBoost', () => {
  it('is ignored when off, whatever the counters say', () => {
    const items = [item('a'), item('b'), item('c'), item('d', 50)];
    assert.deepEqual(order(items, false), ['a', 'b', 'c', 'd']);
  });

  it('moves a positive item one place up and a negative one place down, within its tier only', () => {
    assert.deepEqual(order([item('a'), item('b'), item('c'), item('d', 50)], true), ['a', 'b', 'd', 'c']);
    assert.deepEqual(order([item('a', -3), item('b'), item('c')], true), ['b', 'a', 'c']);
    // The magnitude is capped: a huge count moves one place, like a small one.
    assert.deepEqual(order([item('a'), item('b'), item('c', 1_000_000)], true), ['a', 'c', 'b']);
    // Never across a tier boundary.
    const stale: RankItem = { path: 'z', folderClass: 'curated', status: 'stale', usageNet: 9 };
    assert.deepEqual(rank([item('a'), stale], { usageBoost: true }).map((r) => r.item.path), ['a', 'z']);
    // No item moves more than one place, however many are boosted.
    const many = Array.from({ length: 8 }, (_, i) => item(`p${i}`, i % 2 === 0 ? 1 : -1));
    const base = order(many, false);
    const boosted = order(many, true);
    for (const p of base) assert.ok(Math.abs(base.indexOf(p) - boosted.indexOf(p)) <= 1, p);
  });

  it('search: evidence-linked counters change the order within the cap; self-reported events never do', async () => {
    const mk = (boost: boolean): Inst => {
      const inst = setup({ extra: { rank: { usageBoost: boost } } });
      for (const n of ['a', 'b', 'c', 'd']) note(inst, `notes/${n}.md`, `Note ${n}`, 'identical ranking text about quokkas');
      assignIds(inst);
      return inst;
    };
    const paths = (text: string): string[] => [...text.matchAll(/notes\/([a-d])\.md/g)].map((m) => m[1]!).filter((p, i, all) => all.indexOf(p) === i);
    const off = mk(false);
    const baseOrder = paths((await searchOnce(off, 'quokkas')).text);
    assert.equal(baseOrder.length, 4);
    const target = baseOrder[3]!;

    const run = async (inst: Inst, withEvidence: boolean): Promise<string[]> => {
      const ids = noteIds(inst);
      const id = ids.get(`notes/${target}.md`)!;
      recallsFile(inst, [{ id: 'r_hist', ts: T0, ids: [id] }]);
      recordUsage(sp(inst), 'tester', { recall_id: 'r_hist', note_ids: [id], helpful: true, outcome_ref: 'outcome:oc_good' }, { now: () => NOW });
      const h = openIndex({ vaultPath: inst.vault, stateDir: sp(inst) });
      try {
        rebuildNoteUsage(h.db, sp(inst), withEvidence ? evidence : undefined);
      } finally {
        closeIndex(h);
      }
      return paths((await searchOnce(inst, 'quokkas')).text);
    };
    const boosted = mk(true);
    const selfOnly = await run(boosted, false);
    assert.deepEqual(selfOnly, baseOrder, 'self-reported events never change the order, even with usageBoost on');
    const linked = await run(boosted, true);
    assert.equal(linked.indexOf(target), 2, 'one place up, no further');
    assert.deepEqual(linked.filter((p) => p !== target), baseOrder.filter((p) => p !== target));
    // The same counters with the option off change nothing.
    const offLinked = await run(off, true);
    assert.deepEqual(offLinked, baseOrder);
  });
});

// ---- query log ----

describe('query log', () => {
  it('is off by default: no queries file exists after a session', async () => {
    const inst = setup();
    note(inst, 'notes/a.md', 'Alpha', 'giraffe necks');
    await searchOnce(inst, 'giraffe');
    assert.ok(!fs.existsSync(path.join(inst.stateDir, 'queries.jsonl')));
  });

  it('when on, logs scrubbed query text, recall_id, result count, and top tier; credentials are not logged', async () => {
    const inst = setup({ extra: { queryLog: { enabled: true } } });
    note(inst, 'notes/a.md', 'Alpha', 'giraffe necks are long');
    const hit = await searchOnce(inst, 'giraffe necks');
    await searchOnce(inst, 'nothingmatches here');
    await searchOnce(inst, `how do I use ${fake.openai()}`);
    await searchOnce(inst, `${fake.anthropic()}`);
    const file = path.join(inst.stateDir, 'queries.jsonl');
    assert.equal(fileMode(file), 0o600);
    const records = readQueries(sp(inst));
    assert.equal(records.length, 2, 'queries with credentials are not logged');
    assert.deepEqual(records.map((r) => r.query), ['giraffe necks', 'nothingmatches here']);
    assert.equal(records[0]!.recall_id, hit.recallId);
    assert.equal(records[0]!.results, 1);
    assert.equal(records[0]!.top_tier, 1);
    assert.equal(records[1]!.results, 0);
    assert.equal(records[1]!.top_tier, null);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-'));
  });

  it('scrubQuery: strict rules, redaction, length cap', () => {
    assert.equal(scrubQuery(`use ${fake.github()} now`), undefined);
    assert.equal(scrubQuery('   '), undefined);
    assert.equal(scrubQuery('  plain   words '), 'plain words');
    assert.ok(scrubQuery('quokka '.repeat(200))!.length <= 300);
  });

  it('prune drops records past retention (CLI default and --older-than)', async () => {
    const inst = setup({ extra: { queryLog: { enabled: true, retentionDays: 30 } } });
    const rec = (days: number, q: string): string =>
      JSON.stringify({ ts: new Date(NOW.getTime() - days * 86_400_000).toISOString(), recall_id: 'r', principal: 'tester', query: q, results: 1, top_tier: 1 });
    fs.writeFileSync(path.join(inst.stateDir, 'queries.jsonl'), `${[rec(60, 'old'), rec(31, 'older'), rec(5, 'recent'), 'not json'].join('\n')}\n`, { mode: 0o600 });
    const r = runQueries(['prune'], { env: inst.env, now: () => NOW });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /kept 1, removed 3 \(older than 30 days\)/);
    assert.deepEqual(readQueries(sp(inst)).map((x) => x.query), ['recent']);
    assert.deepEqual(pruneQueries(sp(inst), 1, NOW), { kept: 0, removed: 1 });
    assert.equal(runQueries(['prune', '--older-than', '0'], { env: inst.env }).code, 2);
    assert.equal(runQueries(['nope'], { env: inst.env }).code, 2);
  });
});

// ---- gaps ----

const q = (query: string, results: number, tier: number | null, minutes = 0): QueryRecord => ({
  ts: new Date(NOW.getTime() - minutes * 60_000).toISOString(), recall_id: `r${minutes}`, principal: 'tester', query, results, top_tier: tier,
});

const LOG: QueryRecord[] = [
  q('pricing latency tokens', 0, null, 1),
  q('latency tokens pricing', 0, null, 2),
  q('what is the pricing latency of tokens', 0, null, 3),
  q('pricing latency tokens', 2, 6, 4),
  q('deploy rollback steps', 3, 1, 5),
  q('deploy rollback steps', 3, 1, 6),
  q('deploy rollback steps', 1, 1, 7),
  q('kafka consumer lag', 0, null, 8),
  q('kafka consumer lag', 0, null, 9),
  q('onetime question', 0, null, 10),
  q('the of and', 0, null, 11),
];

describe('gaps clustering', () => {
  it('tokens are sorted, deduplicated, and stop-listed; the cluster hash is the SHA-256 of the sorted set', () => {
    assert.deepEqual(queryTokens('What is the Latency of tokens, pricing?'), ['latency', 'pricing', 'tokens']);
    assert.equal(clusterHash(['a', 'b']), clusterHash(['a', 'b']));
    assert.notEqual(clusterHash(['a', 'b']), clusterHash(['a', 'c']));
  });

  it('groups word-order and filler variants, ranks by frequency then poor-result rate, and is independent of log order', () => {
    const { clusters, empty } = clusterQueries(LOG, 0.5);
    assert.equal(empty, 1);
    const ranked = rankGaps(clusters, 2, 0.5);
    assert.deepEqual(ranked.map((c) => [c.tokens.join(' '), c.queries, c.poor, c.bestTier, c.maxResults]), [
      ['latency pricing tokens', 4, 4, 6, 2],
      ['consumer kafka lag', 2, 2, null, 0],
    ]);
    // `deploy rollback steps` was asked 3 times but found; `onetime question` is below the minimum.
    const reversed = rankGaps(clusterQueries([...LOG].reverse(), 0.5).clusters, 2, 0.5);
    assert.deepEqual(reversed.map((c) => c.hash), ranked.map((c) => c.hash));
  });
});

const GAPS_CFG = { cognition: { maxProposalsPerRun: 200, gaps: { minQueries: 2 } } };

describe('gaps job', () => {
  const cog = (inst: Inst, args: string[]) => runCognition(args, { env: inst.env, now: () => NOW });
  const proposals = (inst: Inst): { fm: Record<string, unknown>; text: string }[] => {
    const dir = path.join(inst.vault, '_inbox');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => {
      const text = fs.readFileSync(path.join(dir, n), 'utf8');
      return { text, fm: parseYaml(splitFrontmatter(text).yaml ?? '') as Record<string, unknown> };
    });
  };

  it('files gap proposals citing counts: no targets, no evidence, no change; re-runs create none; works in every mode', async () => {
    for (const mode of TOOL_MODES) {
      const inst = setup({ mode, extra: GAPS_CFG });
      fs.writeFileSync(path.join(inst.stateDir, 'queries.jsonl'), `${LOG.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
      const before = treeChecksum(inst.vault);
      const r = await cog(inst, ['run', 'gaps']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /proposals: 2 created/);
      assert.match(r.stdout, /gaps: 11 logged queries/);
      const found = proposals(inst);
      assert.equal(found.length, 2);
      for (const p of found) {
        assert.equal(p.fm['proposal_type'], 'gap');
        assert.deepEqual(p.fm['targets'], []);
        assert.deepEqual(p.fm['evidence'], []);
        assert.match(String(p.fm['proposal_key']), /^pk_[0-9a-f]{32}$/);
      }
      const top = found.find((p) => String(p.fm['title']).includes('latency'))!;
      assert.match(top.text, /Asked 4 times, best result tier T6, 2 results\./);
      assert.match(top.text, /4 of 4 queries returned nothing or only tier 6 or lower/);
      assert.match(top.text, /- pricing latency tokens/);
      const kafka = found.find((p) => String(p.fm['title']).includes('kafka'))!;
      assert.match(kafka.text, /Asked 2 times, best result tier none/);
      assert.ok(!found.some((p) => String(p.fm['title']).includes('deploy')));
      assert.notEqual(treeChecksum(inst.vault), before);
      const again = await cog(inst, ['run', 'gaps']);
      assert.match(again.stdout, /proposals: 0 created, 2 already in _inbox\//);
      // Accepting a gap changes nothing but files it.
      const id = String(top.fm['id']);
      const acc = runReview(['accept', id], { env: inst.env, now: () => NOW });
      assert.equal(acc.code, 0, acc.stderr);
    }
  });

  it('the proposal key is the hash of (job, cluster hash, type), and --since limits the log read', async () => {
    const inst = setup({ extra: GAPS_CFG });
    fs.writeFileSync(path.join(inst.stateDir, 'queries.jsonl'), `${LOG.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
    const { proposalKey } = await import('../src/review/proposal.js');
    const { clusters } = clusterQueries(LOG, 0.5);
    const kafka = clusters.find((c) => c.tokens.includes('kafka'))!;
    await cog(inst, ['run', 'gaps']);
    const keys = proposals(inst).map((p) => p.fm['proposal_key']);
    assert.ok(keys.includes(proposalKey('gaps', 'gap', [kafka.hash])));
    const none = setup();
    fs.writeFileSync(path.join(none.stateDir, 'queries.jsonl'), `${LOG.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
    const r = await cog(none, ['run', 'gaps', '--since', '2026-10-15']);
    assert.match(r.stdout, /proposals: 0 created/);
  });

  it('with no query log it reports zero clusters and creates nothing', async () => {
    const inst = setup();
    const r = await cog(inst, ['run', 'gaps']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /gaps: 0 logged queries/);
    assert.deepEqual(proposals(inst), []);
  });
});

// ---- forget ----

describe('forget consults usage', () => {
  it('skips a note with a good evidence-linked outcome, shows self-reported use but does not gate on it', () => {
    const inst = setup();
    note(inst, 'notes/useful.md', 'Useful', 'useful body');
    note(inst, 'notes/claimed.md', 'Claimed', 'claimed body');
    note(inst, 'notes/quiet.md', 'Quiet', 'quiet body');
    assignIds(inst);
    // Assigning ids rewrites the files, so age them afterwards.
    for (const n of ['useful', 'claimed', 'quiet']) fs.utimesSync(path.join(inst.vault, 'notes', `${n}.md`), new Date('2026-01-01'), new Date('2026-01-01'));
    const ids = noteIds(inst);
    const other = 'someother';
    recallsFile(inst, [{ id: 'r_old', ts: '2026-01-02T00:00:00.000Z', ids: [other] }, { id: 'r_use', ts: '2026-02-01T00:00:00.000Z', ids: [ids.get('notes/useful.md')!, ids.get('notes/claimed.md')!] }]);
    const report = (note_id: string, outcome_ref?: string) =>
      recordUsage(sp(inst), 'tester', { recall_id: 'r_use', note_ids: [note_id], ...(outcome_ref === undefined ? {} : { outcome_ref }) }, { now: () => NOW });
    report(ids.get('notes/useful.md')!, 'outcome:oc_good');
    report(ids.get('notes/claimed.md')!);
    const h = openIndex({ vaultPath: inst.vault, stateDir: sp(inst) });
    try {
      refreshIndex(h);
      const a = analyzeForget({ config: inst.config, index: h, stateDir: sp(inst), now: NOW, evidence });
      const names = a.candidates.map((c) => c.row.path).sort();
      assert.deepEqual(names, ['notes/claimed.md', 'notes/quiet.md']);
      assert.equal(a.counts['skipped_evidence_useful'], 1);
      const claimed = a.candidates.find((c) => c.row.path === 'notes/claimed.md')!;
      assert.equal(claimed.signals.reportedUsed, 1);
      assert.equal(claimed.signals.evidenceGood, 0);
      // Without evidence nothing is evidence-linked, so the note is a candidate again.
      const without = analyzeForget({ config: inst.config, index: h, stateDir: sp(inst), now: NOW });
      assert.equal(without.candidates.length, 3);
    } finally {
      closeIndex(h);
    }
  });
});

// ---- config and scans ----

describe('config and scans', () => {
  const base = { vaultPath: '/tmp/v', stateDir: '/tmp/s', principal: { id: 'p', type: 'human' }, mode: 'inbox' };
  it('defaults: queryLog off with 30 days, rank.usageBoost off, gaps thresholds', () => {
    const c = parseConfig(base);
    assert.deepEqual(c.queryLog, { enabled: false, retentionDays: 30 });
    assert.deepEqual(c.rank, { usageBoost: false });
    assert.deepEqual(c.cognition.gaps, { minQueries: 3, minPoorRate: 0.5, minSimilarity: 0.5 });
  });

  it('rejects bad values and unknown keys', () => {
    for (const extra of [
      { queryLog: { enabled: 'yes' } }, { queryLog: { retentionDays: 0 } }, { queryLog: { retentionDays: 1.5 } }, { queryLog: { x: 1 } },
      { rank: { usageBoost: 1 } }, { rank: { cap: 3 } }, { cognition: { gaps: { minQueries: 0 } } }, { cognition: { gaps: { minPoorRate: 2 } } },
      { cognition: { gaps: { minSimilarity: 0 } } }, { cognition: { gaps: { bogus: 1 } } },
    ]) assert.throws(() => parseConfig({ ...base, ...extra }), ConfigError, JSON.stringify(extra));
    const ok = parseConfig({ ...base, queryLog: { enabled: true, retentionDays: 7 }, rank: { usageBoost: true } });
    assert.equal(ok.queryLog.enabled, true);
    assert.equal(ok.rank.usageBoost, true);
  });

  it('src/mcp reaches the logs only through src/recall, and report_use is not a job tool', () => {
    const tools = fs.readFileSync(path.join(repoRoot(), 'src/mcp/usage-tools.ts'), 'utf8');
    assert.match(tools, /from '\.\.\/recall\/usage\.js'/);
    assert.ok(!/cognition/.test(tools.replace(/\/\/.*$/gm, '')));
    const mcpFiles = fs.readdirSync(path.join(repoRoot(), 'src/mcp')).map((f) => fs.readFileSync(path.join(repoRoot(), 'src/mcp', f), 'utf8'));
    for (const t of mcpFiles) assert.ok(!/(appendSafe|writeAtomic|createExclusive)\(/.test(t));
  });
});
