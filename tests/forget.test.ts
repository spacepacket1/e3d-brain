// Cognition Phase 7: the `forget` job. Covered: candidates from a fixture of
// varying age, recall, citation, pin, and kind (only the intended notes are
// proposed, in oldest-last-recall-first order); the recall-history gate;
// the demote -> archive ladder; accepting `archive` per C10 and undoing it at
// the original path, with search hiding the archived note; `note_stats`
// rebuilt identically from `recalls.jsonl` after the table is dropped;
// `journal.pruneRequiresReview` (default: the old direct archive; true:
// archive proposals, nothing moved until accepted); `cognition stats forget`;
// idempotence; config validation.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCognition } from '../src/cli/cognition-commands.js';
import { runJournal } from '../src/cli/journal-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { runIds } from '../src/cli/undo-commands.js';
import { listRunRecords } from '../src/cognition/runs.js';
import { ConfigError, parseConfig, type Config } from '../src/config.js';
import { allNoteRows } from '../src/index/query.js';
import { closeIndex, openIndex, refreshIndex } from '../src/index/indexer.js';
import { dispatch } from '../src/mcp/dispatch.js';
import { createMcpRuntime } from '../src/mcp/server.js';
import { rebuildNoteStats } from '../src/recall/stats.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { realTmpDir, rmrf } from './helpers.js';

const bases: string[] = [];
after(() => {
  for (const b of bases) rmrf(b);
});

const NOW = new Date('2026-10-14T12:00:00Z');
const OLD = new Date('2026-01-01T00:00:00Z');

interface Inst {
  vault: string;
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  config: Config;
}

function setup(extra: Record<string, unknown> = {}): Inst {
  const base = realTmpDir('ebrain-cog7-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const raw: Record<string, unknown> = {
    vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox',
    inbox: { maxPendingProposals: 200 }, cognition: { maxProposalsPerRun: 200 }, ...extra,
  };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  return { vault, stateDir, configPath, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '' }, config: parseConfig(raw) };
}

interface NoteSpec {
  title: string;
  created?: string;
  kind?: string;
  pinned?: boolean;
  status?: string;
  sources?: string[];
  expires?: string;
  /** File modified time (default: long ago, so age comes from `created`). */
  mtime?: Date;
}

function note(inst: Inst, rel: string, spec: NoteSpec, body = `${spec.title} body text.\n`): void {
  const fm = [`title: ${spec.title}`, `created: ${spec.created ?? '2026-01-01'}`];
  if (spec.kind !== undefined) fm.push(`kind: ${spec.kind}`);
  if (spec.pinned === true) fm.push('pinned: true');
  if (spec.status !== undefined) fm.push(`status: ${spec.status}`);
  if (spec.expires !== undefined) fm.push(`expires: ${spec.expires}`);
  if (spec.sources !== undefined) fm.push(`sources: [${spec.sources.join(', ')}]`);
  const abs = path.join(inst.vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\n${fm.join('\n')}\n---\n${body}`);
  fs.utimesSync(abs, spec.mtime ?? OLD, spec.mtime ?? OLD);
}

const read = (inst: Inst, rel: string): Buffer => fs.readFileSync(path.join(inst.vault, rel));
const fmOf = (inst: Inst, rel: string): Record<string, unknown> => parseYaml(splitFrontmatter(read(inst, rel).toString('utf8')).yaml ?? '') as Record<string, unknown>;

function ids(inst: Inst): void {
  const r = runIds(['assign'], { env: inst.env, now: () => NOW });
  assert.equal(r.code, 0, r.stderr);
}

/** `{id, rev}` of the note at `rel`. */
function ident(inst: Inst, rel: string): { id: string; rev: string } {
  const h = openIndex({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) });
  try {
    refreshIndex(h);
    const r = allNoteRows(h.db).find((x) => x.path === rel);
    assert.ok(r, `${rel} is indexed`);
    return { id: r.id, rev: r.rev };
  } finally {
    closeIndex(h);
  }
}

function recalls(inst: Inst, lines: { ts: string; ids: string[] }[]): void {
  const text = lines.map((l, i) => JSON.stringify({ recall_id: `r${i}`, ts: l.ts, principal: 'tester', ids: l.ids.map((id) => ({ id, rev: 'abc' })) })).join('\n');
  fs.writeFileSync(path.join(inst.stateDir, 'recalls.jsonl'), `${text}\n`, { mode: 0o600 });
}

let tick = 0;
const cog = (inst: Inst, args: string[]) => {
  const at = new Date(NOW.getTime() + ++tick * 1000);
  return runCognition(args, { env: inst.env, now: () => at });
};
const review = (inst: Inst, args: string[]) => runReview(args, { env: inst.env, now: () => NOW });

interface ProposalFile {
  path: string;
  fm: Record<string, unknown>;
}

function proposals(inst: Inst): ProposalFile[] {
  const abs = path.join(inst.vault, '_inbox');
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => {
    const text = fs.readFileSync(path.join(abs, n), 'utf8');
    return { path: `_inbox/${n}`, fm: parseYaml(splitFrontmatter(text).yaml ?? '') as Record<string, unknown> };
  });
}
const targetPaths = (p: ProposalFile): string[] => (p.fm['targets'] as { path_at_proposal: string }[]).map((t) => t.path_at_proposal);

/**
 * Notes (recall log starts 2026-01-02, so "never recalled" is known for the window):
 *   never.md     old, never recalled            -> demote (first: never recalled)
 *   long-ago.md  last recalled 2026-02-01       -> demote (second)
 *   stale.md     status stale, never recalled   -> archive
 *   recent.md    recalled 2026-10-01            -> skipped
 *   young.md     created 2026-09-20             -> skipped (younger than minAgeDays)
 *   pinned.md, cited.md (cited by hub.md), decision.md, reference.md, superseded.md -> never proposed
 */
function fixture(inst: Inst): Record<string, string> {
  note(inst, 'notes/never.md', { title: 'Never recalled' });
  note(inst, 'notes/long-ago.md', { title: 'Recalled long ago' });
  note(inst, 'notes/stale.md', { title: 'Already stale', status: 'stale' });
  note(inst, 'notes/recent.md', { title: 'Recently recalled' });
  note(inst, 'notes/young.md', { title: 'Young note', created: '2026-09-20', mtime: new Date('2026-09-20T00:00:00Z') });
  note(inst, 'notes/pinned.md', { title: 'Pinned note', pinned: true });
  note(inst, 'notes/cited.md', { title: 'Cited note' });
  note(inst, 'notes/decision.md', { title: 'A decision', kind: 'decision' });
  note(inst, 'notes/reference.md', { title: 'A reference', kind: 'reference' });
  note(inst, 'notes/superseded.md', { title: 'Superseded note', status: 'superseded' });
  ids(inst);
  const c = ident(inst, 'notes/cited.md');
  note(inst, 'notes/hub.md', { title: 'Hub', created: '2026-09-25', mtime: new Date('2026-09-25T00:00:00Z'), status: 'accepted', sources: [`note:${c.id}@${c.rev}`] });
  ids(inst);
  const idOf: Record<string, string> = {};
  for (const n of ['never', 'long-ago', 'stale', 'recent', 'young', 'pinned', 'cited', 'decision', 'reference', 'superseded', 'hub']) idOf[n] = ident(inst, `notes/${n}.md`).id;
  // `ids assign` rewrote the files (touching their modified times): make the old notes old again.
  for (const n of ['never', 'long-ago', 'stale', 'recent', 'pinned', 'cited', 'decision', 'reference', 'superseded']) fs.utimesSync(path.join(inst.vault, `notes/${n}.md`), OLD, OLD);
  for (const [n, d] of [['young', '2026-09-20'], ['hub', '2026-09-25']] as const) fs.utimesSync(path.join(inst.vault, `notes/${n}.md`), new Date(`${d}T00:00:00Z`), new Date(`${d}T00:00:00Z`));
  recalls(inst, [
    { ts: '2026-01-02T00:00:00Z', ids: [idOf['hub']!] },
    { ts: '2026-02-01T00:00:00Z', ids: [idOf['long-ago']!] },
    { ts: '2026-10-01T00:00:00Z', ids: [idOf['recent']!] },
  ]);
  return idOf;
}

async function searchPaths(inst: Inst, query: string): Promise<string[]> {
  const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
  try {
    const r = await dispatch(rt.ctx, 'search', { query });
    assert.notEqual(r.isError, true, r.content[0]!.text);
    const lines = r.content[0]!.text.split('\n');
    const open = lines.findIndex((l) => /^`{3,}text$/.test(l));
    if (open < 0) return [];
    const fence = lines[open]!.slice(0, -4);
    const close = lines.findIndex((l, i) => i > open && l === fence);
    const paths = lines.slice(open + 1, close).map((l) => String((JSON.parse(l) as Record<string, unknown>)['path']));
    return [...new Set(paths.filter((p) => !p.startsWith('_inbox/')))].sort();
  } finally {
    rt.close();
  }
}

describe('forget candidates', () => {
  it('proposes only the intended notes, oldest last recall first; pinned, cited, exempt-kind, young, recent, superseded never', async () => {
    const inst = setup();
    fixture(inst);
    const r = await cog(inst, ['run', 'forget']);
    assert.equal(r.code, 0, r.stderr);
    const ps = proposals(inst);
    const byTarget = new Map(ps.map((p) => [targetPaths(p)[0]!, p.fm['proposal_type']]));
    assert.deepEqual([...byTarget].sort(), [
      ['notes/long-ago.md', 'demote'],
      ['notes/never.md', 'demote'],
      ['notes/stale.md', 'archive'],
    ]);
    const rec = listRunRecords(ensurePrivateDir(inst.stateDir))[0]!;
    assert.equal(rec.counts['skipped_pinned'], 1);
    assert.equal(rec.counts['skipped_exempt_kind'], 2);
    assert.equal(rec.counts['skipped_cited'], 1);
    assert.equal(rec.counts['skipped_recalled'], 1);
    assert.equal(rec.counts['skipped_young'], 2);
    // Priority: never recalled (stale, never; by path), then 2026-02-01.
    const order = rec.proposals.map((p) => ps.find((q) => q.fm['id'] === p.id)!).map((p) => targetPaths(p)[0]);
    assert.deepEqual(order, ['notes/never.md', 'notes/stale.md', 'notes/long-ago.md']);
    // Signal values are in the rationale, not scores.
    const text = fs.readFileSync(path.join(inst.vault, ps.find((p) => targetPaths(p)[0] === 'notes/long-ago.md')!.path), 'utf8');
    assert.match(text, /last recalled 2026-02-01/);
    assert.match(text, /recalls 1/);
    assert.match(text, /age 2\d\d days/);
  });

  it('is idempotent and never changes a note by itself', async () => {
    const inst = setup();
    fixture(inst);
    const before = read(inst, 'notes/never.md');
    await cog(inst, ['run', 'forget']);
    const again = await cog(inst, ['run', 'forget']);
    assert.match(again.stdout, /proposals: 0 created, 3 already in _inbox\//);
    assert.deepEqual(read(inst, 'notes/never.md'), before);
    assert.equal(proposals(inst).length, 3);
  });

  it('never-recalled notes are not candidates without recall history covering the window', async () => {
    const inst = setup();
    fixture(inst);
    fs.rmSync(path.join(inst.stateDir, 'recalls.jsonl'));
    let r = await cog(inst, ['run', 'forget']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(proposals(inst).length, 0);
    assert.equal(listRunRecords(ensurePrivateDir(inst.stateDir))[0]!.counts['skipped_no_history'], 5);
    // A record that starts inside the window is not enough either.
    const idOf = ident(inst, 'notes/hub.md').id;
    recalls(inst, [{ ts: '2026-09-01T00:00:00Z', ids: [idOf] }]);
    r = await cog(inst, ['run', 'forget']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(proposals(inst).length, 0);
  });

  it('honors minAgeDays, windowDays, and exemptKinds', async () => {
    const inst = setup({ cognition: { maxProposalsPerRun: 200, forget: { exemptKinds: ['reference'], windowDays: 30, minAgeDays: 5 } } });
    fixture(inst);
    const r = await cog(inst, ['run', 'forget']);
    assert.equal(r.code, 0, r.stderr);
    const paths = proposals(inst).map((p) => targetPaths(p)[0]).sort();
    // decision.md is no longer exempt; young.md and hub.md are old enough (>= 5 days) and the recall record is 9 months old; recent.md was recalled 13 days ago (inside 30).
    assert.deepEqual(paths, ['notes/decision.md', 'notes/hub.md', 'notes/long-ago.md', 'notes/never.md', 'notes/stale.md', 'notes/young.md']);
  });
});

describe('forget accept and undo', () => {
  it('accepting demote sets status: stale and search still finds the note', async () => {
    const inst = setup();
    fixture(inst);
    await cog(inst, ['run', 'forget']);
    const p = proposals(inst).find((q) => targetPaths(q)[0] === 'notes/never.md')!;
    const acc = review(inst, ['accept', String(p.fm['id'])]);
    assert.equal(acc.code, 0, acc.stderr);
    assert.equal(fmOf(inst, 'notes/never.md')['status'], 'stale');
    assert.ok((await searchPaths(inst, 'Never recalled')).includes('notes/never.md'));
  });

  it('accepting archive applies C10, undo restores the original bytes and path, search hides archived by default', async () => {
    const inst = setup();
    fixture(inst);
    await cog(inst, ['run', 'forget']);
    const p = proposals(inst).find((q) => q.fm['proposal_type'] === 'archive')!;
    const original = read(inst, 'notes/stale.md');
    assert.ok((await searchPaths(inst, 'Already stale')).includes('notes/stale.md'));
    const acc = review(inst, ['accept', String(p.fm['id'])]);
    assert.equal(acc.code, 0, acc.stderr);
    assert.ok(!fs.existsSync(path.join(inst.vault, 'notes/stale.md')));
    const fm = fmOf(inst, '_archive/notes/stale.md');
    assert.equal(fm['status'], 'archived');
    assert.equal(typeof fm['archived_at'], 'string');
    assert.match(read(inst, '_archive/notes/stale.md').toString('utf8'), /Already stale body text\./);
    assert.deepEqual(await searchPaths(inst, 'Already stale'), []);
    const undo = review(inst, ['undo', String(p.fm['id'])]);
    assert.equal(undo.code, 0, undo.stderr);
    assert.deepEqual(read(inst, 'notes/stale.md'), original);
    assert.ok(!fs.existsSync(path.join(inst.vault, '_archive/notes/stale.md')));
  });
});

describe('note_stats', () => {
  it('rebuilds identically from recalls.jsonl after the table is deleted', () => {
    const inst = setup();
    fixture(inst);
    recalls(inst, [
      { ts: '2026-03-01T00:00:00Z', ids: ['a', 'b'] },
      { ts: '2026-04-01T00:00:00Z', ids: ['a', 'a', 'c'] },
      { ts: '2026-02-01T00:00:00Z', ids: ['c'] },
    ]);
    const h = openIndex({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) });
    try {
      assert.equal(rebuildNoteStats(h.db, ensurePrivateDir(inst.stateDir)), 3);
      const dump = () => h.db.prepare('SELECT id, recall_count, last_recalled FROM note_stats ORDER BY id').all();
      const first = dump();
      assert.deepEqual(first, [
        { id: 'a', recall_count: 2, last_recalled: '2026-04-01T00:00:00.000Z' },
        { id: 'b', recall_count: 1, last_recalled: '2026-03-01T00:00:00.000Z' },
        { id: 'c', recall_count: 2, last_recalled: '2026-04-01T00:00:00.000Z' },
      ]);
      h.db.exec('DROP TABLE note_stats');
      rebuildNoteStats(h.db, ensurePrivateDir(inst.stateDir));
      assert.deepEqual(dump(), first);
    } finally {
      closeIndex(h);
    }
  });
});

describe('journal prune on the forget mechanism', () => {
  function journalFixture(inst: Inst): void {
    const dir = path.join(inst.vault, 'journal/bot/2026');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.md'), '---\nid: entry_old_1\ntitle: Old entry\ncreated: 2026-03-01T00:00:00Z\nexpires: 2026-06-01T00:00:00Z\nstatus: journal\n---\nAn old journal entry.\n');
    fs.writeFileSync(path.join(dir, 'fresh.md'), '---\nid: entry_fresh_1\ntitle: Fresh entry\ncreated: 2026-10-01T00:00:00Z\nexpires: 2027-01-01T00:00:00Z\nstatus: journal\n---\nA fresh journal entry.\n');
  }
  const prune = (inst: Inst, args: string[] = []) => runJournal(['prune', ...args], { env: inst.env, now: () => NOW });

  it('default: archives directly, no proposals, and forget ignores the journal', async () => {
    const inst = setup();
    journalFixture(inst);
    const f = await cog(inst, ['run', 'forget']);
    assert.equal(f.code, 0, f.stderr);
    assert.equal(proposals(inst).length, 0);
    const r = await prune(inst);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /archived journal\/bot\/2026\/old\.md -> journal\/_archive\/bot\/2026\/old\.md/);
    assert.ok(fs.existsSync(path.join(inst.vault, 'journal/_archive/bot/2026/old.md')));
    assert.equal(proposals(inst).length, 0);
  });

  it('pruneRequiresReview: true files archive proposals; nothing moves until accepted; undo restores', async () => {
    const inst = setup({ journal: { pruneRequiresReview: true } });
    journalFixture(inst);
    const dry = await prune(inst, ['--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /1 would be proposed/);
    assert.equal(proposals(inst).length, 0);
    const r = await prune(inst);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 archive proposals created/);
    assert.ok(fs.existsSync(path.join(inst.vault, 'journal/bot/2026/old.md')));
    const ps = proposals(inst);
    assert.equal(ps.length, 1);
    assert.equal(ps[0]!.fm['proposal_type'], 'archive');
    assert.deepEqual(targetPaths(ps[0]!), ['journal/bot/2026/old.md']);
    // The same mechanism: `cognition run forget` sees the same proposal (same key) and adds nothing.
    const f = await cog(inst, ['run', 'forget']);
    assert.match(f.stdout, /proposals: 0 created, 1 already in _inbox\//);
    const original = read(inst, 'journal/bot/2026/old.md');
    const acc = review(inst, ['accept', String(ps[0]!.fm['id'])]);
    assert.equal(acc.code, 0, acc.stderr);
    assert.ok(!fs.existsSync(path.join(inst.vault, 'journal/bot/2026/old.md')));
    assert.equal(fmOf(inst, 'journal/_archive/bot/2026/old.md')['status'], 'archived');
    assert.equal(review(inst, ['undo', String(ps[0]!.fm['id'])]).code, 0);
    assert.deepEqual(read(inst, 'journal/bot/2026/old.md'), original);
    assert.ok(fs.existsSync(path.join(inst.vault, 'journal/bot/2026/fresh.md')));
  });
});

describe('cognition stats forget', () => {
  it('reports counts and the top candidates with signal values', async () => {
    const inst = setup();
    fixture(inst);
    const r = await cog(inst, ['stats', 'forget']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /window 180 days, minimum age 90 days, exempt kinds: decision, reference/);
    assert.match(r.stdout, /1 pinned, 2 exempt kind, 2 too young, 1 recalled in the window/);
    assert.match(r.stdout, /candidates: 2 demote, 1 archive/);
    assert.match(r.stdout, /demote notes\/never\.md: age \d+ days .*recalls 0; last recalled never/);
    assert.match(r.stdout, /demote notes\/long-ago\.md: .*recalls 1; last recalled 2026-02-01/);
    assert.equal(proposals(inst).length, 0, 'stats writes nothing');
    assert.equal((await cog(inst, ['stats', 'nope'])).code, 2);
  });
});

describe('forget config', () => {
  const base = { vaultPath: '/tmp/v', principal: { id: 'p', type: 'human' }, mode: 'inbox' };
  it('defaults', () => {
    const c = parseConfig(base);
    assert.deepEqual(c.cognition.forget, { windowDays: 180, minAgeDays: 90, exemptKinds: ['decision', 'reference'] });
    assert.equal(c.journal.pruneRequiresReview, false);
  });
  it('rejects bad values', () => {
    for (const forget of [{ windowDays: 0 }, { minAgeDays: 1.5 }, { exemptKinds: 'decision' }, { exemptKinds: ['Bad Kind'] }, { nope: 1 }]) {
      assert.throws(() => parseConfig({ ...base, cognition: { forget } }), ConfigError);
    }
    assert.throws(() => parseConfig({ ...base, journal: { pruneRequiresReview: 'yes' } }), ConfigError);
  });
});
