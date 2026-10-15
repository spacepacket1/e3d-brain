// Cognition Phase 9: evaluation, shadow mode, and operations. Covered:
// `cognition report` counts per job/version from fixture review records
// (created, accepted, edited then accepted, rejected, stale, pending,
// missing, median time to review, rejection reason tallies; dry, shadow, and
// unrecorded proposals not counted); the `edited` stamp from `review edit`;
// `report --check` (exit 3 below threshold, 0 when ok or too few reviews; the
// code's kill criteria equal the docs table); `run --shadow` (nothing in
// `_inbox/`, vault checksum unchanged, never authenticated for accept, later
// hand-made changes matched by `report`); `eval replay` on a fixture git
// vault with known later actions (selftest and supersede counts, `--at`
// dates, no temp dirs left, the owner's working tree, .git, and state dir
// untouched), without git (documented message), with a dirty tree; the tar
// reader's refusals; git argument checks; and the outcome matcher.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCognition, REPORT_BELOW_THRESHOLD } from '../src/cli/cognition-commands.js';
import { runEval } from '../src/cli/eval-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { JOBS } from '../src/cognition/jobs/index.js';
import { laterActions, matchProposal, type NoteFacts } from '../src/cognition/outcomes.js';
import { buildReport, KILL_CRITERIA, median, normalizeReason } from '../src/cognition/report.js';
import { listRunRecords, writeRunRecord, type RunRecord } from '../src/cognition/runs.js';
import { parseConfig } from '../src/config.js';
import { extractTar, TarError } from '../src/eval/tar.js';
import { resolveCommit } from '../src/exec/git.js';
import { closeIndex, openIndex } from '../src/index/indexer.js';
import { ulid } from '../src/mcp/ulid.js';
import { ensurePrivateDir, makeTempDir, removeTempDir, SafePathError } from '../src/safe-path.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';

const bases: string[] = [];
after(() => {
  for (const b of bases) rmrf(b);
});

const NOW = new Date('2026-10-14T12:00:00Z');

interface Inst {
  base: string;
  vault: string;
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
}

function setup(extra: Record<string, unknown> = {}): Inst {
  const base = realTmpDir('ebrain-cog9-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const raw = { vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox', inbox: { maxPendingProposals: 200 }, cognition: { maxProposalsPerRun: 200 }, ...extra };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  parseConfig(raw);
  return { base, vault, stateDir, configPath, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' } };
}

function write(inst: Inst, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(inst.vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(inst.vault, rel), text);
}

function note(inst: Inst, rel: string, fm: Record<string, string>, body = 'Body text.\n'): void {
  write(inst, rel, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`);
}

function selftestNotes(inst: Inst, n: number): void {
  for (let i = 1; i <= n; i++) note(inst, `notes/n${i}.md`, { id: `note_${i}`, title: `Note ${i}`, created: `2024-01-0${i}`, tags: '[ebrain-selftest]' });
}

/** Set a frontmatter line on a vault note by hand (the owner's own edit). */
function handSet(inst: Inst, rel: string, key: string, value: string): void {
  const file = path.join(inst.vault, rel);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^---\n/, `---\n${key}: ${value}\n`));
}

let tick = 0;
const cog = (inst: Inst, args: string[]) => {
  const at = new Date(NOW.getTime() + ++tick * 60_000);
  return runCognition(args, { env: inst.env, now: () => at });
};
const review = (inst: Inst, args: string[], env: NodeJS.ProcessEnv = {}) => runReview(args, { env: { ...inst.env, ...env }, now: () => new Date(NOW.getTime() + ++tick * 60_000) });

function inboxFiles(inst: Inst, dir = '_inbox'): { path: string; fm: Record<string, unknown> }[] {
  const abs = path.join(inst.vault, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => ({
    path: `${dir}/${n}`, fm: parseYaml(splitFrontmatter(fs.readFileSync(path.join(abs, n), 'utf8')).yaml ?? '') as Record<string, unknown>,
  }));
}

// ---- fixture review records ----

const H = 3_600_000;
const T0 = Date.parse('2026-09-01T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Spec {
  job: string;
  version: number;
  where: 'open' | 'applied' | 'rejected' | 'none';
  status?: string;
  reviewedAfterH?: number;
  edited?: boolean;
  reason?: string;
}

/** Write proposal files and run records directly (one run per job/version). */
function fixtureRecords(inst: Inst, specs: readonly Spec[], opts: { extraRuns?: Partial<RunRecord>[] } = {}): void {
  const runs = new Map<string, RunRecord>();
  let seq = 0;
  for (const s of specs) {
    const id = ulid(T0 + seq++);
    const key = `pk_${String(seq).padStart(32, '0')}`;
    const k = `${s.job}@${s.version}`;
    if (!runs.has(k)) runs.set(k, baseRun(s.job, s.version, T0 + runs.size * 1000));
    runs.get(k)!.proposals.push({ id, proposal_key: key, digest: 'd'.repeat(64) });
    if (s.where === 'none') continue;
    const status = s.status ?? (s.where === 'applied' ? 'accepted' : s.where === 'rejected' ? 'rejected' : 'proposed');
    const fm: string[] = [
      `id: ${id}`, `title: ${s.job} proposal ${seq}`, 'kind: proposal', `status: ${status}`, 'proposal_type: demote', `job: ${s.job}`, `job_version: ${s.version}`,
      `created: ${iso(T0)}`, `proposal_key: ${key}`, 'confidence: unrated', 'untrusted_origin: false',
    ];
    if (s.where === 'applied') fm.push(`applied: ${iso(T0 + (s.reviewedAfterH ?? 1) * H)}`);
    if (s.where === 'rejected') fm.push(`rejected: ${iso(T0 + (s.reviewedAfterH ?? 1) * H)}`);
    if (s.edited === true) fm.push(`edited: ${iso(T0 + 600_000)}`);
    if (s.reason !== undefined) fm.push(`rejected_reason: ${JSON.stringify(s.reason)}`);
    const dir = s.where === 'applied' ? '_inbox/_applied' : s.where === 'rejected' ? '_inbox/_rejected' : '_inbox';
    write(inst, `${dir}/p-${seq}.md`, `---\n${fm.join('\n')}\n---\nRationale.\n`);
  }
  for (const r of runs.values()) writeRunRecord(ensurePrivateDir(inst.stateDir), r);
  for (const extra of opts.extraRuns ?? []) writeRunRecord(ensurePrivateDir(inst.stateDir), { ...baseRun('supersede', 1, T0 + 99_000), ...extra } as RunRecord);
}

function baseRun(job: string, version: number, ms: number): RunRecord {
  return {
    run_id: ulid(ms), job, job_version: version, prompt: null, provider: null, started: iso(ms), finished: iso(ms), status: 'finished',
    options: { since: null, max_proposals: 20, dry_run: false, reconsider: false }, budget: { max_llm_calls: 1, max_input_chars: 1, max_proposals: 20, max_pending: 50 },
    inputs: { count: 0, sha256: '', notes: [] }, counts: {}, stop_reason: 'complete', llm_requests: [], proposals: [],
  };
}

function report(inst: Inst, criteria?: Parameters<typeof buildReport>[0]['criteria']) {
  const stateDir = ensurePrivateDir(inst.stateDir);
  const config = parseConfig(JSON.parse(fs.readFileSync(inst.configPath, 'utf8')));
  const h = openIndex({ vaultPath: inst.vault, stateDir });
  try {
    return buildReport({ config, stateDir, index: h, currentVersions: new Map(JOBS.map((j) => [j.name, j.version])), ...(criteria === undefined ? {} : { criteria }) });
  } finally {
    closeIndex(h);
  }
}

describe('cognition report (online metrics from review records)', () => {
  it('counts per job and version, with median time to review and rejection reasons', async () => {
    const inst = setup();
    fixtureRecords(inst, [
      { job: 'supersede', version: 1, where: 'applied', reviewedAfterH: 2 },
      { job: 'supersede', version: 1, where: 'applied', reviewedAfterH: 4, edited: true },
      { job: 'supersede', version: 1, where: 'rejected', reviewedAfterH: 1, reason: 'Not a conflict' },
      { job: 'supersede', version: 1, where: 'rejected', reviewedAfterH: 3, reason: '  not   a CONFLICT ' },
      { job: 'supersede', version: 1, where: 'rejected', reviewedAfterH: 8 },
      { job: 'supersede', version: 1, where: 'open', status: 'stale' },
      { job: 'supersede', version: 1, where: 'open' },
      { job: 'supersede', version: 1, where: 'none' },
      { job: 'supersede', version: 2, where: 'applied', reviewedAfterH: 5 },
      { job: 'forget', version: 1, where: 'open' },
      { job: 'forget', version: 1, where: 'open' },
    ], {
      extraRuns: [
        { run_id: ulid(T0 + 200_000), options: { since: null, max_proposals: 20, dry_run: true, reconsider: false }, counts: { would_create: 4 } },
        { run_id: ulid(T0 + 300_000), options: { since: null, max_proposals: 20, dry_run: false, reconsider: false, shadow: true }, shadow_proposals: [] },
      ],
    });
    // A proposal file no run record lists is not counted.
    write(inst, '_inbox/stray.md', `---\nid: ${ulid(T0 + 900_000)}\nkind: proposal\nstatus: proposed\njob: supersede\njob_version: 1\n---\nx\n`);

    const r = report(inst);
    const row = (job: string, version: number) => r.rows.find((x) => x.job === job && x.version === version);
    assert.deepEqual(row('supersede', 1), {
      job: 'supersede', version: 1, created: 8, accepted: 1, edited_accepted: 1, rejected: 3, stale: 1, pending: 1, missing: 1,
      median_review_ms: 3 * H, rejected_reasons: { 'not a conflict': 2, '(no reason given)': 1 },
    });
    assert.equal(row('supersede', 2)?.created, 1);
    assert.equal(row('supersede', 2)?.accepted, 1);
    assert.equal(row('supersede', 2)?.median_review_ms, 5 * H);
    assert.equal(row('forget', 1)?.pending, 2);
    assert.equal(r.rows.length, 3);

    const out = await runCognition(['report'], { env: inst.env });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /supersede v1: 8 created; 1 accepted, 1 edited then accepted, 3 rejected, 1 stale, 1 pending, 1 missing; acceptance 40% \(2\/5 reviewed\); median time to review 3\.0h/);
    assert.match(out.stdout, /rejected reasons: "not a conflict" 2, "\(no reason given\)" 1/);
    assert.match(out.stdout, /supersede v2: 1 created; 1 accepted/);
    assert.doesNotMatch(out.stdout, /kill criteria/, 'criteria are printed only with --check');
    assert.equal((await runCognition(['report', '--bogus'], { env: inst.env })).code, 2);
  });

  it('helpers: median and reason normalization', () => {
    assert.equal(median([]), null);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(normalizeReason('  Dup\n of X '), 'dup of x');
    assert.equal(normalizeReason(''), '(no reason given)');
    assert.equal(normalizeReason(undefined), '(no reason given)');
  });

  it('review edit stamps `edited`, so edited-then-accepted is counted from real review records', async () => {
    const inst = setup();
    selftestNotes(inst, 3);
    assert.equal((await cog(inst, ['run', 'selftest'])).code, 0);
    const files = inboxFiles(inst);
    assert.equal(files.length, 3);
    const [a, b, c] = files.map((f) => String(f.fm['id']));
    const editor = path.join(inst.base, 'fake-editor.mjs');
    fs.writeFileSync(editor, `#!${process.execPath}\nimport fs from 'node:fs';\nconst f = process.argv[2];\nfs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('Self-test proposal for').join('Reworded for'));\n`, { mode: 0o755 });
    const e = review(inst, ['edit', a!], { EDITOR: editor });
    assert.equal(e.code, 0, e.stderr);
    assert.ok(inboxFiles(inst).some((f) => f.fm['id'] === a && typeof f.fm['edited'] === 'string'), 'edit adds an edited stamp');
    assert.equal(review(inst, ['accept', a!]).code, 0);
    assert.equal(review(inst, ['accept', b!]).code, 0);
    assert.equal(review(inst, ['reject', c!, '--reason', 'Not useful']).code, 0);
    const row = report(inst).rows.find((x) => x.job === 'selftest')!;
    assert.equal(row.created, 3);
    assert.equal(row.accepted, 1);
    assert.equal(row.edited_accepted, 1);
    assert.equal(row.rejected, 1);
    assert.deepEqual(row.rejected_reasons, { 'not useful': 1 });
    assert.ok(row.median_review_ms !== null && row.median_review_ms > 0);
  });
});

describe('cognition report --check (kill criteria)', () => {
  const specs = (accepted: number, rejected: number): Spec[] => [
    ...Array.from({ length: accepted }, (_, i): Spec => ({ job: 'forget', version: 1, where: 'applied', reviewedAfterH: i + 1 })),
    ...Array.from({ length: rejected }, (_, i): Spec => ({ job: 'forget', version: 1, where: 'rejected', reviewedAfterH: i + 1, reason: 'too new' })),
  ];

  it('exits non-zero (3) when a job is below its threshold', async () => {
    const inst = setup();
    fixtureRecords(inst, specs(2, 10));
    const r = await runCognition(['report', '--check'], { env: inst.env });
    assert.equal(r.code, REPORT_BELOW_THRESHOLD);
    assert.equal(REPORT_BELOW_THRESHOLD, 3);
    assert.match(r.stdout, /forget v1: 2\/12 accepted \(17%\); threshold 30% over the last 50, at least 10 reviewed: BELOW THRESHOLD/);
    assert.match(r.stderr, /below kill threshold: forget v1/);
    assert.equal((await runCognition(['report'], { env: inst.env })).code, 0, 'without --check the report never fails');
  });

  it('exits 0 when every job is at or above its threshold, or has too few reviews', async () => {
    const ok = setup();
    fixtureRecords(ok, specs(4, 6));
    const r = await runCognition(['report', '--check'], { env: ok.env });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /forget v1: 4\/10 accepted \(40%\).*: ok/);
    const few = setup();
    fixtureRecords(few, specs(0, 9));
    const f = await runCognition(['report', '--check'], { env: few.env });
    assert.equal(f.code, 0);
    assert.match(f.stdout, /forget v1: 0\/9 accepted; .*not enough reviews yet/);
  });

  it('only the last `window` reviews of the current version count', () => {
    const inst = setup();
    // Old rejections, then recent acceptances: with a window of 4, the job is fine.
    fixtureRecords(inst, [
      ...Array.from({ length: 6 }, (_, i): Spec => ({ job: 'forget', version: 1, where: 'rejected', reviewedAfterH: i + 1 })),
      ...Array.from({ length: 4 }, (_, i): Spec => ({ job: 'forget', version: 1, where: 'applied', reviewedAfterH: 100 + i })),
      ...Array.from({ length: 5 }, (): Spec => ({ job: 'forget', version: 9, where: 'rejected' })),
    ]);
    const c = report(inst, { forget: { minAcceptanceRate: 0.5, window: 4, minReviewed: 3 } }).checks;
    assert.deepEqual(c.map((x) => [x.job, x.reviewed, x.accepted, x.verdict]), [['forget', 4, 4, 'ok']]);
    const all = report(inst, { forget: { minAcceptanceRate: 0.5, window: 50, minReviewed: 3 } }).checks[0]!;
    assert.deepEqual([all.reviewed, all.accepted, all.verdict], [10, 4, 'below']);
  });

  it('docs/COGNITION-EVAL.md states the same per-job thresholds as the code', () => {
    const md = fs.readFileSync(path.join(repoRoot(), 'docs', 'COGNITION-EVAL.md'), 'utf8');
    const rows = new Map<string, number[]>();
    for (const m of md.matchAll(/^\| `([a-z]+)` \| (\d+)% \| (\d+) \| (\d+) \|/gm)) rows.set(m[1]!, [Number(m[2]), Number(m[3]), Number(m[4])]);
    assert.deepEqual([...rows.keys()].sort(), Object.keys(KILL_CRITERIA).sort());
    for (const [job, c] of Object.entries(KILL_CRITERIA)) assert.deepEqual(rows.get(job), [Math.round(c.minAcceptanceRate * 100), c.window, c.minReviewed], job);
    for (const j of JOBS) if (j.name !== 'selftest') assert.ok(KILL_CRITERIA[j.name] !== undefined, `${j.name} has a kill criterion`);
  });
});

describe('shadow mode', () => {
  it('writes proposals under <stateDir>/shadow/, nothing to _inbox/, and leaves the vault unchanged', async () => {
    const inst = setup();
    selftestNotes(inst, 4);
    // Index once so the checksum below covers a settled vault (the index lives in the state dir anyway).
    assert.equal((await cog(inst, ['run', 'selftest', '--dry-run'])).code, 0);
    const before = treeChecksum(inst.vault);
    const r = await cog(inst, ['run', 'selftest', '--shadow']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /shadow: proposals written to <stateDir>\/shadow\//);
    assert.match(r.stdout, /proposals: 4 written to <stateDir>\/shadow\//);
    assert.equal(treeChecksum(inst.vault), before, 'vault unchanged');
    assert.equal(fs.existsSync(path.join(inst.vault, '_inbox')), false, 'no _inbox/ created');

    const run = listRunRecords(ensurePrivateDir(inst.stateDir))[0]!;
    assert.equal(run.options.shadow, true);
    assert.deepEqual(run.proposals, [], 'shadow proposals are never recorded as real ones');
    assert.equal(run.shadow_proposals?.length, 4);
    const shadowDir = path.join(inst.stateDir, 'shadow', run.run_id);
    assert.deepEqual(fs.readdirSync(shadowDir).sort(), run.shadow_proposals!.map((p) => `${p.id}.md`).sort());
    assert.equal(fs.statSync(path.join(shadowDir, fs.readdirSync(shadowDir)[0]!)).mode & 0o777, 0o600);

    // A shadow proposal copied into the inbox by hand is not authenticated.
    const id = run.shadow_proposals![0]!.id;
    write(inst, `_inbox/copied.md`, fs.readFileSync(path.join(shadowDir, `${id}.md`), 'utf8'));
    const acc = review(inst, ['accept', id]);
    assert.equal(acc.code, 1);
    assert.match(acc.stderr, /not written by a recorded cognition run/);
    fs.rmSync(path.join(inst.vault, '_inbox'), { recursive: true });

    // The owner later demotes two notes by hand: report matches them.
    handSet(inst, 'notes/n1.md', 'status', 'stale');
    handSet(inst, 'notes/n3.md', 'status', 'archived');
    const rep = await runCognition(['report'], { env: inst.env });
    assert.equal(rep.code, 0, rep.stderr);
    assert.match(rep.stdout, /selftest v1: 1 runs, 4 proposals, 2 later done by hand \(50%\)/);
    assert.match(rep.stdout, /no proposals recorded yet/, 'shadow proposals are not created proposals');
    assert.match((await cog(inst, ['runs'])).stdout, /shadow \(4 proposals\)/);
  });

  it('refuses --shadow with --dry-run and ignores flood control', async () => {
    const inst = setup({ inbox: { maxPendingProposals: 1 } });
    selftestNotes(inst, 3);
    assert.equal((await cog(inst, ['run', 'selftest', '--shadow', '--dry-run'])).code, 2);
    const r = await cog(inst, ['run', 'selftest', '--shadow']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /proposals: 3 written/);
    assert.match(r.stdout, /stop: complete/);
    const m = await cog(inst, ['run', 'selftest', '--shadow', '--max-proposals', '2']);
    assert.match(m.stdout, /proposals: 2 written/);
    assert.match(m.stdout, /stop: max-proposals/);
  });
});

// ---- replay ----

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=owner@example.invalid', '-c', 'user.name=Owner', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function commit(cwd: string, msg: string, date: string): string {
  execFileSync('git', ['-c', 'user.email=owner@example.invalid', '-c', 'user.name=Owner', '-c', 'commit.gpgsign=false', 'commit', '-qam', msg, '--allow-empty'], {
    cwd, env: { PATH: process.env['PATH'] ?? '', HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(cwd, 'rev-parse', 'HEAD');
}

function replayDirs(): string[] {
  return fs.readdirSync(fs.realpathSync(os.tmpdir())).filter((n) => n.startsWith('ebrain-replay-'));
}

/**
 * A git vault: commit 1 (2026-03-01) has 4 selftest notes and the Postgres/SQLite
 * pair; commit 2 (2026-07-01) is the owner's later work: notes 1 and 2 demoted,
 * the Postgres note superseded, a new selftest note (not a later action).
 */
function gitVault(): { inst: Inst; c1: string; c2: string } {
  const inst = setup({ cognition: { maxProposalsPerRun: 200, supersede: { maxUnadjudicated: 10 } } });
  selftestNotes(inst, 4);
  note(inst, 'notes/db-postgres.md', { id: 'db_old', title: 'Database choice', occurred: '2026-02-10', kind: 'decision', tags: '[database]' }, 'We use Postgres for the main database. It runs on the shared host.\n');
  note(inst, 'notes/db-sqlite.md', { id: 'db_new', title: 'Database migration', occurred: '2026-02-20', kind: 'decision', tags: '[database]' }, 'We moved to SQLite for the main database. Postgres was retired.\n');
  git(inst.vault, 'init', '-q');
  git(inst.vault, 'add', '-A');
  const c1 = commit(inst.vault, 'one', '2026-03-01T00:00:00Z');
  handSet(inst, 'notes/n1.md', 'status', 'stale');
  handSet(inst, 'notes/n2.md', 'status', 'stale');
  handSet(inst, 'notes/db-postgres.md', 'status', 'superseded');
  note(inst, 'notes/n5.md', { id: 'note_5', title: 'Note 5', created: '2026-06-01', tags: '[ebrain-selftest]' });
  git(inst.vault, 'add', '-A');
  const c2 = commit(inst.vault, 'two', '2026-07-01T00:00:00Z');
  return { inst, c1, c2 };
}

describe('eval replay', () => {
  it('reports expected counts against later actions and leaves the owner repository, working tree, and state dir unchanged', async () => {
    const { inst, c1 } = gitVault();
    const vaultSum = treeChecksum(inst.vault); // includes .git
    const stateBefore = treeChecksum(inst.stateDir);
    const dirsBefore = replayDirs();

    const r = await runEval(['replay', '--job', 'selftest', '--at', c1], { env: inst.env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`replay selftest v1 at ${c1.slice(0, 12)}`));
    assert.match(r.stdout, /shadow run: 4 proposals/);
    assert.match(r.stdout, /later owner actions: 1 superseded, 0 merged, 0 archived, 2 demoted, 0 lesson, 0 summary/);
    assert.match(r.stdout, /precision: 2 of 4 proposals match a later action \(50%\)/);
    assert.match(r.stdout, /recall: 2 of 2 later actions were proposed \(100%\)/);

    // A real job: supersede (no LLM: unadjudicated) proposes the Postgres -> SQLite pair, which the owner later did.
    const s = await runEval(['replay', '--job', 'supersede', '--at', '2026-04-01'], { env: inst.env });
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /shadow run: 1 proposals/);
    assert.match(s.stdout, /precision: 1 of 1 proposals match/);
    assert.match(s.stdout, /recall: 1 of 1 later actions were proposed/);

    // gaps proposes nothing a later action could confirm.
    const g = await runEval(['replay', '--job', 'gaps', '--at', c1], { env: inst.env });
    assert.equal(g.code, 0, g.stderr);
    assert.match(g.stdout, /precision and recall do not apply/);

    assert.equal(treeChecksum(inst.vault), vaultSum, 'vault working tree and .git unchanged');
    assert.equal(git(inst.vault, 'status', '--porcelain'), '');
    assert.equal(treeChecksum(inst.stateDir), stateBefore, "the owner's state dir is not written");
    assert.deepEqual(replayDirs(), dirsBefore, 'temporary directories removed');
  });

  it('resolves --at dates to the newest earlier commit and refuses unknown commits and early dates', async () => {
    const { inst } = gitVault();
    const late = await runEval(['replay', '--job', 'selftest', '--at', '2026-08-01'], { env: inst.env });
    assert.equal(late.code, 0, late.stderr);
    assert.match(late.stdout, /shadow run: 3 proposals/, 'at HEAD: notes 3, 4, 5 are still proposable');
    assert.match(late.stdout, /recall: 0 of 0/);
    const early = await runEval(['replay', '--job', 'selftest', '--at', '2025-01-01'], { env: inst.env });
    assert.equal(early.code, 1);
    assert.match(early.stderr, /no commit at or before 2025-01-01/);
    const bad = await runEval(['replay', '--job', 'selftest', '--at', 'nosuchref'], { env: inst.env });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /not a commit/);
    assert.equal((await runEval(['replay', '--job', 'selftest', '--at', '--output=/tmp/x'], { env: inst.env })).code, 2);
    assert.equal((await runEval(['replay', '--job', 'nope', '--at', 'HEAD'], { env: inst.env })).code, 2);
    assert.equal((await runEval(['replay', '--at', 'HEAD'], { env: inst.env })).code, 2);
  });

  it('without git, exits with the documented message that only online metrics are available', async () => {
    const inst = setup();
    selftestNotes(inst, 2);
    const before = treeChecksum(inst.vault);
    const r = await runEval(['replay', '--job', 'selftest', '--at', 'HEAD'], { env: inst.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /replay evaluation needs the vault in a git repository with a clean history \(.*not in a git repository\); only online metrics are available: ebrain cognition report/);
    assert.equal(treeChecksum(inst.vault), before);
  });

  it('refuses a dirty working tree (uncommitted changes to tracked files)', async () => {
    const { inst, c1 } = gitVault();
    handSet(inst, 'notes/n3.md', 'status', 'stale');
    const r = await runEval(['replay', '--job', 'selftest', '--at', c1], { env: inst.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /1 tracked file\(s\) under the vault have uncommitted changes; .*only online metrics are available/);
  });

  it('git arguments that look like options are never resolved', () => {
    const { inst } = gitVault();
    assert.equal(resolveCommit(inst.vault, '--all'), undefined);
    assert.equal(resolveCommit(inst.vault, '-n1'), undefined);
    assert.match(resolveCommit(inst.vault, 'HEAD~1') ?? '', /^[0-9a-f]{40}$/);
  });
});

// ---- tar reader and temp dirs ----

function tarHeader(name: string, size: number, type: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function tarOf(entries: { name: string; data?: string; type?: string; link?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    parts.push(tarHeader(e.name, data.length, e.type ?? '0', e.link ?? ''), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe('tar reader and temporary directories', () => {
  it('extracts files and directories, skips links, honors pax paths', () => {
    const root = makeTempDir('ebrain-test-');
    try {
      const long = `${'d'.repeat(120)}/note.md`;
      const pax = `${(` path=${long}\n`.length + String(` path=${long}\n`.length).length)} path=${long}\n`;
      const r = extractTar(tarOf([
        { name: 'notes/', type: '5' },
        { name: 'notes/a.md', data: 'A' },
        { name: 'evil', type: '2', link: '/etc' },
        { name: 'hard', type: '1', link: 'notes/a.md' },
        { name: 'PaxHeader', data: pax, type: 'x' },
        { name: 'truncated-name', data: 'L' },
      ]), root);
      assert.deepEqual(r, { files: 2, dirs: 1, skipped: 2 });
      assert.equal(fs.readFileSync(path.join(root, 'notes/a.md'), 'utf8'), 'A');
      assert.equal(fs.readFileSync(path.join(root, long), 'utf8'), 'L');
      assert.equal(fs.existsSync(path.join(root, 'evil')), false);
    } finally {
      removeTempDir(root);
    }
    assert.equal(fs.existsSync(root), false);
  });

  it('refuses unsafe names, bad checksums, and truncation', () => {
    const root = makeTempDir('ebrain-test-');
    try {
      for (const name of ['../escape.md', '/abs.md', 'a/../../b.md']) {
        assert.throws(() => extractTar(tarOf([{ name, data: 'x' }]), root), TarError, name);
      }
      const t = tarOf([{ name: 'ok.md', data: 'x' }]);
      const bad = Buffer.from(t);
      bad[0] = 0x5a;
      assert.throws(() => extractTar(bad, root), /checksum/);
      assert.throws(() => extractTar(tarOf([{ name: 'big.md', data: 'y'.repeat(600) }]).subarray(0, 700), root), /truncated/);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      removeTempDir(root);
    }
  });

  it('removeTempDir refuses anything makeTempDir did not create', () => {
    const inst = setup();
    assert.throws(() => removeTempDir(ensurePrivateDir(inst.stateDir)), SafePathError);
    assert.throws(() => makeTempDir('../x-'), SafePathError);
    assert.ok(fs.existsSync(inst.stateDir));
  });
});

// ---- outcome matcher ----

function facts(entries: Partial<NoteFacts>[]): Map<string, NoteFacts> {
  return new Map(entries.map((e) => [e.id!, { path: `notes/${e.id}.md`, status: null, kind: null, timeMs: undefined, merged_into: null, cites: new Set<string>(), ...e } as NoteFacts]));
}

describe('outcome matcher', () => {
  const lessonContent = '---\nkind: lesson\nstatus: accepted\n---\nLesson.\n';
  it('derives later actions from two snapshots', () => {
    const before = facts([{ id: 'a' }, { id: 'b' }, { id: 'c', status: 'stale' }, { id: 'd' }]);
    const after = facts([
      { id: 'a', status: 'superseded' }, { id: 'b', status: 'archived', merged_into: 'x' }, { id: 'c', status: 'stale' }, { id: 'd', status: 'archived' },
      { id: 'l', kind: 'lesson' }, { id: 'n', kind: 'note' },
    ]);
    assert.deepEqual(laterActions(before, after).map((x) => `${x.kind}:${x.id}`), ['superseded:a', 'merged:b', 'archived:d', 'lesson:l']);
  });

  it('matches structurally on targets and on created-note kind plus shared citations', () => {
    const before = facts([{ id: 'a' }, { id: 'b' }]);
    const after = facts([
      { id: 'a', status: 'archived' }, { id: 'b' },
      { id: 'l', kind: 'lesson', cites: new Set(['thesis:th_1']) }, { id: 'm', kind: 'lesson', cites: new Set(['thesis:th_2']) },
    ]);
    const base = { created: '2026-01-01T00:00:00Z', targets: [], evidence: ['thesis:th_1', 'note:a@0123456789abcdef'] };
    assert.deepEqual(matchProposal({ ...base, proposal_type: 'demote', ops: [{ op: 'set_frontmatter', target: 'a', key: 'status', value: 'stale' }] }, after, before).map((x) => x.id), ['a']);
    assert.deepEqual(matchProposal({ ...base, proposal_type: 'demote', ops: [{ op: 'set_frontmatter', target: 'b', key: 'status', value: 'stale' }] }, after, before), []);
    assert.deepEqual(matchProposal({ ...base, proposal_type: 'lesson', ops: [{ op: 'create_note', path: 'lessons/t/x.md', content: lessonContent }] }, after, before).map((x) => x.id), ['l']);
    // Without a before snapshot, a status already present counts; new notes must be no older than the proposal (one day of slack).
    assert.deepEqual(matchProposal({ ...base, proposal_type: 'archive', ops: [{ op: 'move_note', target: 'a', to: '_archive/notes/a.md' }] }, after).map((x) => x.id), ['a']);
    const old = facts([{ id: 'l', kind: 'lesson', cites: new Set(['thesis:th_1']), timeMs: Date.parse('2025-06-01') }]);
    assert.deepEqual(matchProposal({ ...base, proposal_type: 'lesson', ops: [{ op: 'create_note', path: 'lessons/t/x.md', content: lessonContent }] }, old), []);
  });
});
