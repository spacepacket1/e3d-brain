// Cognition Phase 6: the `reflect` job. Covered: structural thesis/outcome
// pairing over an agent vault plus an evidence file (one winning and one
// losing thesis; open, outcome-less, and unknown theses skipped); lessons
// whose citations all resolve; lessons citing an unknown `outcome:` id,
// holding an unsupported number, or tripping a guardrail dropped and
// counted; the guardrail and numeric-token corpus (20+ kept, 20+ dropped);
// refusal without an evidence source (nothing created) and without a
// provider; accept writing `lessons/<principal>/` with structured
// `derived_from` at T1, and undo removing only what accept created; a
// contradicting existing lesson yielding a supersede proposal, not a second
// lesson; taint from `untrusted_origin` entries; the `review show` advisory
// banner; idempotence; the human-brain decision variant; config validation.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { runCognition } from '../src/cli/cognition-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { CitationResolver } from '../src/cite/resolve.js';
import { guardrailViolation, numericTokens, unsupportedNumbers } from '../src/cognition/jobs/reflect.js';
import { listRunRecords, type RunRecord } from '../src/cognition/runs.js';
import { ConfigError, parseConfig } from '../src/config.js';
import { openEvidence } from '../src/evidence/store.js';
import { noteLookup } from '../src/index/identity.js';
import { closeIndex, openIndex, refreshIndex } from '../src/index/indexer.js';
import { effectiveTier } from '../src/index/rank.js';
import { parseChangeJson, ProposalError, type ProposalTarget } from '../src/review/proposal.js';
import { LESSON_BANNER } from '../src/review/queue.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { folderClass } from '../src/vault/names.js';
import { revOf, splitFrontmatter } from '../src/vault/parse.js';
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
const PRINCIPAL = 'trader';

interface Inst {
  vault: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

function setup(opts: { llm?: boolean; evidence?: boolean; type?: 'agent' | 'human'; extra?: Record<string, unknown> } = {}): Inst {
  const base = realTmpDir('ebrain-cog6-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const raw: Record<string, unknown> = {
    vaultPath: vault, stateDir, principal: { id: PRINCIPAL, type: opts.type ?? 'agent' }, mode: opts.type === 'human' ? 'inbox' : 'journal',
    inbox: { maxPendingProposals: 500 }, cognition: { maxProposalsPerRun: 500 },
    ...(opts.llm !== false ? { llm: { provider: 'openai-compatible', model: 'mock-1', baseUrl: `${llm.url}/v1`, maxCallsPerRun: 200 } } : {}),
    ...opts.extra,
  };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  parseConfig(raw);
  if (opts.evidence !== false) writeEvidence({ stateDir }, RECORDS);
  return { vault, stateDir, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '' } };
}

const RECORDS: readonly Record<string, unknown>[] = [
  { kind: 'thesis', id: 'th_win', occurred: '2026-09-01T00:00:00Z', summary: 'Expected ETH to outperform BTC over two weeks.', attributes: { status: 'closed' } },
  { kind: 'outcome', id: 'oc_win', occurred: '2026-09-15T00:00:00Z', summary: 'ETH outperformed BTC by 4.2% over two weeks.', attributes: { thesis: 'th_win', result: 'win', metric: '+4.2%' } },
  { kind: 'thesis', id: 'th_loss', occurred: '2026-09-05T00:00:00Z', summary: 'Expected SOL to hold support during the unlock week.', attributes: { status: 'closed' } },
  { kind: 'outcome', id: 'oc_loss', occurred: '2026-09-20T00:00:00Z', summary: 'SOL fell 12% during the unlock week.', attributes: { thesis: 'th_loss', result: 'loss' } },
  { kind: 'thesis', id: 'th_open', occurred: '2026-09-10T00:00:00Z', summary: 'Expected stable yields.', attributes: { status: 'open' } },
  { kind: 'outcome', id: 'oc_open', occurred: '2026-09-25T00:00:00Z', summary: 'Yields held for now.', attributes: { thesis: 'th_open' } },
  { kind: 'thesis', id: 'th_pending', occurred: '2026-09-12T00:00:00Z', summary: 'Expected a quiet weekend.', attributes: { status: 'closed' } },
];

function writeEvidence(inst: Pick<Inst, 'stateDir'>, records: readonly Record<string, unknown>[]): void {
  const dir = path.join(inst.stateDir, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'e3d.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

interface EntrySpec {
  id: string;
  title: string;
  created: string;
  sources: string[];
  tags?: string[];
  untrusted?: boolean;
  kind?: string;
}

function entry(inst: Inst, name: string, spec: EntrySpec, body: string): string {
  const rel = `journal/${PRINCIPAL}/2026/${name}.md`;
  const fm = {
    id: spec.id, schema: 1, title: spec.title, author: PRINCIPAL, origin: 'mcp', created: spec.created, kind: spec.kind ?? 'decision',
    sources: spec.sources, untrusted_origin: spec.untrusted === true, status: 'journal', ...(spec.tags === undefined ? {} : { tags: spec.tags }),
  };
  write(inst, rel, `---\n${stringify(fm)}---\n# ${spec.title}\n\n${body}\n`);
  return rel;
}

function write(inst: Inst, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(inst.vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(inst.vault, rel), text);
}

/** The standard fixture: one winning and one losing thesis, plus skipped cases. */
function fixture(inst: Inst, tokens: { win?: string; loss?: string } = {}): void {
  entry(inst, '20260902-100000-eth-thesis', { id: 'entry_win_1', title: 'ETH over BTC', created: '2026-09-02T10:00:00Z', sources: ['thesis:th_win'], tags: ['eth'] },
    `Opened the ETH over BTC thesis on rotation flows.\n${tokens.win ?? ''}`);
  entry(inst, '20260906-100000-sol-thesis', { id: 'entry_loss_1', title: 'SOL support', created: '2026-09-06T10:00:00Z', sources: ['thesis:th_loss'], tags: ['sol'] },
    `Expecting SOL support to hold through the unlock.\n${tokens.loss ?? ''}`);
  entry(inst, '20260911-100000-yields', { id: 'entry_open_1', title: 'Yields', created: '2026-09-11T10:00:00Z', sources: ['thesis:th_open'] }, 'Watching yields.');
  entry(inst, '20260913-100000-weekend', { id: 'entry_pending_1', title: 'Weekend', created: '2026-09-13T10:00:00Z', sources: ['thesis:th_pending'] }, 'Quiet weekend ahead.');
  entry(inst, '20260914-100000-ghost', { id: 'entry_ghost_1', title: 'Ghost', created: '2026-09-14T10:00:00Z', sources: ['thesis:th_ghost'] }, 'A thesis with no record.');
  write(inst, `journal/${PRINCIPAL}/2026/20260915-100000-no-thesis.md`, `---\nid: entry_plain_1\ntitle: Plain\ncreated: 2026-09-15T10:00:00Z\nstatus: journal\nkind: log\n---\nNo thesis cited.\n`);
}

// Each run starts a minute after the previous one, so run records order by time.
let runs = 0;
const cog = (inst: Inst, args: string[]) => {
  const at = new Date(NOW.getTime() + ++runs * 60_000);
  return runCognition(args, { env: inst.env, now: () => at });
};
const review = (inst: Inst, args: string[]) => runReview(args, { env: inst.env, now: () => NOW });
const lastRun = (inst: Inst): RunRecord => listRunRecords(ensurePrivateDir(inst.stateDir))[0]!;

interface ProposalFile {
  path: string;
  fm: Record<string, unknown>;
  text: string;
}

function proposals(inst: Inst): ProposalFile[] {
  const dir = path.join(inst.vault, '_inbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    return { path: `_inbox/${f}`, text, fm: parseYaml(splitFrontmatter(text).yaml ?? '') as Record<string, unknown> };
  });
}

function opsOf(p: ProposalFile) {
  const m = /```ebrain-change\n([\s\S]*?)\n```/.exec(p.text)!;
  return parseChangeJson(m[1]!, p.fm['proposal_type'] as 'lesson', p.fm['targets'] as ProposalTarget[]);
}

const createdNotes = (p: ProposalFile) => opsOf(p).flatMap((o) => (o.op === 'create_note' ? [{ path: o.path, fm: parseYaml(splitFrontmatter(o.content).yaml ?? '') as Record<string, unknown>, content: o.content }] : []));
const byThesis = (inst: Inst, th: string): ProposalFile[] => proposals(inst).filter((p) => (p.fm['evidence'] as string[]).includes(`thesis:${th}`));

function vaultFiles(inst: Inst, dir = inst.vault, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) vaultFiles(inst, p, out);
    else out.push(path.relative(inst.vault, p));
  }
  return out.sort();
}

describe('reflect guardrails and numeric checks (corpus)', () => {
  const KEPT = [
    'Rotation theses need confirmation from flows before sizing up.',
    'Unlock weeks deserve a wider stop than usual.',
    'Support levels fail more often when supply grows.',
    'A thesis that relies on one signal should be smaller.',
    'Recheck the core assumption when the market regime changes.',
    'Momentum fades quickly after a crowded entry.',
    'Liquidity matters more than narrative over short horizons.',
    'Write down the invalidation level before opening a thesis.',
    'Signals from a single exchange can mislead.',
    'Design the exit before the entry.',
    'Assignment of blame is less useful than a clear timeline.',
    'Expectations around token unlocks were too optimistic.',
    'Relative strength held through the whole period.',
    'The outperformance came from flows, not fundamentals.',
    'Avoid anchoring on the first price target.',
    'Consider correlation before pairing two theses.',
    'Volatility clusters around scheduled events.',
    'Cross-check the narrative with on-chain activity.',
    'A losing thesis still taught the value of patience.',
    'Small positions keep the review honest.',
    'Signage of weakness appeared before the drop.',
  ];
  const DROPPED: [string, string][] = [
    ['See https://example.com for details.', 'url'],
    ['Check www.example.org before acting.', 'url'],
    ['Use ftp://files.example.net to fetch data.', 'url'],
    ['Watch wallet 0x1234abcd5678ef90 closely.', 'address'],
    ['The contract 0xDEADBEEF misbehaved.', 'address'],
    ['Run ```rm -rf``` when in doubt.', 'code'],
    ['Paste ~~~js code~~~ into the console.', 'code'],
    ['Transfer funds to cold storage after a win.', 'action_verb'],
    ['Always sign the permit early.', 'action_verb'],
    ['Signed messages proved the thesis.', 'action_verb'],
    ['Approve the router before the unlock.', 'action_verb'],
    ['Send the balance to the treasury.', 'action_verb'],
    ['Sent tokens arrive late on weekends.', 'action_verb'],
    ['Withdraw liquidity when support breaks.', 'action_verb'],
    ['Withdrew positions too late.', 'action_verb'],
    ['Execute the exit at the first sign of weakness.', 'action_verb'],
    ['Executing early would have helped.', 'action_verb'],
    ['Authorize the agent to rebalance.', 'action_verb'],
    ['Spend less on gas during spikes.', 'action_verb'],
    ['Transferring between venues added risk.', 'action_verb'],
    ['Approving allowances blindly is dangerous.', 'action_verb'],
  ];
  it('keeps 20+ advisory lessons and drops 20+ that hold a URL, address, code fence, or action verb', () => {
    for (const t of KEPT) assert.equal(guardrailViolation(t), undefined, t);
    for (const [t, why] of DROPPED) assert.equal(guardrailViolation(t), why, t);
    assert.ok(KEPT.length >= 20 && DROPPED.length >= 20);
  });

  it('normalizes numeric tokens and finds the unsupported ones', () => {
    assert.deepEqual([...numericTokens('ETH rose 4.2% (+4.20), volume 1,000 vs 05 and 3,5')].sort(), ['1000', '3.5', '4.2', '5']);
    const corpus = numericTokens('outcome:oc_123 ETH outperformed BTC by 4.2% {"metric":"+4.2%"} 2026-09-15T00:00:00.000Z');
    assert.deepEqual(unsupportedNumbers('A 4.2 percent gain on the 15th of 2026, record 123.', corpus), []);
    assert.deepEqual(unsupportedNumbers('A 73 percent drawdown in 3 days', corpus), ['73', '3']);
    // A token is compared whole: 3 is not supported by 123.
    assert.deepEqual(unsupportedNumbers('3', numericTokens('th_123')), ['3']);
  });
});

describe('reflect refuses without ground truth', () => {
  it('exits with a clear message and creates nothing when no evidence source is configured', async () => {
    const inst = setup({ evidence: false });
    fixture(inst);
    const r = await cog(inst, ['run', 'reflect']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /needs an evidence source and none is configured/);
    assert.match(r.stderr, /ebrain evidence import/);
    assert.equal(fs.existsSync(path.join(inst.vault, '_inbox')), false);
    assert.equal(listRunRecords(ensurePrivateDir(inst.stateDir)).length, 0);
    assert.equal(fs.existsSync(path.join(inst.vault, 'lessons')), false);
  });

  it('checks evidence before the provider, and needs a provider when evidence exists', async () => {
    const both = setup({ evidence: false, llm: false });
    fixture(both);
    assert.match((await cog(both, ['run', 'reflect'])).stderr, /needs an evidence source/);
    const noLlm = setup({ llm: false });
    fixture(noLlm);
    const r = await cog(noLlm, ['run', 'reflect']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs an LLM provider/);
    assert.equal(fs.existsSync(path.join(noLlm.vault, '_inbox')), false);
  });
});

describe('reflect on an agent vault with a winning and a losing thesis', () => {
  it('proposes lessons whose citations all resolve; unknown outcomes, unsupported numbers, and guardrail hits are dropped', async () => {
    const inst = setup();
    fixture(inst, { win: '<!-- mock:badoutcome mock:guardrail -->', loss: '<!-- mock:badnumber -->' });
    const r = await cog(inst, ['run', 'reflect']);
    assert.equal(r.code, 0, r.stderr);
    const c = lastRun(inst).counts;
    assert.equal(c['groups'], 2);
    assert.equal(c['skipped_open_thesis'], 1);
    assert.equal(c['skipped_no_outcome'], 1);
    assert.equal(c['skipped_thesis_unresolved'], 1);
    assert.equal(c['lessons_unresolved_citation'], 1);
    assert.equal(c['lessons_unsupported_number'], 1);
    assert.equal(c['guardrail_action_verb'], 1);
    assert.equal(c['lessons_kept'], 2);
    assert.equal(c['created'], 2);
    assert.match(r.stdout, /lessons: 5 proposed by the model, 2 kept/);

    const ps = proposals(inst);
    assert.equal(ps.length, 2);
    for (const p of ps) {
      assert.equal(p.fm['proposal_type'], 'lesson');
      assert.equal(p.fm['job'], 'reflect');
      assert.equal(p.fm['confidence'], 'unrated');
      assert.equal(p.fm['untrusted_origin'], false);
    }
    const [win] = byThesis(inst, 'th_win');
    assert.deepEqual([...(win!.fm['evidence'] as string[])].sort(), ['note:entry_win_1@' + (win!.fm['evidence'] as string[])[0]!.split('@')[1], 'outcome:oc_win', 'thesis:th_win'].sort());
    const winNotes = createdNotes(win!);
    assert.equal(winNotes.length, 1);
    assert.doesNotMatch(win!.text, /oc_missing|73 percent|Transfer funds/);
    const [loss] = byThesis(inst, 'th_loss');
    assert.equal(createdNotes(loss!).length, 1);
    assert.match(createdNotes(loss!)[0]!.content, /SOL fell 12% during the unlock week\./);

    // Every derived_from citation resolves against the index and the evidence file.
    const cfg = parseConfig(JSON.parse(fs.readFileSync(inst.env['EBRAIN_CONFIG']!, 'utf8')));
    const h = openIndex({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) });
    const ev = openEvidence({ config: cfg, stateDir: ensurePrivateDir(inst.stateDir) });
    try {
      refreshIndex(h);
      const resolver = new CitationResolver({ notes: noteLookup(h.db), evidence: ev });
      for (const p of ps) {
        for (const n of createdNotes(p)) {
          const cites = n.fm['derived_from'] as string[];
          assert.ok(cites.some((x) => x.startsWith('note:')) && cites.some((x) => x.startsWith('thesis:')) && cites.some((x) => x.startsWith('outcome:')));
          for (const x of cites) assert.equal(resolver.resolve(x).status, 'resolved', x);
        }
      }
    } finally {
      ev.close();
      closeIndex(h);
    }
    // Run records hold no note or record text.
    const runText = fs.readFileSync(path.join(inst.stateDir, 'runs', `${lastRun(inst).run_id}.json`), 'utf8');
    assert.doesNotMatch(runText, /rotation flows|outperformed|unlock week/);

    // Re-running creates nothing and asks the model nothing.
    const calls = llm.requests.length;
    const again = await cog(inst, ['run', 'reflect']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(lastRun(inst).counts['created'], 0);
    assert.equal(lastRun(inst).counts['duplicates'], 2);
    assert.equal(llm.requests.length, calls);
  });

  it('accept writes the lesson with structured derived_from at T1; undo removes only what accept created', async () => {
    const inst = setup();
    fixture(inst);
    assert.equal((await cog(inst, ['run', 'reflect'])).code, 0);
    const [win] = byThesis(inst, 'th_win');
    const id = win!.fm['id'] as string;
    const show = await review(inst, ['show', id]);
    assert.equal(show.code, 0, show.stderr);
    assert.ok(show.stdout.includes(LESSON_BANNER), 'review show prints the advisory banner');

    const before = vaultFiles(inst).filter((f) => !f.startsWith('_inbox/'));
    const bytes = new Map(before.map((f) => [f, fs.readFileSync(path.join(inst.vault, f))]));
    const acc = await review(inst, ['accept', id]);
    assert.equal(acc.code, 0, acc.stderr);
    const lessonPath = createdNotes(win!)[0]!.path;
    assert.match(lessonPath, new RegExp(`^lessons/${PRINCIPAL}/[a-z0-9-]+-[0-9a-f]{8}\\.md$`));
    const text = fs.readFileSync(path.join(inst.vault, lessonPath), 'utf8');
    const fm = parseYaml(splitFrontmatter(text).yaml ?? '') as Record<string, unknown>;
    assert.equal(fm['status'], 'accepted');
    assert.equal(fm['kind'], 'lesson');
    assert.ok(Array.isArray(fm['derived_from']));
    assert.deepEqual((fm['derived_from'] as string[]).map((x) => x.split(':')[0]), ['note', 'thesis', 'outcome']);
    assert.equal(typeof fm['applies_when'], 'string');
    assert.match(text, /Advisory, unverified/);
    assert.equal(effectiveTier(folderClass(lessonPath).folderClass, fm['status'] as string), 1);
    // Higher than any journal lesson (T3 at best).
    assert.equal(effectiveTier('journal', 'journal', { kind: 'lesson', sources: ['thesis:th_win'] }), 3);
    const after = vaultFiles(inst).filter((f) => !f.startsWith('_inbox/'));
    assert.deepEqual(after, [...before, lessonPath].sort());
    for (const f of before) assert.ok(fs.readFileSync(path.join(inst.vault, f)).equals(bytes.get(f)!), `${f} unchanged`);

    const undo = await review(inst, ['undo', id]);
    assert.equal(undo.code, 0, undo.stderr);
    assert.deepEqual(vaultFiles(inst).filter((f) => !f.startsWith('_inbox/')), before);
    for (const f of before) assert.ok(fs.readFileSync(path.join(inst.vault, f)).equals(bytes.get(f)!), `${f} unchanged after undo`);
    assert.equal(fs.existsSync(path.join(inst.vault, 'lessons', PRINCIPAL)), true, 'undo removes files, never directories it did not record');
  });

  it('a contradicting existing lesson yields a supersede proposal, not a second lesson', async () => {
    const inst = setup();
    fixture(inst, { win: '<!-- mock:conflict -->' });
    write(inst, `lessons/${PRINCIPAL}/eth-rotation.md`,
      '---\nid: lesson_old_1\ntitle: ETH rotation\nkind: lesson\nstatus: accepted\ntags: [eth]\n---\n# ETH rotation\n\nETH never outperforms BTC in a rotation. Avoid the pair.\n');
    const r = await cog(inst, ['run', 'reflect']);
    assert.equal(r.code, 0, r.stderr);
    const win = byThesis(inst, 'th_win');
    assert.equal(win.length, 1);
    const p = win[0]!;
    assert.equal(p.fm['proposal_type'], 'supersede');
    assert.deepEqual((p.fm['targets'] as ProposalTarget[]).map((t) => t.id), ['lesson_old_1']);
    assert.ok((p.fm['evidence'] as string[]).some((x) => x.startsWith('note:lesson_old_1@')));
    assert.match(p.text, /> ETH never outperforms BTC in a rotation\./);
    assert.equal(proposals(inst).filter((x) => x.fm['proposal_type'] === 'lesson' && (x.fm['evidence'] as string[]).includes('thesis:th_win')).length, 0);

    const id = p.fm['id'] as string;
    assert.ok((await review(inst, ['show', id])).stdout.includes(LESSON_BANNER));
    const oldBytes = fs.readFileSync(path.join(inst.vault, `lessons/${PRINCIPAL}/eth-rotation.md`));
    const acc = await review(inst, ['accept', id]);
    assert.equal(acc.code, 0, acc.stderr);
    const created = createdNotes(p)[0]!;
    const newFm = parseYaml(splitFrontmatter(fs.readFileSync(path.join(inst.vault, created.path), 'utf8')).yaml ?? '') as Record<string, unknown>;
    assert.deepEqual(newFm['supersedes'], ['lesson_old_1']);
    const oldFm = parseYaml(splitFrontmatter(fs.readFileSync(path.join(inst.vault, `lessons/${PRINCIPAL}/eth-rotation.md`), 'utf8')).yaml ?? '') as Record<string, unknown>;
    assert.equal(oldFm['status'], 'superseded');
    assert.equal(oldFm['superseded_by'], newFm['id']);
    assert.equal((await review(inst, ['undo', id])).code, 0);
    assert.ok(fs.readFileSync(path.join(inst.vault, `lessons/${PRINCIPAL}/eth-rotation.md`)).equals(oldBytes));
    assert.equal(fs.existsSync(path.join(inst.vault, created.path)), false);
  });

  it('drops a lesson that repeats an existing accepted lesson or another lesson of the run', async () => {
    const inst = setup();
    fixture(inst, { loss: '<!-- mock:dupe -->' });
    write(inst, `lessons/${PRINCIPAL}/win-copy.md`,
      '---\nid: lesson_copy_1\ntitle: Copy\nkind: lesson\nstatus: accepted\n---\n# Copy\n\nRecheck the core assumption of thesis th_win against what happened: ETH outperformed BTC by 4.2% over two weeks.\n');
    assert.equal((await cog(inst, ['run', 'reflect'])).code, 0);
    assert.equal(lastRun(inst).counts['lessons_duplicate'], 2);
    assert.equal(byThesis(inst, 'th_win').length, 0);
    assert.equal(createdNotes(byThesis(inst, 'th_loss')[0]!).length, 1);
  });

  it('flags lessons derived from untrusted_origin entries (C8)', async () => {
    const inst = setup();
    fixture(inst);
    entry(inst, '20260903-100000-eth-rumor', { id: 'entry_win_2', title: 'ETH rumor', created: '2026-09-03T10:00:00Z', sources: ['thesis:th_win'], untrusted: true },
      'A forwarded message claimed rotation flows were starting.');
    assert.equal((await cog(inst, ['run', 'reflect'])).code, 0);
    const [win] = byThesis(inst, 'th_win');
    assert.equal(win!.fm['untrusted_origin'], true);
    assert.ok((win!.fm['taint_sources'] as string[]).some((x) => x.startsWith('note:entry_win_2@')));
    assert.equal(createdNotes(win!)[0]!.fm['untrusted_origin'], true);
    const show = await review(inst, ['show', win!.fm['id'] as string]);
    assert.match(show.stdout, /UNTRUSTED ORIGIN/);
    const [loss] = byThesis(inst, 'th_loss');
    assert.equal(loss!.fm['untrusted_origin'], false);
    assert.equal(createdNotes(loss!)[0]!.fm['untrusted_origin'], undefined);
  });

  it('skips provisional ids and other principals, honours --since, and remembers rejections', async () => {
    const inst = setup();
    fixture(inst);
    write(inst, 'journal/someone/2026/20260902-110000-x.md', '---\nid: other_1\ntitle: Other\ncreated: 2026-09-02T11:00:00Z\nstatus: journal\nsources: [thesis:th_win]\n---\nOther agent.\n');
    write(inst, `journal/${PRINCIPAL}/2026/20260902-120000-noid.md`, '---\ntitle: No id\ncreated: 2026-09-02T12:00:00Z\nstatus: journal\nsources: [thesis:th_loss]\n---\nNo id here.\n');
    assert.equal((await cog(inst, ['run', 'reflect', '--since', '2026-09-18'])).code, 0);
    let c = lastRun(inst).counts;
    assert.equal(c['skipped_provisional'], 1);
    assert.equal(c['skipped_since'], 1);
    assert.equal(proposals(inst).length, 1);
    const [loss] = byThesis(inst, 'th_loss');
    assert.ok(!(loss!.fm['evidence'] as string[]).some((x) => x.includes('other_1')));
    assert.equal((await review(inst, ['reject', loss!.fm['id'] as string, '--reason', 'no'])).code, 0);
    assert.equal((await cog(inst, ['run', 'reflect', '--since', '2026-09-18'])).code, 0);
    c = lastRun(inst).counts;
    assert.equal(c['rejected_skipped'], 1);
    assert.equal(c['created'], 0);
  });
});

describe('reflect human-brain variant (decisions)', () => {
  function decisionVault(inst: Inst): void {
    const dec = '---\nid: dec_db\ntitle: Pick Postgres\nkind: decision\ncreated: 2026-03-01\n---\nWe picked Postgres for the billing service.\n';
    write(inst, 'notes/db-decision.md', dec);
    write(inst, 'notes/db-outcome.md', `---\nid: out_db\ntitle: Postgres after three months\ncreated: 2026-06-01\ntags: [outcome]\nsources: ["note:dec_db@${revOf(dec)}"]\n---\nPostgres handled the billing load without incidents.\n`);
  }

  it('is off by default and, when configured, cites the decision and the outcome note', async () => {
    const off = setup({ type: 'human' });
    decisionVault(off);
    assert.equal((await cog(off, ['run', 'reflect'])).code, 0);
    assert.equal(proposals(off).length, 0);

    const on = setup({ type: 'human', extra: { cognition: { maxProposalsPerRun: 500, reflect: { decisions: true } } } });
    decisionVault(on);
    const r = await cog(on, ['run', 'reflect']);
    assert.equal(r.code, 0, r.stderr);
    const ps = proposals(on);
    assert.equal(ps.length, 1);
    const cites = createdNotes(ps[0]!)[0]!.fm['derived_from'] as string[];
    assert.ok(cites.some((x) => x.startsWith('note:dec_db@')) && cites.some((x) => x.startsWith('note:out_db@')));
  });
});

describe('reflect proposal grammar and config', () => {
  it('a supersede proposal may create a note only under lessons/<principal-id>/', () => {
    const targets = [{ id: 'lesson_old_1', rev: '0123456789abcdef', path_at_proposal: 'lessons/trader/a.md' }];
    const ok = JSON.stringify({ version: 1, ops: [{ op: 'create_note', path: 'lessons/trader/b.md', content: 'x' }] });
    assert.equal(parseChangeJson(ok, 'supersede', targets).length, 1);
    const bad = JSON.stringify({ version: 1, ops: [{ op: 'create_note', path: 'notes/b.md', content: 'x' }] });
    assert.throws(() => parseChangeJson(bad, 'supersede', targets), ProposalError);
  });

  it('validates cognition.reflect', () => {
    const base = { vaultPath: '/tmp/v-reflect', stateDir: '/tmp/s-reflect', principal: { id: 'p', type: 'human' }, mode: 'inbox' };
    assert.deepEqual(parseConfig(base).cognition.reflect, { maxLessons: 3, minDuplicateJaccard: 0.5, decisions: false });
    assert.deepEqual(parseConfig({ ...base, cognition: { reflect: { maxLessons: 5, minDuplicateJaccard: 0.8, decisions: true } } }).cognition.reflect,
      { maxLessons: 5, minDuplicateJaccard: 0.8, decisions: true });
    for (const bad of [{ maxLessons: 0 }, { maxLessons: 11 }, { maxLessons: 1.5 }, { minDuplicateJaccard: 0 }, { minDuplicateJaccard: 2 }, { decisions: 'yes' }, { other: 1 }]) {
      assert.throws(() => parseConfig({ ...base, cognition: { reflect: bad } }), ConfigError, JSON.stringify(bad));
    }
  });
});
