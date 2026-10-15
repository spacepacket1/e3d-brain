// Cognition Phase 4: the `supersede` job. Covered: shingle Jaccard and
// verbatim quote checks; candidate generation (shared non-trivial tag,
// mutual wikilink, same kind plus text overlap; differing dates; pinned
// older notes never superseded; provisional and undated notes skipped);
// adjudication against the mock OpenAI-compatible server (supersedes,
// conflicts -> gap report, compatible/unrelated -> nothing, quotes that are
// not verbatim dropped and counted); the unadjudicated path without a
// provider (needs_review, capped); the Postgres -> SQLite fixture end to end
// (accept sets the fields on both notes, search hides the old note by
// default and shows it with as_of March, undo restores both byte for byte);
// idempotent re-runs and rejection memory; a fixture corpus of 20 positive
// and 22 negative pairs; and config validation.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCognition } from '../src/cli/cognition-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { runIds } from '../src/cli/undo-commands.js';
import { quoteAppears } from '../src/cognition/jobs/supersede.js';
import { listRunRecords, type RunRecord } from '../src/cognition/runs.js';
import { jaccard, shingles } from '../src/cognition/shingle.js';
import { ConfigError, parseConfig, type Config } from '../src/config.js';
import { dispatch } from '../src/mcp/dispatch.js';
import { createMcpRuntime } from '../src/mcp/server.js';
import { parseProposal, type ProposalTarget } from '../src/review/proposal.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { realTmpDir, rmrf } from './helpers.js';
import { startLlmMock, type LlmMock } from './llm-mock-server.js';

const bases: string[] = [];
let llm: LlmMock;
before(async () => {
  llm = await startLlmMock();
});
after(async () => {
  for (const b of bases) rmrf(b);
  await llm.close();
});

const NOW = new Date('2026-10-14T12:00:00Z');

interface Inst {
  vault: string;
  stateDir: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  config: Config;
}

function setup(opts: { llm?: boolean; extra?: Record<string, unknown> } = {}): Inst {
  const base = realTmpDir('ebrain-cog4-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const raw: Record<string, unknown> = {
    vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox',
    inbox: { maxPendingProposals: 200 }, cognition: { maxProposalsPerRun: 200 },
    ...(opts.llm === true ? { llm: { provider: 'openai-compatible', model: 'mock-1', baseUrl: `${llm.url}/v1`, maxCallsPerRun: 200 } } : {}),
    ...opts.extra,
  };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  return { vault, stateDir, configPath, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '' }, config: parseConfig(raw) };
}

interface NoteSpec {
  title: string;
  occurred?: string;
  kind?: string;
  tags?: string[];
  pinned?: boolean;
  status?: string;
}

function note(inst: Inst, rel: string, spec: NoteSpec, body: string): void {
  const fm = [`title: ${spec.title}`];
  if (spec.occurred !== undefined) fm.push(`occurred: ${spec.occurred}`);
  if (spec.kind !== undefined) fm.push(`kind: ${spec.kind}`);
  if (spec.tags !== undefined) fm.push(`tags: [${spec.tags.join(', ')}]`);
  if (spec.pinned === true) fm.push('pinned: true');
  if (spec.status !== undefined) fm.push(`status: ${spec.status}`);
  fs.mkdirSync(path.dirname(path.join(inst.vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(inst.vault, rel), `---\n${fm.join('\n')}\n---\n${body}`);
}

const read = (inst: Inst, rel: string): Buffer => fs.readFileSync(path.join(inst.vault, rel));
const fmOf = (inst: Inst, rel: string): Record<string, unknown> => parseYaml(splitFrontmatter(read(inst, rel).toString('utf8')).yaml ?? '') as Record<string, unknown>;

function ids(inst: Inst): void {
  const r = runIds(['assign'], { env: inst.env, now: () => NOW });
  assert.equal(r.code, 0, r.stderr);
}

let tick = 0;
const cog = (inst: Inst, args: string[]) => {
  const at = new Date(NOW.getTime() + ++tick * 1000);
  return runCognition(args, { env: inst.env, now: () => at });
};
const review = (inst: Inst, args: string[]) => runReview(args, { env: inst.env, now: () => NOW });
const lastRun = (inst: Inst): RunRecord => listRunRecords(ensurePrivateDir(inst.stateDir))[0]!;

interface ProposalFile {
  path: string;
  fm: Record<string, unknown>;
  text: string;
}

function proposals(inst: Inst, dir = '_inbox'): ProposalFile[] {
  const abs = path.join(inst.vault, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => {
    const text = fs.readFileSync(path.join(abs, n), 'utf8');
    return { path: `${dir}/${n}`, fm: parseYaml(splitFrontmatter(text).yaml ?? '') as Record<string, unknown>, text };
  });
}

const targetPaths = (p: ProposalFile): string[] => (p.fm['targets'] as ProposalTarget[]).map((t) => t.path_at_proposal);

/** The Postgres (March) -> SQLite (June) fixture. */
function dbFixture(inst: Inst, opts: { pinOld?: boolean; directive?: string } = {}): void {
  note(inst, 'notes/db-postgres.md', { title: 'Database choice', occurred: '2026-03-10', kind: 'decision', tags: ['database'], ...(opts.pinOld === true ? { pinned: true } : {}) },
    'We use Postgres for the main database. It runs on the shared host.\n');
  note(inst, 'notes/db-sqlite.md', { title: 'Database migration', occurred: '2026-06-20', kind: 'decision', tags: ['database'] },
    `We moved to SQLite for the main database. Postgres was retired.\n<!-- mock:${opts.directive ?? 'supersedes'} -->\n`);
}

async function searchPaths(inst: Inst, args: Record<string, unknown>): Promise<string[]> {
  const rt = createMcpRuntime({ config: inst.config, configPath: inst.configPath });
  try {
    const r = await dispatch(rt.ctx, 'search', args);
    assert.notEqual(r.isError, true, r.content[0]!.text);
    const lines = r.content[0]!.text.split('\n');
    const open = lines.findIndex((l) => /^`{3,}text$/.test(l));
    if (open < 0) return [];
    const fence = lines[open]!.slice(0, -4);
    const close = lines.findIndex((l, i) => i > open && l === fence);
    // Proposals in _inbox/ match too; only the notes themselves matter here.
    const paths = lines.slice(open + 1, close).map((l) => String((JSON.parse(l) as Record<string, unknown>)['path']));
    return [...new Set(paths.filter((p) => p.startsWith('notes/')))].sort();
  } finally {
    rt.close();
  }
}

describe('supersede helpers', () => {
  it('shingle Jaccard is deterministic and case/whitespace insensitive', () => {
    const a = shingles('We prefer tabs over spaces in every repository.');
    assert.equal(jaccard(a, shingles('we  PREFER tabs over spaces in every repository')), 1);
    assert.ok(jaccard(a, shingles('We prefer spaces over tabs in every repository.')) < 0.5);
    assert.equal(jaccard(shingles(''), shingles('')), 0);
    assert.deepEqual([...shingles('two words')], ['two words']);
  });

  it('quotes must appear verbatim (whitespace runs compared as one space) and not be fragments', () => {
    const body = 'We use Postgres for the main\ndatabase. It runs on the shared host.';
    assert.equal(quoteAppears('We use Postgres for the main database.', body), true);
    assert.equal(quoteAppears('We use postgres for the main database.', body), false);
    assert.equal(quoteAppears('We used Postgres for the main database.', body), false);
    assert.equal(quoteAppears('We use', body), false);
    assert.equal(quoteAppears('', body), false);
  });
});

describe('cognition run supersede (LLM adjudication)', () => {
  it('Postgres (March) -> SQLite (June): accept sets the fields, search hides the old note, as_of March shows it, undo restores', async () => {
    const inst = setup({ llm: true });
    dbFixture(inst);
    ids(inst);
    const before = { old: read(inst, 'notes/db-postgres.md'), neu: read(inst, 'notes/db-sqlite.md') };
    const oldId = String(fmOf(inst, 'notes/db-postgres.md')['id']);
    const newId = String(fmOf(inst, 'notes/db-sqlite.md')['id']);

    const r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /proposals: 1 created/);
    assert.match(r.stdout, /verdicts: 1 supersedes/);
    const [p] = proposals(inst);
    assert.ok(p);
    assert.equal(p.fm['proposal_type'], 'supersede');
    assert.equal(p.fm['job'], 'supersede');
    assert.equal(p.fm['confidence'], 'unrated');
    assert.equal(p.fm['needs_review'], undefined);
    assert.deepEqual(targetPaths(p), ['notes/db-postgres.md', 'notes/db-sqlite.md']);
    const parsed = parseProposal(p.text);
    // Both notes cited at their revs, with verbatim quotes.
    assert.deepEqual(parsed.meta.evidence, parsed.meta.targets.map((t) => `note:${t.id}@${t.rev}`));
    assert.match(p.text, /> We use Postgres for the main database\./);
    assert.match(p.text, /> We moved to SQLite for the main database\./);
    assert.match(p.text, /Topic signals: tag #database/);
    assert.deepEqual(parsed.ops, [
      { op: 'set_frontmatter', target: oldId, key: 'status', value: 'superseded' },
      { op: 'set_frontmatter', target: oldId, key: 'superseded_by', value: newId },
      { op: 'set_frontmatter', target: oldId, key: 'superseded_at', value: '2026-06-20' },
      { op: 'set_frontmatter', target: oldId, key: 'valid_until', value: '2026-06-20' },
      { op: 'set_frontmatter', target: newId, key: 'supersedes', value: [oldId] },
    ]);
    const rec = lastRun(inst);
    assert.equal(rec.prompt?.id, 'supersede.v1');
    const recText = fs.readFileSync(path.join(inst.stateDir, 'runs', `${rec.run_id}.json`), 'utf8');
    assert.ok(!/Postgres|SQLite|shared host/.test(recText), 'note text in the run record');

    assert.deepEqual(await searchPaths(inst, { query: 'Postgres' }), ['notes/db-postgres.md', 'notes/db-sqlite.md']);
    const acc = review(inst, ['accept', String(p.fm['id'])]);
    assert.equal(acc.code, 0, acc.stderr);
    const oldFm = fmOf(inst, 'notes/db-postgres.md');
    assert.equal(oldFm['status'], 'superseded');
    assert.equal(oldFm['superseded_by'], newId);
    assert.equal(oldFm['superseded_at'], '2026-06-20');
    assert.equal(oldFm['valid_until'], '2026-06-20');
    assert.deepEqual(fmOf(inst, 'notes/db-sqlite.md')['supersedes'], [oldId]);

    assert.deepEqual(await searchPaths(inst, { query: 'Postgres' }), ['notes/db-sqlite.md']);
    assert.ok((await searchPaths(inst, { query: 'Postgres', as_of: '2026-03-15' })).includes('notes/db-postgres.md'), 'as_of March shows the old note');
    assert.ok(!(await searchPaths(inst, { query: 'Postgres', as_of: '2026-07-01' })).includes('notes/db-postgres.md'), 'as_of July hides it');

    // A re-run after accept proposes nothing (the old note is no longer eligible).
    assert.match((await cog(inst, ['run', 'supersede'])).stdout, /proposals: 0 created/);

    const u = review(inst, ['undo', String(p.fm['id'])]);
    assert.equal(u.code, 0, u.stderr);
    assert.deepEqual(read(inst, 'notes/db-postgres.md'), before.old);
    assert.deepEqual(read(inst, 'notes/db-sqlite.md'), before.neu);
    assert.deepEqual(await searchPaths(inst, { query: 'Postgres' }), ['notes/db-postgres.md', 'notes/db-sqlite.md']);
  });

  it('quotes that are not verbatim drop the item (counted); invalid verdicts are counted', async () => {
    const inst = setup({ llm: true });
    dbFixture(inst, { directive: 'badquote' });
    note(inst, 'notes/x-old.md', { title: 'X old', occurred: '2026-01-01', tags: ['xtopic'] }, 'The x service uses port 80 today.\n');
    note(inst, 'notes/x-new.md', { title: 'X new', occurred: '2026-02-01', tags: ['xtopic'] }, 'The x service uses port 8080 now.\n<!-- mock:invalid -->\n');
    ids(inst);
    const r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(proposals(inst).length, 0);
    assert.match(r.stdout, /1 dropped \(quotes not verbatim\), 1 without a valid verdict/);
    const rec = lastRun(inst);
    assert.equal(rec.counts['quotes_unverified'], 1);
    assert.equal(rec.counts['llm_invalid_items'], 1);
  });

  it('unrelated and compatible pairs produce no proposals; conflicts produce a gap report with no change block', async () => {
    const inst = setup({ llm: true });
    note(inst, 'notes/u1.md', { title: 'Lunch', occurred: '2026-01-01', tags: ['team'] }, 'We order pizza on Fridays.\n');
    note(inst, 'notes/u2.md', { title: 'Standup', occurred: '2026-02-01', tags: ['team'] }, 'Standup is at nine.\n<!-- mock:unrelated -->\n');
    note(inst, 'notes/c1.md', { title: 'Editor', occurred: '2026-01-01', tags: ['tools'] }, 'We use vim for editing.\n');
    note(inst, 'notes/c2.md', { title: 'Editor plugins', occurred: '2026-02-01', tags: ['tools'] }, 'The vim setup includes a linter.\n<!-- mock:compatible -->\n');
    note(inst, 'notes/k1.md', { title: 'Deploy day', occurred: '2026-01-01', tags: ['deploy'] }, 'We deploy on Tuesdays only.\n');
    note(inst, 'notes/k2.md', { title: 'Deploy rule', occurred: '2026-02-01', tags: ['deploy'] }, 'We never deploy on Tuesdays.\n<!-- mock:conflicts -->\n');
    ids(inst);
    const r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /verdicts: 0 supersedes, 1 conflicts, 1 compatible, 1 unrelated/);
    const ps = proposals(inst);
    assert.equal(ps.length, 1);
    const gap = ps[0]!;
    assert.equal(gap.fm['proposal_type'], 'gap');
    assert.deepEqual(targetPaths(gap), ['notes/k1.md', 'notes/k2.md']);
    assert.deepEqual(parseProposal(gap.text).ops, []);
    assert.match(gap.text, /> We deploy on Tuesdays only\./);
    assert.match(gap.text, /neither clearly replaces the other/);
    // Accepting the report changes no note.
    const k1 = read(inst, 'notes/k1.md');
    assert.equal(review(inst, ['accept', String(gap.fm['id'])]).code, 0);
    assert.deepEqual(read(inst, 'notes/k1.md'), k1);
    assert.match((await cog(inst, ['run', 'supersede'])).stdout, /proposals: 0 created, 1 already in _inbox\//);
  });

  it('a pinned note is never the superseded side; a pinned newer note may supersede', async () => {
    const inst = setup({ llm: true });
    dbFixture(inst, { pinOld: true });
    note(inst, 'notes/p-old.md', { title: 'Old CI', occurred: '2026-01-01', tags: ['ci'] }, 'Builds run on Jenkins every night.\n');
    note(inst, 'notes/p-new.md', { title: 'New CI', occurred: '2026-05-01', tags: ['ci'], pinned: true }, 'Builds run on GitHub Actions per push.\n<!-- mock:supersedes -->\n');
    ids(inst);
    const r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipped 1 with a pinned older note/);
    const ps = proposals(inst);
    assert.equal(ps.length, 1);
    assert.deepEqual(targetPaths(ps[0]!), ['notes/p-old.md', 'notes/p-new.md']);
    const pinnedId = String(fmOf(inst, 'notes/db-postgres.md')['id']);
    for (const p of ps) for (const op of parseProposal(p.text).ops) assert.ok(!(op.op === 'set_frontmatter' && op.target === pinnedId), 'pinned note targeted');
  });

  it('re-runs are idempotent without new model calls; a rejected pair is not re-proposed unless --reconsider', async () => {
    const inst = setup({ llm: true });
    dbFixture(inst);
    ids(inst);
    assert.match((await cog(inst, ['run', 'supersede'])).stdout, /1 created/);
    const sent = llm.requests.length;
    let r = await cog(inst, ['run', 'supersede']);
    assert.match(r.stdout, /proposals: 0 created, 1 already in _inbox\//);
    assert.equal(llm.requests.length, sent, 'a proposed pair is not sent to the model again');
    assert.equal(proposals(inst).length, 1);

    const p = proposals(inst)[0]!;
    assert.equal(review(inst, ['reject', String(p.fm['id']), '--reason', 'still on Postgres']).code, 0);
    r = await cog(inst, ['run', 'supersede']);
    assert.match(r.stdout, /0 created, 0 already in _inbox\/, 1 previously rejected \(skipped\)/);
    assert.equal(llm.requests.length, sent);
    assert.equal(proposals(inst).length, 0);

    r = await cog(inst, ['run', 'supersede', '--reconsider']);
    assert.match(r.stdout, /1 created/);
    assert.equal(proposals(inst)[0]!.fm['proposal_key'], p.fm['proposal_key']);
  });

  it('mutual wikilinks and same-kind text overlap are topic signals; one-way links, other kinds, and equal dates are not', async () => {
    const inst = setup({ llm: true });
    note(inst, 'notes/la.md', { title: 'Hosting A', occurred: '2026-01-01' }, 'We host on Hetzner. See [[lb]].\n');
    note(inst, 'notes/lb.md', { title: 'Hosting B', occurred: '2026-04-01' }, 'We host on Fly now. See [[la]].\n<!-- mock:supersedes -->\n');
    note(inst, 'notes/oa.md', { title: 'One way A', occurred: '2026-01-01' }, 'Queue is RabbitMQ. See [[ob]].\n');
    note(inst, 'notes/ob.md', { title: 'One way B', occurred: '2026-04-01' }, 'Queue is NATS.\n<!-- mock:supersedes -->\n');
    const pref = 'We prefer short pull requests with one reviewer and squash merges on the main branch';
    note(inst, 'notes/pa.md', { title: 'PR style', occurred: '2026-01-01', kind: 'preference' }, `${pref}.\n`);
    note(inst, 'notes/pb.md', { title: 'PR style update', occurred: '2026-03-01', kind: 'preference' }, `${pref} and two reviewers.\n<!-- mock:supersedes -->\n`);
    note(inst, 'notes/ia.md', { title: 'Idea A', occurred: '2026-01-01', kind: 'idea' }, `${pref}.\n`);
    note(inst, 'notes/ib.md', { title: 'Idea B', occurred: '2026-03-01', kind: 'idea' }, `${pref} again.\n<!-- mock:supersedes -->\n`);
    note(inst, 'notes/sa.md', { title: 'Same day A', occurred: '2026-02-02', tags: ['sameday'] }, 'The office opens at eight.\n');
    note(inst, 'notes/sb.md', { title: 'Same day B', occurred: '2026-02-02', tags: ['sameday'] }, 'The office opens at nine.\n<!-- mock:supersedes -->\n');
    ids(inst);
    const r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    const got = proposals(inst).map(targetPaths).sort();
    assert.deepEqual(got, [['notes/la.md', 'notes/lb.md'], ['notes/pa.md', 'notes/pb.md']]);
    assert.match(proposals(inst).find((p) => targetPaths(p)[0] === 'notes/la.md')!.text, /Topic signals: mutual wikilink/);
    assert.match(proposals(inst).find((p) => targetPaths(p)[0] === 'notes/pa.md')!.text, /same kind preference, high text overlap/);
    assert.equal(lastRun(inst).counts['skipped_same_date'], 1);
  });

  it('fixture corpus: 20 positive pairs are proposed, 22 negative pairs are not', async () => {
    const inst = setup({ llm: true });
    for (let i = 0; i < 20; i++) {
      const d = String(i + 1).padStart(2, '0');
      note(inst, `pos/p${d}-old.md`, { title: `Topic ${i} old`, occurred: `2026-01-${d}`, kind: 'decision', tags: [`topic-${i}`] }, `Team ${i} uses tool-old-${i} for job ${i}.\n`);
      note(inst, `pos/p${d}-new.md`, { title: `Topic ${i} new`, occurred: `2026-07-${d}`, kind: 'decision', tags: [`topic-${i}`] }, `Team ${i} switched to tool-new-${i} for job ${i}.\n<!-- mock:supersedes -->\n`);
    }
    const neg = (i: number, a: Partial<NoteSpec>, b: Partial<NoteSpec>, directive: string, dirA = 'neg', bodyB?: string): void => {
      const d = String(i).padStart(2, '0');
      note(inst, `${dirA}/n${d}-a.md`, { title: `Neg ${i} a`, occurred: '2026-02-01', tags: [`neg-${i}`], ...a }, `Negative case ${i} first statement here.\n`);
      note(inst, `neg/n${d}-b.md`, { title: `Neg ${i} b`, occurred: '2026-05-01', tags: [`neg-${i}`], ...b }, bodyB ?? `Negative case ${i} second statement here.\n<!-- mock:${directive} -->\n`);
    };
    for (let i = 0; i < 6; i++) neg(i, {}, {}, 'unrelated');
    for (let i = 6; i < 10; i++) neg(i, {}, {}, 'compatible');
    for (let i = 10; i < 12; i++) neg(i, {}, {}, 'badquote');
    for (let i = 12; i < 14; i++) neg(i, { occurred: '2026-05-01' }, {}, 'supersedes');
    for (let i = 14; i < 16; i++) neg(i, { pinned: true }, {}, 'supersedes');
    neg(16, { tags: ['neg-16-a'] }, { tags: ['neg-16-b'] }, 'supersedes');
    neg(17, { tags: ['todo'] }, { tags: ['todo'] }, 'supersedes');
    neg(18, { status: 'superseded' }, {}, 'supersedes');
    neg(19, {}, {}, 'supersedes', '_inbox');
    note(inst, 'neg/n20-a.md', { title: 'Neg 20 a', tags: ['neg-20'] }, 'Undated statement one.\n');
    note(inst, 'neg/n20-b.md', { title: 'Neg 20 b', occurred: '2026-05-01', tags: ['neg-20'] }, 'Undated statement two.\n<!-- mock:supersedes -->\n');
    neg(21, {}, {}, 'invalid');
    ids(inst);

    const r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    const ps = proposals(inst).filter((p) => p.fm['job'] === 'supersede');
    const pairs = ps.map((p) => targetPaths(p).join(' -> ')).sort();
    const expected = Array.from({ length: 20 }, (_, i) => {
      const d = String(i + 1).padStart(2, '0');
      return `pos/p${d}-old.md -> pos/p${d}-new.md`;
    }).sort();
    assert.deepEqual(pairs, expected);
    for (const p of ps) assert.equal(p.fm['proposal_type'], 'supersede');
    const c = lastRun(inst).counts;
    assert.equal(c['relation_supersedes'], 22);
    assert.equal(c['relation_unrelated'], 6);
    assert.equal(c['relation_compatible'], 4);
    assert.equal(c['quotes_unverified'], 2);
    assert.equal(c['no_verdict'], 1);
    assert.equal(c['skipped_same_date'], 2);
    assert.equal(c['skipped_pinned'], 2);
    assert.equal(c['skipped_undated'], 1);
    assert.equal(c['candidates'], 20 + 6 + 4 + 2 + 1);

    // Pair order: newer first (the newest positive pair, pos/p20, is the first proposal created).
    const order = (lastRun(inst).proposals).map((x) => ps.find((p) => p.fm['id'] === x.id)!);
    assert.deepEqual(targetPaths(order[0]!), ['pos/p20-old.md', 'pos/p20-new.md']);
    assert.deepEqual(targetPaths(order.at(-1)!), ['pos/p01-old.md', 'pos/p01-new.md']);
  });
});

describe('cognition run supersede (no LLM provider)', () => {
  it('candidates become needs_review: unadjudicated proposals, up to the cap; provisional ids are skipped first', async () => {
    const inst = setup({ extra: { cognition: { maxProposalsPerRun: 200, supersede: { maxUnadjudicated: 2 } } } });
    dbFixture(inst);
    for (const t of ['a', 'b']) {
      note(inst, `notes/${t}-old.md`, { title: `${t} old`, occurred: '2026-01-01', tags: [`t-${t}`] }, `The ${t} plan is version one.\n`);
      note(inst, `notes/${t}-new.md`, { title: `${t} new`, occurred: '2026-02-01', tags: [`t-${t}`] }, `The ${t} plan is version two.\n`);
    }
    let r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /6 notes have only a provisional id and were skipped; run: ebrain ids assign/);
    assert.equal(proposals(inst).length, 0);
    ids(inst);

    r = await cog(inst, ['run', 'supersede']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /proposals: 2 created/);
    assert.match(r.stdout, /no LLM provider: .*1 pairs over the cap/);
    const ps = proposals(inst);
    assert.equal(ps.length, 2);
    for (const p of ps) {
      assert.equal(p.fm['proposal_type'], 'supersede');
      assert.equal(p.fm['needs_review'], 'unadjudicated');
      assert.equal(parseProposal(p.text).meta.needs_review, 'unadjudicated');
      assert.match(p.text, /Needs review \(unadjudicated\)/);
    }
    // Newest pair first: the June database pair leads.
    const db = ps.find((p) => targetPaths(p)[0] === 'notes/db-postgres.md');
    assert.ok(db);
    assert.match(db.text, /> We use Postgres for the main database\. It runs on the shared host\./);
    assert.equal(lastRun(inst).provider, null);
    const show = review(inst, ['show', String(db.fm['id'])]);
    assert.match(show.stdout, /NEEDS REVIEW \(unadjudicated\)/);

    // Idempotent; the remaining pair comes next once the cap allows.
    r = await cog(inst, ['run', 'supersede']);
    assert.match(r.stdout, /1 created, 2 already in _inbox\//);
    assert.match((await cog(inst, ['run', 'supersede'])).stdout, /0 created, 3 already in _inbox\//);
  });
});

describe('supersede config', () => {
  it('cognition.supersede.minJaccard and maxUnadjudicated have defaults and are validated', () => {
    const base = { vaultPath: '/tmp/v', stateDir: '/tmp/s', principal: { id: 'p', type: 'human' }, mode: 'inbox' };
    assert.deepEqual(parseConfig(base).cognition.supersede, { minJaccard: 0.5, maxUnadjudicated: 5 });
    assert.deepEqual(parseConfig({ ...base, cognition: { supersede: { minJaccard: 0.8, maxUnadjudicated: 1 } } }).cognition.supersede, { minJaccard: 0.8, maxUnadjudicated: 1 });
    for (const bad of [{ minJaccard: 0 }, { minJaccard: 1.5 }, { minJaccard: '0.5' }, { maxUnadjudicated: 0 }, { other: 1 }]) {
      assert.throws(() => parseConfig({ ...base, cognition: { supersede: bad } }), ConfigError, JSON.stringify(bad));
    }
    assert.throws(() => parseConfig({ ...base, cognition: { supersede: [] } }), ConfigError);
  });
});
