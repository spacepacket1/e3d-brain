// Cognition Phase 2: the job framework, the proposal schema, and the review
// queue. Covered: the closed change grammar and per-type op allowlists; the
// built-in `selftest` job (creates, re-run creates none, rejection memory,
// --reconsider, dry run, the per-job lock, --max-proposals, flood control,
// every mode, taint, scrubbing); run records (no bodies, no query text, no
// secrets; LLM requests as hashes); the LLM layer against a mock
// OpenAI-compatible server (invalid output dropped and counted, budget
// stops); review show/diff/accept/edit/reject/undo/recover (atomic apply,
// byte-identical undo, stale on concurrent edit, authentication against run
// records, immutable fields, archive and create ops, crash recovery); MCP
// tool lists per mode and capture/journal_append refusing proposal fields;
// and scans keeping apply/undo on the Phase 1 undo store.

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCognition } from '../src/cli/cognition-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { runIds } from '../src/cli/undo-commands.js';
import { loadPrompt, parsePromptFile, promptVersions } from '../src/cognition/prompts.js';
import { rejectedKeys } from '../src/cognition/rejections.js';
import { runJob, type CognitionJob, type Draft } from '../src/cognition/run.js';
import { listRunRecords, type RunRecord } from '../src/cognition/runs.js';
import { ConfigError, parseConfig, type Config } from '../src/config.js';
import { closeIndex, openIndex, refreshIndex } from '../src/index/indexer.js';
import { noteIdentityByPath } from '../src/index/identity.js';
import { acquireLock } from '../src/lock.js';
import { dispatch, listTools } from '../src/mcp/dispatch.js';
import { createMcpRuntime } from '../src/mcp/server.js';
import {
  ALLOWED_OPS, archiveDestination, immutableDigest, parseChangeJson, parseProposal, ProposalError, proposalKey, renderProposalNote,
  type ChangeOp, type ProposalTarget,
} from '../src/review/proposal.js';
import { lineDiff, setFrontmatterKey } from '../src/review/queue.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { listOperations } from '../src/undo/store.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';
import { startLlmMock, type LlmMock } from './llm-mock-server.js';
import { fake } from './scrub-fixtures.js';
import { expectedTools, TOOL_MODES, type ToolMode } from './tool-registry.js';

const bases: string[] = [];
let llm: LlmMock;
before(async () => {
  llm = await startLlmMock();
});
after(async () => {
  for (const b of bases) rmrf(b);
  await llm.close();
});
afterEach(() => {
  llm.mode = 'normal';
});

const NOW = new Date('2026-10-14T12:00:00Z');
const ID_A = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const ID_B = '01HZZZZZZZZZZZZZZZZZZZZZZB';

interface Inst {
  base: string;
  vault: string;
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  config: Config;
}

function setup(opts: { mode?: ToolMode; type?: 'human' | 'agent'; extra?: Record<string, unknown> } = {}): Inst {
  const base = realTmpDir('ebrain-cog2-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const mode = opts.mode ?? 'inbox';
  const type = opts.type ?? (mode === 'journal' ? 'agent' : 'human');
  const raw = { vaultPath: vault, stateDir, principal: { id: 'tester', type }, mode, ...opts.extra };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return { base, vault, stateDir, configPath, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '' }, config: parseConfig(raw) };
}

function write(inst: Inst, rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(inst.vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(inst.vault, rel), content);
}

const read = (inst: Inst, rel: string): Buffer => fs.readFileSync(path.join(inst.vault, rel));
const exists = (inst: Inst, rel: string): boolean => fs.existsSync(path.join(inst.vault, rel));

/** Three selftest notes (one with CRLF and a BOM) and one untagged note. */
function seed(inst: Inst): void {
  write(inst, 'notes/alpha.md', '---\ntitle: Alpha\ntags: [ebrain-selftest]\n---\nalpha body BODYMARKER-alpha\n');
  write(inst, 'notes/beta.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\r\ntitle: Beta\r\ntags:\r\n  - ebrain-selftest\r\n---\r\nbeta body BODYMARKER-beta\r\n')]));
  write(inst, 'notes/gamma.md', '# Gamma\n\n#ebrain-selftest gamma body BODYMARKER-gamma\n');
  write(inst, 'notes/plain.md', '# Plain\n\nnot tagged\n');
}

function ids(inst: Inst): void {
  const r = runIds(['assign'], { env: inst.env, now: () => NOW });
  assert.equal(r.code, 0, r.stderr);
}

// Each run starts a second later, so run ids (ULIDs) order runs.
let tick = 0;
const cog = (inst: Inst, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const at = new Date(NOW.getTime() + ++tick * 1000);
  return runCognition(args, { env: { ...inst.env, ...env }, now: () => at });
};
const review = (inst: Inst, args: string[], o: Omit<Parameters<typeof runReview>[1] & object, 'env'> & { env?: NodeJS.ProcessEnv } = {}) =>
  runReview(args, { ...o, env: { ...inst.env, ...o.env }, now: () => NOW });

interface ProposalFile {
  path: string;
  fm: Record<string, unknown>;
  text: string;
}

/** Proposal files directly in `<dir>` (default `_inbox/`). */
function proposals(inst: Inst, dir = '_inbox'): ProposalFile[] {
  const abs = path.join(inst.vault, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => {
    const text = fs.readFileSync(path.join(abs, n), 'utf8');
    return { path: `${dir}/${n}`, fm: parseYaml(splitFrontmatter(text).yaml ?? '') as Record<string, unknown>, text };
  });
}

function byTarget(inst: Inst, notePath: string): ProposalFile {
  const p = proposals(inst).find((x) => (x.fm['targets'] as ProposalTarget[])[0]!.path_at_proposal === notePath);
  assert.ok(p, `no proposal for ${notePath}`);
  return p;
}

function runs(inst: Inst): RunRecord[] {
  return listRunRecords(ensurePrivateDir(inst.stateDir));
}

function stateFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

// ---- proposal schema ----

const T: ProposalTarget[] = [
  { id: ID_A, rev: '0123456789abcdef', path_at_proposal: 'notes/a.md' },
  { id: ID_B, rev: 'fedcba9876543210', path_at_proposal: 'journal/agent1/2026/e.md' },
];
const block = (ops: unknown[]): string => JSON.stringify({ version: 1, ops });

describe('proposal schema', () => {
  it('round-trips a rendered proposal; the digest covers only immutable fields', () => {
    const ops: ChangeOp[] = [
      { op: 'set_frontmatter', target: ID_A, key: 'status', value: 'superseded' },
      { op: 'set_frontmatter', target: ID_A, key: 'supersedes', value: [ID_B] },
      { op: 'append_section', target: ID_A, text: '## Note\n\nappended' },
    ];
    const meta = {
      id: '01J00000000000000000000000', title: 'T', proposal_type: 'supersede' as const, job: 'selftest', job_version: 1, created: '2026-10-14T12:00:00Z',
      author: 'ebrain-selftest', origin: 'cli', targets: T, evidence: [`note:${ID_A}@0123456789abcdef`], untrusted_origin: false, taint_sources: [],
      proposal_key: proposalKey('selftest', 'supersede', [`note:${ID_A}@0123456789abcdef`]),
    };
    const text = renderProposalNote({ meta, ops, rationale: 'why', preview: '- x', scrubVersion: 1 });
    const p = parseProposal(text);
    assert.deepEqual(p.ops, ops);
    assert.equal(p.meta.status, 'proposed');
    assert.equal(p.meta.confidence, 'unrated');
    const d = immutableDigest(p.meta, p.ops);
    assert.match(d, /^[0-9a-f]{64}$/);
    // Prose and appended text are not immutable; values, targets, and keys are.
    assert.equal(immutableDigest(p.meta, [ops[0]!, ops[1]!, { ...ops[2]!, text: 'other' } as ChangeOp]), d);
    assert.notEqual(immutableDigest(p.meta, [{ ...ops[0]!, value: 'archived' } as ChangeOp, ops[1]!, ops[2]!]), d);
    assert.notEqual(immutableDigest({ ...p.meta, evidence: [] }, p.ops), d);
    assert.notEqual(immutableDigest({ ...p.meta, targets: [T[0]!] }, p.ops), d);
    assert.notEqual(immutableDigest({ ...p.meta, job: 'other' }, p.ops), d);
  });

  it('proposal keys are stable functions of job, type, and sorted evidence (C5)', () => {
    const a = proposalKey('selftest', 'demote', ['note:A@0123456789abcdef', 'thesis:x']);
    assert.match(a, /^pk_[0-9a-f]{32}$/);
    assert.equal(proposalKey('selftest', 'demote', ['thesis:x', 'note:A@0123456789abcdef']), a);
    assert.notEqual(proposalKey('selftest', 'archive', ['thesis:x', 'note:A@0123456789abcdef']), a);
    assert.notEqual(proposalKey('forget', 'demote', ['thesis:x', 'note:A@0123456789abcdef']), a);
    assert.notEqual(proposalKey('selftest', 'demote', ['thesis:x', 'note:A@0123456789abcdee']), a);
  });

  it('archive destinations follow C10', () => {
    assert.equal(archiveDestination('notes/a.md'), '_archive/notes/a.md');
    assert.equal(archiveDestination('journal/agent1/2026/e.md'), 'journal/_archive/agent1/2026/e.md');
  });

  it('rejects ops outside the closed grammar or the proposal type', () => {
    const bad: [string, unknown[], Parameters<typeof parseChangeJson>[1]][] = [
      ['unknown op', [{ op: 'delete_note', target: ID_A }], 'merge'],
      ['extra field', [{ op: 'set_frontmatter', target: ID_A, key: 'status', value: 'stale', also: 1 }], 'demote'],
      ['missing field', [{ op: 'set_frontmatter', target: ID_A, key: 'status' }], 'demote'],
      ['type allowlist', [{ op: 'create_note', path: 'notes/x.md', content: 'x' }], 'demote'],
      ['gap changes nothing', [{ op: 'set_frontmatter', target: ID_A, key: 'status', value: 'stale' }], 'gap'],
      ['unknown target', [{ op: 'set_frontmatter', target: '01J0000000000000000000000Z', key: 'status', value: 'stale' }], 'demote'],
      ['key allowlist', [{ op: 'set_frontmatter', target: ID_A, key: 'title', value: 'x' }], 'demote'],
      ['key allowlist: id', [{ op: 'set_frontmatter', target: ID_A, key: 'id', value: 'x' }], 'demote'],
      ['status value', [{ op: 'set_frontmatter', target: ID_A, key: 'status', value: 'proposed' }], 'demote'],
      ['date value', [{ op: 'set_frontmatter', target: ID_A, key: 'archived_at', value: 'yesterday' }], 'archive'],
      ['id value', [{ op: 'set_frontmatter', target: ID_A, key: 'superseded_by', value: 'prov_abc' }], 'supersede'],
      ['traversal', [{ op: 'create_note', path: '../outside.md', content: 'x' }], 'summary'],
      ['absolute', [{ op: 'create_note', path: '/etc/x.md', content: 'x' }], 'summary'],
      ['dot dir', [{ op: 'create_note', path: '.obsidian/x.md', content: 'x' }], 'summary'],
      ['into _inbox', [{ op: 'create_note', path: '_inbox/x.md', content: 'x' }], 'summary'],
      ['into journal', [{ op: 'create_note', path: 'journal/agent1/x.md', content: 'x' }], 'summary'],
      ['not markdown', [{ op: 'create_note', path: 'notes/x.sh', content: 'x' }], 'summary'],
      ['lesson outside lessons/', [{ op: 'create_note', path: 'notes/x.md', content: 'x' }], 'lesson'],
      ['move anywhere', [{ op: 'move_note', target: ID_A, to: 'notes/elsewhere.md' }], 'archive'],
      ['move to the wrong archive path', [{ op: 'move_note', target: ID_B, to: '_archive/journal/agent1/2026/e.md' }], 'archive'],
      ['moved twice', [{ op: 'move_note', target: ID_A, to: '_archive/notes/a.md' }, { op: 'move_note', target: ID_A, to: '_archive/notes/a.md' }], 'archive'],
      ['empty append', [{ op: 'append_section', target: ID_A, text: '  ' }], 'supersede'],
    ];
    for (const [label, ops, type] of bad) assert.throws(() => parseChangeJson(block(ops), type, T), ProposalError, label);
    assert.throws(() => parseChangeJson('{"version": 2, "ops": []}', 'gap', T), ProposalError);
    assert.throws(() => parseChangeJson('{"version": 1, "ops": [], "x": 1}', 'gap', T), ProposalError);
    assert.throws(() => parseChangeJson('not json', 'gap', T), ProposalError);
    // The allowed forms.
    assert.equal(parseChangeJson(block([]), 'gap', T).length, 0);
    assert.equal(parseChangeJson(block([
      { op: 'set_frontmatter', target: ID_B, key: 'status', value: 'archived' },
      { op: 'set_frontmatter', target: ID_B, key: 'archived_at', value: '2026-10-14T12:00:00Z' },
      { op: 'move_note', target: ID_B, to: 'journal/_archive/agent1/2026/e.md' },
      { op: 'move_note', target: ID_A, to: '_archive/notes/a.md' },
    ]), 'archive', T).length, 4);
    assert.equal(parseChangeJson(block([{ op: 'create_note', path: 'lessons/tester/l.md', content: 'x' }]), 'lesson', T).length, 1);
    assert.deepEqual(ALLOWED_OPS.demote, ['set_frontmatter']);
  });

  it('rejects malformed proposal frontmatter and change blocks', () => {
    const meta = {
      id: '01J00000000000000000000000', title: 'T', proposal_type: 'demote' as const, job: 'selftest', job_version: 1, created: 'x', author: 'a',
      origin: 'cli', targets: [T[0]!], evidence: [], untrusted_origin: false, taint_sources: [], proposal_key: proposalKey('selftest', 'demote', []),
    };
    const good = renderProposalNote({ meta, ops: [{ op: 'set_frontmatter', target: ID_A, key: 'status', value: 'stale' }], rationale: 'r', preview: '', scrubVersion: 1 });
    parseProposal(good);
    const mutations: [string, string][] = [
      ['kind', good.replace('kind: proposal', 'kind: idea')],
      ['confidence', good.replace('confidence: unrated', 'confidence: high')],
      ['type', good.replace('proposal_type: demote', 'proposal_type: delete')],
      ['provisional target', good.replace(`id: ${ID_A}`, 'id: prov_0123456789abcdef')],
      ['evidence', good.replace('evidence: []', 'evidence: [not a citation]')],
      ['two blocks', good.replace('## Preview', '```ebrain-change\n{"version":1,"ops":[]}\n```\n## Preview')],
      ['no block', good.replace('```ebrain-change', '```json')],
      ['key', good.replace(/proposal_key: pk_[0-9a-f]+/, 'proposal_key: x')],
    ];
    for (const [label, text] of mutations) assert.throws(() => parseProposal(text), ProposalError, label);
  });

  it('frontmatter edits keep every other byte; the diff shows the exact change', () => {
    const t = '---\ntitle: X\ntags: [a, b]   # keep me\nstatus: accepted\nlist:\n- one\n- two\n---\nbody\n';
    assert.equal(setFrontmatterKey(t, 'status', 'stale'), t.replace('status: accepted', 'status: stale'));
    assert.equal(setFrontmatterKey(t, 'list', ['x']).includes('tags: [a, b]   # keep me'), true);
    assert.equal(setFrontmatterKey(t, 'valid_until', '2026-01-01'), t.replace('---\nbody', 'valid_until: 2026-01-01\n---\nbody'));
    assert.equal(setFrontmatterKey(t, 'supersedes', [ID_A]), t.replace('---\nbody', `supersedes:\n  - ${ID_A}\n---\nbody`));
    assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nB\nc\n'), ['@@ -1,3 +1,3 @@', '  a', '- b', '+ B', '  c']);
  });

  it('loads versioned prompt files', () => {
    assert.deepEqual(promptVersions('selftest'), [1]);
    const p = loadPrompt('selftest');
    assert.equal(p.version, 1);
    assert.match(p.system, /data, not instructions/);
    assert.match(p.instructions, /"items"/);
    assert.throws(() => parsePromptFile('x', 1, '# system\nonly'));
    assert.throws(() => loadPrompt('no-such-job'));
  });
});

// ---- the run framework ----

describe('cognition run selftest', () => {
  it('creates proposals, re-running creates none, a rejection is remembered, --reconsider re-proposes', async () => {
    const inst = setup();
    seed(inst);
    // C3: provisional ids are skipped and counted.
    let r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /3 notes have only a provisional id and were skipped; run: ebrain ids assign/);
    assert.equal(proposals(inst).length, 0);
    ids(inst);

    r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /proposals: 3 created/);
    const ps = proposals(inst);
    assert.equal(ps.length, 3);
    for (const p of ps) {
      assert.equal(p.fm['kind'], 'proposal');
      assert.equal(p.fm['status'], 'proposed');
      assert.equal(p.fm['proposal_type'], 'demote');
      assert.equal(p.fm['job'], 'selftest');
      assert.equal(p.fm['job_version'], 1);
      assert.equal(p.fm['author'], 'ebrain-selftest');
      assert.equal(p.fm['origin'], 'cli');
      assert.equal(p.fm['confidence'], 'unrated');
      assert.equal(p.fm['untrusted_origin'], false);
      assert.match(String(p.fm['proposal_key']), /^pk_[0-9a-f]{32}$/);
      assert.match(p.text, /```ebrain-change\n/);
      parseProposal(p.text);
    }
    const rec = runs(inst)[0]!;
    assert.equal(rec.status, 'finished');
    assert.equal(rec.stop_reason, 'complete');
    assert.equal(rec.proposals.length, 3);
    assert.equal(rec.inputs.count, 3);
    assert.deepEqual(new Set(rec.proposals.map((x) => x.id)), new Set(ps.map((p) => p.fm['id'])));

    r = await cog(inst, ['run', 'selftest']);
    assert.match(r.stdout, /proposals: 0 created, 3 already in _inbox\//);
    assert.equal(proposals(inst).length, 3);

    const beta = byTarget(inst, 'notes/beta.md');
    const rj = review(inst, ['reject', String(beta.fm['id']), '--reason', 'not now']);
    assert.equal(rj.code, 0, rj.stderr);
    assert.ok(rejectedKeys(ensurePrivateDir(inst.stateDir)).has(String(beta.fm['proposal_key'])));
    const rejFile = fs.readFileSync(path.join(inst.stateDir, 'rejections.json'), 'utf8');
    assert.ok(!rejFile.includes('not now'), 'reasons stay on the proposal, not in state');
    const rejected = proposals(inst, '_inbox/_rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.fm['status'], 'rejected');
    assert.equal(rejected[0]!.fm['rejected_reason'], 'not now');

    r = await cog(inst, ['run', 'selftest']);
    assert.match(r.stdout, /0 created, 2 already in _inbox\/, 1 previously rejected \(skipped\)/);
    assert.equal(proposals(inst).length, 2);
    assert.equal(runs(inst)[0]!.counts['rejected_skipped'], 1);

    r = await cog(inst, ['run', 'selftest', '--reconsider']);
    assert.match(r.stdout, /1 created/);
    assert.match(r.stdout, /1 reconsidered/);
    assert.equal(proposals(inst).length, 3);
    assert.equal(byTarget(inst, 'notes/beta.md').fm['proposal_key'], beta.fm['proposal_key']);
  });

  it('--dry-run writes nothing to the vault; --max-proposals and maxPendingProposals stop cleanly', async () => {
    const inst = setup({ extra: { inbox: { maxPendingProposals: 2 } } });
    seed(inst);
    ids(inst);
    const before = treeChecksum(inst.vault);
    let r = await cog(inst, ['run', 'selftest', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /dry run/);
    assert.equal(treeChecksum(inst.vault), before);
    assert.equal(runs(inst)[0]!.options.dry_run, true);
    assert.equal(runs(inst)[0]!.proposals.length, 0);

    r = await cog(inst, ['run', 'selftest', '--max-proposals', '1']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 created/);
    assert.match(r.stdout, /stop: max-proposals/);
    assert.equal(proposals(inst).length, 1);

    r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 created/);
    assert.match(r.stdout, /stop: max-pending/);
    assert.match(r.stdout, /inbox\.maxPendingProposals/);
    assert.equal(proposals(inst).length, 2);
    assert.equal(runs(inst)[0]!.stop_reason, 'max-pending');

    for (const bad of [['--max-proposals', '0'], ['--max-proposals', 'x'], ['--since', 'yesterday'], ['--bogus']]) {
      assert.equal((await cog(inst, ['run', 'selftest', ...bad])).code, 2, bad.join(' '));
    }
    assert.equal((await cog(inst, ['run', 'nope'])).code, 2);
  });

  it('refuses to start while another run of the same job holds the lock', async () => {
    const inst = setup();
    seed(inst);
    ids(inst);
    const lock = acquireLock(ensurePrivateDir(inst.stateDir), 'cognition-selftest');
    try {
      const r = await cog(inst, ['run', 'selftest']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /another run of job selftest is in progress/);
      assert.equal(proposals(inst).length, 0);
    } finally {
      lock.release();
    }
    assert.equal((await cog(inst, ['run', 'selftest'])).code, 0);
  });

  for (const mode of ['read-only', 'journal'] as const) {
    it(`works in ${mode} mode (C11): proposals go to _inbox/ and can be reviewed`, async () => {
      const inst = setup({ mode });
      seed(inst);
      ids(inst);
      const r = await cog(inst, ['run', 'selftest']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(proposals(inst).length, 3);
      const a = byTarget(inst, 'notes/alpha.md');
      const acc = review(inst, ['accept', String(a.fm['id'])]);
      assert.equal(acc.code, 0, acc.stderr);
      assert.match(read(inst, 'notes/alpha.md').toString(), /status: stale/);
    });
  }

  it('propagates taint and scrubs what it writes; run records hold no bodies or secrets', async () => {
    const inst = setup();
    const secret = fake.openai();
    write(inst, 'notes/web.md', `---\ntitle: From the web ${secret}\nuntrusted_origin: true\ntags: [ebrain-selftest]\n---\nscraped text BODYMARKER-web ${secret}\n`);
    seed(inst);
    ids(inst);
    const r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    const web = byTarget(inst, 'notes/web.md');
    assert.equal(web.fm['untrusted_origin'], true);
    assert.deepEqual(web.fm['taint_sources'], (web.fm['evidence'] as string[]));
    assert.ok(!web.text.includes(secret), 'the secret in the note title was scrubbed from the proposal');
    assert.equal(byTarget(inst, 'notes/alpha.md').fm['untrusted_origin'], false);
    const show = review(inst, ['show', String(web.fm['id'])]);
    assert.match(show.stdout, /^!!! UNTRUSTED ORIGIN/);
    const list = review(inst, ['list']);
    assert.match(list.stdout, /UNTRUSTED/);

    for (const file of stateFiles(path.join(inst.stateDir, 'runs'))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/BODYMARKER/.test(text), `note body in ${file}`);
      assert.ok(!text.includes(secret), `secret in ${file}`);
      assert.ok(!/From the web|Alpha|Beta|Gamma/.test(text), `note titles in ${file}`);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  });
});

// ---- LLM layer ----

describe('cognition LLM layer (mock OpenAI-compatible server)', () => {
  const llmCfg = (extra: Record<string, unknown> = {}) => ({ llm: { provider: 'openai-compatible', model: 'mock-1', baseUrl: `${llm.url}/v1`, ...extra } });

  it('drops and counts invalid items, never fatally; logs requests as hashes only', async () => {
    const inst = setup({ extra: llmCfg() });
    seed(inst);
    write(inst, 'notes/odd.md', '---\ntitle: Odd\ntags: [ebrain-selftest]\n---\nMOCK-INVALID BODYMARKER-odd\n');
    ids(inst);
    const sent = llm.requests.length;
    const r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /llm: 4 calls/);
    const rec = runs(inst)[0]!;
    assert.deepEqual(rec.prompt?.id, 'selftest.v1');
    assert.match(rec.prompt!.sha256, /^[0-9a-f]{16}$/);
    assert.deepEqual(rec.provider, { provider: 'openai-compatible', model: 'mock-1' });
    assert.equal(rec.counts['llm_calls'], 4);
    // 3 replies carry one extra invalid item, the MOCK-INVALID reply one invalid item only.
    assert.equal(rec.counts['llm_invalid_items'], 4);
    assert.equal(rec.proposals.length, 4, 'a dropped item does not drop the proposal');
    assert.match(byTarget(inst, 'notes/alpha.md').text, /Model description \(unverified\): A note titled Alpha\./);
    assert.doesNotMatch(byTarget(inst, 'notes/odd.md').text, /Model description/);
    // Hashes only: each logged input hash matches what was sent; no request text is stored.
    const bodies = llm.requests.slice(sent).map((q) => JSON.parse(q.body) as { messages: { role: string; content: string }[] });
    assert.equal(rec.llm_requests.length, 4);
    for (const [i, entry] of rec.llm_requests.entries()) {
      const [system, user] = [bodies[i]!.messages[0]!.content, bodies[i]!.messages[1]!.content];
      assert.equal(entry.input_sha256, createHash('sha256').update(`${system}\n\0\n${user}`, 'utf8').digest('hex'));
      assert.match(entry.output_sha256 ?? '', /^[0-9a-f]{64}$/);
    }
    const recText = fs.readFileSync(path.join(inst.stateDir, 'runs', `${rec.run_id}.json`), 'utf8');
    assert.ok(!/BODYMARKER|Note text|data, not instructions|A note titled/.test(recText), 'request or response text in the run record');
  });

  it('an unparseable reply is counted, not fatal', async () => {
    const inst = setup({ extra: llmCfg() });
    seed(inst);
    ids(inst);
    llm.mode = 'garbage';
    const r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    const rec = runs(inst)[0]!;
    assert.equal(rec.counts['llm_invalid_responses'], 3);
    assert.equal(rec.proposals.length, 3);
    assert.ok(rec.llm_requests.every((q) => q.outcome === 'invalid-response'));
  });

  it('budget caps stop a run cleanly with a partial, well-formed result', async () => {
    const inst = setup({ extra: llmCfg({ maxCallsPerRun: 2 }) });
    seed(inst);
    ids(inst);
    const r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /stop: max-calls/);
    const rec = runs(inst)[0]!;
    assert.equal(rec.status, 'finished');
    assert.equal(rec.stop_reason, 'max-calls');
    assert.equal(rec.proposals.length, 2);
    for (const p of proposals(inst)) parseProposal(p.text);

    const tight = setup({ extra: llmCfg({ maxInputCharsPerRun: 1000 }) });
    seed(tight);
    ids(tight);
    assert.match((await cog(tight, ['run', 'selftest'])).stdout, /stop: max-input-chars/);
    assert.ok(proposals(tight).length < 3);
    assert.equal(runs(tight)[0]!.status, 'finished');
  });

  it('a provider error stops the run cleanly', async () => {
    const inst = setup({ extra: llmCfg() });
    seed(inst);
    ids(inst);
    llm.mode = 'error';
    const r = await cog(inst, ['run', 'selftest']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /stop: provider-error/);
    assert.equal(runs(inst)[0]!.llm_requests[0]!.outcome, 'error');
  });
});

// ---- review queue ----

async function seeded(extra: Record<string, unknown> = {}): Promise<Inst> {
  const inst = setup({ extra });
  seed(inst);
  ids(inst);
  const r = await cog(inst, ['run', 'selftest']);
  assert.equal(r.code, 0, r.stderr);
  return inst;
}

describe('ebrain review', () => {
  it('accept applies atomically and undo restores byte-identical originals', async () => {
    const inst = await seeded();
    const betaBefore = read(inst, 'notes/beta.md');
    const p = byTarget(inst, 'notes/beta.md');
    const id = String(p.fm['id']);
    const diff = review(inst, ['diff', id]);
    assert.equal(diff.code, 0, diff.stderr);
    assert.match(diff.stdout, /edit notes\/beta\.md/);
    assert.match(diff.stdout, /\+ status: stale/);

    const acc = review(inst, ['accept', id]);
    assert.equal(acc.code, 0, acc.stderr);
    assert.match(acc.stdout, /edited notes\/beta\.md/);
    const after = read(inst, 'notes/beta.md');
    // Only the status line was added; BOM and CRLF kept.
    assert.deepEqual(after, Buffer.concat([betaBefore.subarray(0, betaBefore.indexOf('---\r\nbeta')), Buffer.from('status: stale\r\n'), betaBefore.subarray(betaBefore.indexOf('---\r\nbeta'))]));
    assert.equal(proposals(inst).some((x) => x.fm['id'] === id), false);
    const applied = proposals(inst, '_inbox/_applied');
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.fm['status'], 'accepted');
    assert.equal(applied[0]!.fm['applied'], '2026-10-14T12:00:00Z');
    const ops = listOperations({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) }).filter((m) => m.command === `review accept ${id.toLowerCase()}`);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.status, 'committed');
    assert.equal(applied[0]!.fm['undo_operation'], ops[0]!.operation_id);
    assert.match(review(inst, ['accept', id]).stdout, /already applied/);

    const u = review(inst, ['undo', id]);
    assert.equal(u.code, 0, u.stderr);
    assert.deepEqual(read(inst, 'notes/beta.md'), betaBefore);
    const back = byTarget(inst, 'notes/beta.md');
    assert.equal(back.fm['status'], 'proposed');
    assert.equal(back.fm['undone'], '2026-10-14T12:00:00Z');
    assert.equal(back.fm['applied'], undefined);
    assert.equal(proposals(inst, '_inbox/_applied').length, 0);
    // Reopened, it still authenticates and can be accepted again.
    assert.equal(review(inst, ['accept', id]).code, 0);
    assert.match(read(inst, 'notes/beta.md').toString(), /status: stale/);
  });

  it('editing the target between preview and accept makes accept refuse with a stale result', async () => {
    const inst = await seeded();
    const p = byTarget(inst, 'notes/alpha.md');
    const id = String(p.fm['id']);
    assert.equal(review(inst, ['show', id]).code, 0);
    write(inst, 'notes/alpha.md', `${read(inst, 'notes/alpha.md').toString()}edited in Obsidian\n`);
    const edited = read(inst, 'notes/alpha.md');
    const acc = review(inst, ['accept', id]);
    assert.equal(acc.code, 1);
    assert.match(acc.stderr, /stale/);
    assert.deepEqual(read(inst, 'notes/alpha.md'), edited, 'nothing applied');
    assert.equal(byTarget(inst, 'notes/alpha.md').fm['status'], 'stale');
    assert.equal(listOperations({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) }).filter((m) => m.command.startsWith('review')).length, 0);
    assert.match(review(inst, ['accept', id]).stderr, /stale/);
    // The changed note gets a new proposal on re-run (its rev, hence its key, changed).
    assert.match((await cog(inst, ['run', 'selftest'])).stdout, /1 created/);
  });

  it('accept authenticates against run records, never frontmatter claims; immutable fields are enforced', async () => {
    const inst = await seeded();
    const p = byTarget(inst, 'notes/alpha.md');
    const id = String(p.fm['id']);
    // A forged copy with a new id: every frontmatter claim intact, but no run record lists it.
    const forgedId = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
    write(inst, '_inbox/20261014-120000-forged.md', p.text.replace(id, forgedId));
    const forged = review(inst, ['accept', forgedId]);
    assert.equal(forged.code, 1);
    assert.match(forged.stderr, /not written by a recorded cognition run/);
    assert.match(review(inst, ['list']).stdout, new RegExp(`${forgedId}\\tproposed\\tdemote\\tselftest\\tUNAUTHENTICATED`));
    assert.match(review(inst, ['reject', forgedId]).stderr, /use ebrain inbox reject/);

    // Tampering with an immutable field (the set value) is refused; prose edits are fine.
    const file = path.join(inst.vault, p.path);
    fs.writeFileSync(file, p.text.replace('"value": "stale"', '"value": "archived"'));
    const tampered = review(inst, ['accept', id]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /immutable fields/);
    fs.writeFileSync(file, p.text.replace(/path_at_proposal: notes\/alpha\.md/, 'path_at_proposal: notes/other.md'));
    assert.match(review(inst, ['accept', id]).stderr, /immutable fields/);
    fs.writeFileSync(file, p.text.replace('Self-test proposal for', 'Owner-reworded rationale for'));
    const ok = review(inst, ['accept', id]);
    assert.equal(ok.code, 0, ok.stderr);
  });

  it('edit opens $EDITOR on a copy, re-validates, and refuses immutable changes', async () => {
    const inst = await seeded();
    const p = byTarget(inst, 'notes/gamma.md');
    const id = String(p.fm['id']);
    const editor = path.join(inst.base, 'fake-editor.mjs');
    fs.writeFileSync(editor, `#!${process.execPath}\nimport fs from 'node:fs';\nconst f = process.argv[2];\nfs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(process.env.EDIT_FROM).join(process.env.EDIT_TO));\n`, { mode: 0o755 });
    const edit = (from: string, to: string) => review(inst, ['edit', id], { env: { EDITOR: editor, EDIT_FROM: from, EDIT_TO: to } });
    const file = path.join(inst.vault, p.path);

    let r = edit('Self-test proposal for', 'Reworded by the owner for');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /saved \(still proposed\)/);
    assert.match(fs.readFileSync(file, 'utf8'), /Reworded by the owner for/);
    const saved = fs.readFileSync(file);

    r = edit('"value": "stale"', '"value": "archived"');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /immutable/);
    assert.deepEqual(fs.readFileSync(file), saved);
    r = edit('"version": 1', '"version": 1,,');
    assert.match(r.stderr, /invalid/);
    r = edit('status: proposed', 'status: accepted');
    assert.match(r.stderr, /keep status: proposed/);
    assert.deepEqual(fs.readFileSync(file), saved);
    assert.equal(fs.readdirSync(path.join(inst.stateDir, 'review-edit')).length, 0, 'scratch copies are removed');
    assert.equal(review(inst, ['accept', id]).code, 0);
  });

  it('undo refuses and explains when a changed file was edited after apply', async () => {
    const inst = await seeded();
    const id = String(byTarget(inst, 'notes/alpha.md').fm['id']);
    assert.equal(review(inst, ['accept', id]).code, 0);
    const applied = read(inst, 'notes/alpha.md');
    write(inst, 'notes/alpha.md', `${applied.toString()}more\n`);
    const u = review(inst, ['undo', id]);
    assert.equal(u.code, 1);
    assert.match(u.stderr, /notes\/alpha\.md was edited after operation .*nothing was changed/);
    assert.equal(proposals(inst, '_inbox/_applied').length, 1);
    write(inst, 'notes/alpha.md', applied);
    assert.equal(review(inst, ['undo', id]).code, 0);
  });

  it('archive (frontmatter + move per C10) and create ops apply and undo through the undo store', async () => {
    const inst = setup();
    write(inst, 'notes/old.md', '---\ntitle: Old\n---\nold body\n');
    write(inst, 'journal/agent1/2026/entry.md', '---\ntitle: Entry\n---\nentry body\n');
    ids(inst);
    write(inst, '_archive/notes/old.md', 'an earlier archived note with the same name\n');
    const oldBytes = read(inst, 'notes/old.md');
    const entryBytes = read(inst, 'journal/agent1/2026/entry.md');
    const h = openIndex({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) });
    try {
      refreshIndex(h);
      const ident = (p: string) => noteIdentityByPath(h.db, p)!;
      const old = ident('notes/old.md');
      const entry = ident('journal/agent1/2026/entry.md');
      const job: CognitionJob = {
        name: 'fixture', version: 1, description: 'test', llm: 'never',
        generate: async () => ({
          drafts: [
            {
              proposal_type: 'archive', title: 'Archive two', rationale: 'stale',
              targets: [{ id: old.id, rev: old.rev, path_at_proposal: old.path }, { id: entry.id, rev: entry.rev, path_at_proposal: entry.path }],
              evidence: [`note:${old.id}@${old.rev}`, `note:${entry.id}@${entry.rev}`],
              ops: [
                { op: 'set_frontmatter', target: old.id, key: 'status', value: 'archived' },
                { op: 'set_frontmatter', target: old.id, key: 'archived_at', value: '2026-10-14T12:00:00Z' },
                { op: 'move_note', target: old.id, to: '_archive/notes/old.md' },
                { op: 'set_frontmatter', target: entry.id, key: 'status', value: 'archived' },
                { op: 'move_note', target: entry.id, to: 'journal/_archive/agent1/2026/entry.md' },
              ],
            },
            {
              proposal_type: 'summary', title: 'Summary', rationale: 'cluster',
              targets: [], evidence: [`note:${old.id}@${old.rev}`],
              ops: [{ op: 'create_note', path: 'notes/summaries/sum.md', content: `---\nkind: summary\nderived_from: [note:${old.id}@${old.rev}]\n---\nsummary\n` }],
            },
          ] satisfies Draft[],
        }),
      };
      const res = await runJob({ config: inst.config, stateDir: ensurePrivateDir(inst.stateDir), index: h, job, now: () => NOW });
      assert.equal(res.created.length, 2);
    } finally {
      closeIndex(h);
    }
    const archive = proposals(inst).find((p) => p.fm['proposal_type'] === 'archive')!;
    const summary = proposals(inst).find((p) => p.fm['proposal_type'] === 'summary')!;

    // A crash right after publishing the first op rolls everything back.
    const crash = review(inst, ['accept', String(archive.fm['id'])], { afterPublish: () => { throw new Error('simulated crash'); } });
    assert.equal(crash.code, 1);
    assert.deepEqual(read(inst, 'notes/old.md'), oldBytes);
    assert.deepEqual(read(inst, 'journal/agent1/2026/entry.md'), entryBytes);
    assert.ok(!exists(inst, '_archive/notes/old-2.md'));
    assert.equal(proposals(inst).find((p) => p.fm['id'] === archive.fm['id'])!.fm['status'], 'proposed');

    // The summary cites the old note's current revision, so it goes first (archiving changes that revision).
    const sum = review(inst, ['accept', String(summary.fm['id'])]);
    assert.equal(sum.code, 0, sum.stderr);
    assert.match(read(inst, 'notes/summaries/sum.md').toString(), /kind: summary/);
    const acc = review(inst, ['accept', String(archive.fm['id'])]);
    assert.equal(acc.code, 0, acc.stderr);
    assert.ok(!exists(inst, 'notes/old.md'));
    assert.match(read(inst, '_archive/notes/old-2.md').toString(), /status: archived\narchived_at: 2026-10-14T12:00:00Z\n/, 'collision gets a numeric suffix');
    assert.equal(read(inst, '_archive/notes/old.md').toString(), 'an earlier archived note with the same name\n');
    assert.match(read(inst, 'journal/_archive/agent1/2026/entry.md').toString(), /status: archived/);

    assert.equal(review(inst, ['undo', String(summary.fm['id'])]).code, 0);
    assert.equal(review(inst, ['undo', String(archive.fm['id'])]).code, 0);
    assert.ok(!exists(inst, 'notes/summaries/sum.md'), 'undo removes only what accept created');
    // The notes are back at their original paths, byte for byte.
    assert.deepEqual(read(inst, 'notes/old.md'), oldBytes);
    assert.deepEqual(read(inst, 'journal/agent1/2026/entry.md'), entryBytes);
    assert.ok(!exists(inst, '_archive/notes/old-2.md') && !exists(inst, 'journal/_archive/agent1/2026/entry.md'));
    assert.equal(read(inst, '_archive/notes/old.md').toString(), 'an earlier archived note with the same name\n');
  });

  it('a crash after commit is finished by the next accept or by review recover', async () => {
    const inst = await seeded();
    const a = String(byTarget(inst, 'notes/alpha.md').fm['id']);
    const g = String(byTarget(inst, 'notes/gamma.md').fm['id']);
    for (const id of [a, g]) {
      const r = review(inst, ['accept', id], { afterCommit: () => { throw new Error('simulated crash'); } });
      assert.equal(r.code, 1);
    }
    assert.match(read(inst, 'notes/alpha.md').toString(), /status: stale/, 'the operation committed');
    assert.equal(byTarget(inst, 'notes/alpha.md').fm['status'], 'proposed', 'the proposal stays proposed until finalized');
    const again = review(inst, ['accept', a]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /finished an interrupted accept/);
    const rec = review(inst, ['recover']);
    assert.equal(rec.code, 0, rec.stderr);
    assert.match(rec.stdout, /1 interrupted accepts finished/);
    assert.equal(proposals(inst, '_inbox/_applied').length, 2);
    assert.equal(review(inst, ['undo', g]).code, 0);
    assert.doesNotMatch(read(inst, 'notes/gamma.md').toString(), /status/);
  });

  it('ordinary notes still go through ebrain inbox; review refuses them', async () => {
    const inst = await seeded();
    write(inst, '_inbox/20261014-120000-plain.md', '---\nid: 01J1ZZZZZZZZZZZZZZZZZZZZZZ\nstatus: proposed\nkind: idea\n---\nan idea\n');
    const r = review(inst, ['accept', '01J1ZZZZZZZZZZZZZZZZZZZZZZ']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a valid typed proposal/);
    assert.equal(review(inst, ['list']).stdout.includes('01J1ZZZZZZZZZZZZZZZZZZZZZZ'), false);
    assert.equal(review(inst, ['accept', '../../etc/passwd']).code, 1);
    assert.equal(review(inst, ['bogus']).code, 2);
  });
});

// ---- MCP ----

describe('MCP: no job, review, or accept tools; capture and journal_append refuse proposal fields', () => {
  const COGNITION_NAMES = /review|cognition|job|accept|apply|propos|reject|undo|run|edit/;

  for (const mode of TOOL_MODES) {
    it(`mode ${mode}: tools match tools-by-mode.json; none starts a job or reviews, accepts, or applies`, () => {
      const inst = setup({ mode });
      const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
      try {
        const names = listTools(mode, rt.ctx.registry).map((t) => t.name).sort();
        assert.deepEqual(names, expectedTools(mode, 99, 99));
        for (const n of names) assert.ok(!COGNITION_NAMES.test(n), n);
      } finally {
        rt.close();
      }
    });
  }

  it('capture rejects origin, author, and kind: proposal', async () => {
    const inst = setup();
    const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
    try {
      for (const extra of [{ origin: 'cli' }, { author: 'ebrain-selftest' }, { kind: 'proposal' }, { proposal_key: 'pk_0' }, { status: 'accepted' }]) {
        const r = await dispatch(rt.ctx, 'capture', { title: 'x', body: 'y', ...extra });
        assert.equal(r.isError, true, JSON.stringify(extra));
      }
      assert.ok(!fs.existsSync(path.join(inst.vault, '_inbox')) || fs.readdirSync(path.join(inst.vault, '_inbox')).length === 0);
      assert.equal((await dispatch(rt.ctx, 'capture', { title: 'x', body: 'y' })).isError, undefined);
    } finally {
      rt.close();
    }
  });

  it('journal_append rejects origin, author, and kind: proposal', async () => {
    const inst = setup({ mode: 'journal' });
    const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
    try {
      for (const extra of [{ origin: 'cli' }, { author: 'ebrain-selftest' }, { kind: 'proposal' }, { proposal_type: 'merge' }]) {
        const r = await dispatch(rt.ctx, 'journal_append', { title: 'x', body: 'y', ...extra });
        assert.equal(r.isError, true, JSON.stringify(extra));
      }
      assert.ok(!fs.existsSync(path.join(inst.vault, 'journal')) || stateFiles(path.join(inst.vault, 'journal')).length === 0);
    } finally {
      rt.close();
    }
  });
});

// ---- scans and config ----

function src(rel: string): string {
  return fs.readFileSync(path.join(repoRoot(), rel), 'utf8');
}

function srcFiles(dir: string): string[] {
  return stateFiles(path.join(repoRoot(), dir)).filter((f) => f.endsWith('.ts'));
}

describe('scans', () => {
  it('src/mcp/ never imports the cognition or review modules', () => {
    for (const f of srcFiles('src/mcp')) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /from '\.\.\/(cognition|review)\//, f);
    }
  });

  it('apply and undo reuse the Phase 1 undo store (no second implementation)', () => {
    const queue = src('src/review/queue.ts');
    const storeImport = /import \{([^}]*)\} from '\.\.\/undo\/store\.js'/.exec(queue)?.[1] ?? '';
    for (const fn of ['runOperation', 'restore', 'recoverPending']) assert.match(storeImport, new RegExp(`\\b${fn}\\b`), fn);
    for (const f of [...srcFiles('src/review'), ...srcFiles('src/cognition'), ...srcFiles('src/cli')]) {
      const text = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(text, /manifest\.json|done\.jsonl|sha256_before|UNDO_DIR|renameSafe/, f);
    }
    // Target notes are only ever written by runOperation: the queue's direct writes touch proposals and scratch copies.
    const direct = queue.match(/\b(writeAtomic|createExclusive|unlinkSafe)\(/g) ?? [];
    assert.ok(direct.length <= 6, `unexpected direct writes in queue.ts: ${direct.length}`);
  });

  it('jobs write proposals only through the inbox writer (C1)', () => {
    for (const f of srcFiles('src/cognition')) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\b(createExclusive|renameSafe|unlinkSafe|appendSafe)\(|resolveInVault\([^)]*\)[^;]*write/, f);
    }
    assert.match(src('src/cognition/run.ts'), /writeInboxFile\(/);
  });

  it('config: inbox.maxPendingProposals and cognition.maxProposalsPerRun', () => {
    const base = { vaultPath: '/v', stateDir: '/s', principal: { id: 'p', type: 'human' }, mode: 'inbox' };
    assert.equal(parseConfig(base).inbox.maxPendingProposals, 50);
    assert.equal(parseConfig(base).cognition.maxProposalsPerRun, 20);
    assert.equal(parseConfig({ ...base, inbox: { maxPendingProposals: 5 } }).inbox.maxPendingProposals, 5);
    for (const bad of [{ inbox: { maxPendingProposals: 0 } }, { inbox: { other: 1 } }, { cognition: { maxProposalsPerRun: 1.5 } }, { cognition: { maxLlmCalls: 3 } }]) {
      assert.throws(() => parseConfig({ ...base, ...bad }), ConfigError, JSON.stringify(bad));
    }
  });
});
