// Cognition Phase 9 safety scan. Asserts, statically and by running every
// built-in job on fixture vaults:
//   - no cognition code path writes outside `_inbox/` or `<stateDir>`: jobs
//     return drafts and never write; only run.ts publishes into the vault, via
//     the inbox writer; the other cognition writers resolve their paths in the
//     state dir; `src/eval/` writes only below its own temporary directory;
//     normal runs change nothing in the vault outside `_inbox/`, shadow runs
//     change nothing at all;
//   - `apply` (owner `review accept`) changes only the targets of the accepted
//     proposal, the notes it creates, its archive destinations, and `_inbox/`,
//     with the undo store under `<stateDir>/undo/`;
//   - no MCP registration references `src/cognition/` (or eval, review, git);
//   - the I3 (network only in src/net/, child_process only in src/exec/) and
//     I4 (no telemetry, auto-update, or runtime installs) source scans pass.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stringify } from 'yaml';
import { runCognition } from '../src/cli/cognition-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { listRunRecords } from '../src/cognition/runs.js';
import { parseConfig } from '../src/config.js';
import { parseProposal } from '../src/review/proposal.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';
import { startLlmMock, type LlmMock } from './llm-mock-server.js';

const ROOT = repoRoot();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return out.sort();
}

const rel = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/');
/** Source without comments (so prose that names a function does not count). */
const code = (f: string): string => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Like assert.doesNotMatch, without dumping a whole source file on failure. */
const absent = (c: string, re: RegExp, msg: string): void => assert.ok(!re.test(c), `${msg} (${re.exec(c)?.[0] ?? ''})`);
const present = (c: string, re: RegExp, msg: string): void => assert.ok(re.test(c), msg);

const RAW_WRITES = /\b(createExclusive|writeAtomic|renameSafe|unlinkSafe|mkdirSafe|appendSafe|writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|copyFileSync|cpSync|symlinkSync|linkSync)\s*\(/;
const VAULT_RESOLVERS = /\b(resolveInVault|vaultChild|ensureOwnerDir|assertInside|resolveInRoot)\b/;

describe('safety scan: static', () => {
  const cognition = sourceFiles('src/cognition');

  it('cognition jobs never write; only run.ts publishes into the vault, through the inbox writer', () => {
    for (const f of cognition) {
      const c = code(f);
      if (rel(f).startsWith('src/cognition/jobs/')) {
        absent(c, RAW_WRITES, `${rel(f)} writes a file`);
        absent(c, /\bwriteInboxFile\b/, `${rel(f)} writes to the inbox itself`);
      }
      if (rel(f) !== 'src/cognition/run.ts') absent(c, /\bwriteInboxFile\b/, `${rel(f)} uses the inbox writer`);
      absent(c, /from 'node:fs'|require\('fs'\)/, `${rel(f)} imports node:fs directly`);
      absent(c, /from '\.\.\/(\.\.\/)?(undo|review\/queue|inbox\/review)/, `${rel(f)} reaches apply/undo or the inbox review moves`);
      absent(c, /\brunOperation\b/, `${rel(f)} runs an undo operation`);
    }
  });

  it('every other cognition write resolves its path in the state dir, never the vault', () => {
    const writers = cognition.filter((f) => RAW_WRITES.test(code(f)));
    assert.ok(writers.length > 0);
    for (const f of writers) {
      const c = code(f);
      absent(c, VAULT_RESOLVERS, `${rel(f)} writes files and also resolves vault paths`);
      present(c, /\bresolveInState\(/, `${rel(f)} writes without resolveInState`);
    }
    present(code(path.join(ROOT, 'src/cognition/run.ts')), /writeShadowProposal\(stateDir,/, 'shadow proposals go to the state dir');
  });

  it('src/eval writes only below its own temporary directory', () => {
    for (const f of sourceFiles('src/eval')) {
      const c = code(f);
      absent(c, /\b(resolveInVault|resolveInState|vaultChild|writeInboxFile|writeAtomic|renameSafe|unlinkSafe|appendSafe|runOperation|ensureStateDir|ensurePrivateDir)\b/, rel(f));
      absent(c, /from 'node:fs'/, rel(f));
      for (const line of c.split('\n').filter((l) => RAW_WRITES.test(l))) {
        assert.match(line, /\b(createExclusive|mkdirSafe)\((resolveInRoot\(|v\)|s\))/, `${rel(f)}: ${line.trim()}`);
      }
    }
    const replay = code(path.join(ROOT, 'src/eval/replay.ts'));
    present(replay, /makeTempDir\('ebrain-replay-'\)/, 'temp dir');
    present(replay, /removeTempDir\(tmp\)/, 'temp dir removed');
    present(replay, /shadow: true/, 'replay runs in shadow mode');
    // git is reached only through src/exec/git.ts, which never runs worktree/checkout or any writing command.
    const g = code(path.join(ROOT, 'src/exec/git.ts'));
    for (const cmd of ['worktree', 'checkout', 'reset', 'clean', 'stash', 'commit', 'push', 'fetch', 'pull', 'gc', 'config', 'update-ref', 'branch', 'tag']) {
      absent(g, new RegExp(`'${cmd}'`), `git ${cmd}`);
    }
    present(g, /shell: false/, 'no shell');
  });

  it('no MCP registration references src/cognition/ (or eval, review, or git)', () => {
    for (const f of sourceFiles('src/mcp')) {
      const c = fs.readFileSync(f, 'utf8');
      absent(c, /from '\.\.\/(cognition|eval|review)\/|exec\/git/, rel(f));
      absent(c, /src\/cognition\//, rel(f));
    }
    const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/tools-by-mode.json'), 'utf8')) as { name: string; phase: unknown }[];
    for (const t of tools) {
      if (t.name === 'report_use') continue;
      assert.doesNotMatch(t.name, /cognition|review|accept|apply|replay|eval|shadow|job|report/, t.name);
    }
  });

  it('I3: network APIs only in src/net/, child_process only in src/exec/', () => {
    for (const f of sourceFiles('src')) {
      const c = code(f);
      if (!rel(f).startsWith('src/net/')) absent(c, /from 'node:(net|http|https|http2|dgram|tls)'|\bfetch\(|XMLHttpRequest|new WebSocket/, rel(f));
      if (!rel(f).startsWith('src/exec/')) absent(c, /node:child_process|require\('child_process'\)/, rel(f));
    }
  });

  it('I4: no telemetry, auto-update, or runtime installs', () => {
    for (const f of sourceFiles('src')) {
      const c = fs.readFileSync(f, 'utf8');
      absent(c, /telemetry|analytics|auto-?update|crash ?report|\bnpm (install|i|update)\b|\bnpx\b|\byarn add\b|\bpnpm add\b|\beval\(|new Function\(|\bimport\(/i, rel(f));
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[hook], undefined, hook);
  });
});

// ---- dynamic ----

let llm: LlmMock;
before(async () => {
  llm = await startLlmMock();
});
const bases: string[] = [];
after(async () => {
  for (const b of bases) rmrf(b);
  await llm.close();
});

interface Inst {
  base: string;
  vault: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

function setup(kind: 'human' | 'agent'): Inst {
  const base = realTmpDir('ebrain-cog9s-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const raw: Record<string, unknown> = kind === 'human'
    ? { vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox', inbox: { maxPendingProposals: 500 }, cognition: { maxProposalsPerRun: 500, forget: { minAgeDays: 1, windowDays: 1 } }, queryLog: { enabled: true } }
    : { vaultPath: vault, stateDir, principal: { id: 'trader', type: 'agent' }, mode: 'journal', inbox: { maxPendingProposals: 500 }, cognition: { maxProposalsPerRun: 500 }, llm: { provider: 'openai-compatible', model: 'mock-1', baseUrl: `${llm.url}/v1`, maxCallsPerRun: 200 } };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  parseConfig(raw);
  return { base, vault, stateDir, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '' } };
}

function write(inst: Inst, r: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(inst.vault, r)), { recursive: true });
  fs.writeFileSync(path.join(inst.vault, r), text);
}

const note = (inst: Inst, r: string, fm: Record<string, unknown>, body: string) => write(inst, r, `---\n${stringify(fm)}---\n${body}\n`);

/** Human brain: selftest notes, a supersede pair, near-duplicates and a cluster for consolidate, old notes for forget, a query log for gaps. */
function humanFixture(inst: Inst): void {
  for (let i = 1; i <= 2; i++) note(inst, `notes/self-${i}.md`, { id: `self_${i}`, title: `Self ${i}`, created: '2024-01-01', tags: ['ebrain-selftest'] }, `Self-test note ${i}.`);
  note(inst, 'notes/db-postgres.md', { id: 'db_old', title: 'Database choice', occurred: '2026-03-10', kind: 'decision', tags: ['database'] }, 'We use Postgres for the main database. It runs on the shared host.');
  note(inst, 'notes/db-sqlite.md', { id: 'db_new', title: 'Database migration', occurred: '2026-06-20', kind: 'decision', tags: ['database'] }, 'We moved to SQLite for the main database. Postgres was retired.');
  const dup = 'The deploy checklist: run the migrations, warm the caches, flip the load balancer, then watch the error dashboards for ten minutes before announcing.';
  note(inst, 'notes/deploy-a.md', { id: 'dep_a', title: 'Deploy checklist', created: '2026-01-02', tags: ['ops'] }, dup);
  note(inst, 'notes/deploy-b.md', { id: 'dep_b', title: 'Deploy checklist copy', created: '2026-01-03', tags: ['ops'] }, `${dup} Also ping the channel.`);
  for (let i = 1; i <= 3; i++) note(inst, `notes/ops-${i}.md`, { id: `ops_${i}`, title: `Ops topic ${i}`, created: '2026-01-04', tags: ['ops'] }, `Distinct ops topic number ${i} about ${['paging', 'backups', 'dns'][i - 1]}.`);
  note(inst, 'notes/old.md', { id: 'old_1', title: 'Old idea', created: '2020-01-01', status: 'accepted' }, 'An old idea nobody recalls.');
  const now = Date.now();
  const q = (query: string, i: number) => JSON.stringify({ ts: new Date(now - i * 60_000).toISOString(), recall_id: `r${i}`, principal: 'tester', query, results: 0, top_tier: null });
  fs.writeFileSync(path.join(inst.stateDir, 'queries.jsonl'), `${[q('kafka consumer lag', 1), q('kafka consumer lag', 2), q('kafka lag consumer', 3)].join('\n')}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(inst.stateDir, 'recalls.jsonl'), `${JSON.stringify({ recall_id: 'r0', ts: '2020-01-01T00:00:00.000Z', principal: 'tester', ids: [] })}\n`, { mode: 0o600 });
}

/** Agent brain: one closed thesis with an entry and an outcome (reflect). */
function agentFixture(inst: Inst): void {
  const dir = path.join(inst.stateDir, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'e3d.jsonl'), [
    { kind: 'thesis', id: 'th_win', occurred: '2026-09-01T00:00:00Z', summary: 'Expected ETH to outperform BTC over two weeks.', attributes: { status: 'closed' } },
    { kind: 'outcome', id: 'oc_win', occurred: '2026-09-15T00:00:00Z', summary: 'ETH outperformed BTC over two weeks.', attributes: { thesis: 'th_win', result: 'win' } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  note(inst, 'journal/trader/2026/20260902-100000-eth.md', {
    id: 'entry_win_1', schema: 1, title: 'ETH over BTC', author: 'trader', origin: 'mcp', created: '2026-09-02T10:00:00Z', kind: 'decision',
    sources: ['thesis:th_win'], untrusted_origin: false, status: 'journal', tags: ['eth'],
  }, '# ETH over BTC\n\nOpened the ETH over BTC thesis on rotation flows.');
}

/** path -> sha256 of every file in the vault. */
function snapshot(vault: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, r: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = r === '' ? e.name : `${r}/${e.name}`;
      if (e.isDirectory()) walk(path.join(d, e.name), p);
      else out.set(p, createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex'));
    }
  };
  walk(vault, '');
  return out;
}

function changed(a: Map<string, string>, b: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [p, h] of a) if (b.get(p) !== h) out.add(p);
  for (const p of b.keys()) if (!a.has(p)) out.add(p);
  return [...out].sort();
}

let tick = 0;
const at = () => new Date(Date.parse('2026-10-14T12:00:00Z') + ++tick * 60_000);
const cog = (inst: Inst, args: string[]) => runCognition(args, { env: inst.env, now: at });
const JOBS_BY_KIND = { human: ['selftest', 'supersede', 'consolidate', 'forget', 'gaps'], agent: ['reflect'] } as const;

describe('safety scan: dynamic', () => {
  for (const kind of ['human', 'agent'] as const) {
    it(`${kind} brain: runs write only to _inbox/ and the state dir; shadow runs write nothing to the vault`, async () => {
      const inst = setup(kind);
      if (kind === 'human') humanFixture(inst);
      else agentFixture(inst);
      const top = fs.readdirSync(inst.base).sort();

      // Shadow first: the vault is byte-identical and _inbox/ is never created.
      const sum = treeChecksum(inst.vault);
      for (const job of JOBS_BY_KIND[kind]) {
        const r = await cog(inst, ['run', job, '--shadow']);
        assert.equal(r.code, 0, `${job}: ${r.stderr}`);
      }
      assert.equal(treeChecksum(inst.vault), sum, 'shadow runs changed the vault');
      assert.equal(fs.existsSync(path.join(inst.vault, '_inbox')), false);
      const shadowCount = listRunRecords(ensurePrivateDir(inst.stateDir)).reduce((a, r) => a + (r.shadow_proposals?.length ?? 0), 0);
      assert.ok(shadowCount >= JOBS_BY_KIND[kind].length, `every job proposed something in shadow (${shadowCount})`);

      const beforeRuns = snapshot(inst.vault);
      for (const job of JOBS_BY_KIND[kind]) {
        const r = await cog(inst, ['run', job]);
        assert.equal(r.code, 0, `${job}: ${r.stderr}`);
      }
      const diff = changed(beforeRuns, snapshot(inst.vault));
      assert.ok(diff.length >= JOBS_BY_KIND[kind].length, 'the jobs created proposals');
      for (const p of diff) assert.match(p, /^_inbox\/[^/]+\.md$/, `a job wrote ${p}`);
      for (const p of beforeRuns.keys()) assert.ok(fs.existsSync(path.join(inst.vault, p)), `a job removed ${p}`);
      assert.deepEqual(fs.readdirSync(inst.base).sort(), top, 'nothing written next to the vault and state dir');

      // Apply: each accept changes only its targets, created notes, archive destinations, and _inbox/.
      const files = fs.readdirSync(path.join(inst.vault, '_inbox')).filter((n) => n.endsWith('.md')).sort();
      let accepted = 0;
      for (const name of files) {
        const p = parseProposal(fs.readFileSync(path.join(inst.vault, '_inbox', name), 'utf8'));
        const allowed = new Set(p.meta.targets.map((t) => t.path_at_proposal));
        const prefixes: string[] = [];
        for (const op of p.ops) {
          if (op.op === 'create_note') allowed.add(op.path);
          if (op.op === 'move_note') prefixes.push(op.to.replace(/\.md$/, ''));
        }
        const pre = snapshot(inst.vault);
        const r = runReview(['accept', p.meta.id], { env: inst.env, now: at });
        if (r.code !== 0) continue; // e.g. a target already changed by an earlier accept: refused, nothing applied
        accepted++;
        for (const c of changed(pre, snapshot(inst.vault))) {
          const ok = c.startsWith('_inbox/') || allowed.has(c) || prefixes.some((x) => c.startsWith(x));
          assert.ok(ok, `accepting ${p.meta.proposal_type} (${p.meta.job}) changed ${c}`);
        }
      }
      assert.ok(accepted >= JOBS_BY_KIND[kind].length - (kind === 'human' ? 1 : 0), `accepted ${accepted} of ${files.length}`);
      assert.ok(fs.readdirSync(path.join(inst.stateDir, 'undo')).length > 0, 'the undo store lives under <stateDir>/undo/');
      assert.equal(snapshot(inst.vault).has('.ebrain-undo'), false);
      for (const p of snapshot(inst.vault).keys()) assert.doesNotMatch(p, /(^|\/)\.ebrain-undo\//);
      assert.deepEqual(fs.readdirSync(inst.base).sort(), top);
    });
  }
});
