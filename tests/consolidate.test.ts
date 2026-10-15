// Cognition Phase 5: the `consolidate` job. Covered: dedup.ts (fixed-seed
// minhash, LSH candidates confirmed by exact Jaccard, unique-line
// extraction) on a corpus of exact, reworded, reordered, and extended
// duplicates against unrelated notes (false-positive rate <= 2%);
// candidate eligibility (pinned, `_raw/`, other principals' journal
// entries, provisional ids); merge proposals (keep rule, unique content
// under a cited "Merged from" section, C10 archive with merged_into),
// accept never deleting a file and undo restoring both originals byte for
// byte; summary proposals (extractive link list without a provider, LLM
// claims with verbatim quotes, unsupported claims dropped, existing
// summaries not re-proposed); taint from untrusted sources; optional
// cosine neighbours from stored embeddings; idempotence, rejection memory,
// priority order, and config validation.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCognition } from '../src/cli/cognition-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { runIds } from '../src/cli/undo-commands.js';
import { estimateJaccard, findDuplicates, minhash, SEEDS, textShingles, uniqueLines } from '../src/cognition/dedup.js';
import { listRunRecords, type RunRecord } from '../src/cognition/runs.js';
import { ConfigError, parseConfig } from '../src/config.js';
import { closeIndex, openIndex, refreshIndex } from '../src/index/indexer.js';
import { syncEmbeddings } from '../src/index/vectors.js';
import type { Embedder } from '../src/net/ollama.js';
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

/** Unrelated notes (also the bases of the positive fixtures). Each has four or more sentences. */
const TEXTS: readonly string[] = [
  'We deploy the billing API every Friday afternoon after the integration suite passes. Rollbacks use the previous container tag. The on-call engineer watches error rates for one hour. Hotfixes skip the Friday window only with approval from the team lead.',
  'Our coffee machine on the third floor needs descaling every two weeks. Use the white tablets stored in the cabinet under the sink. Run the rinse cycle twice before making a drink. Report broken parts to facilities through the shared form.',
  'The quarterly planning offsite takes place in Lisbon this year. Flights should be booked through the travel portal before the end of the month. Each team prepares a five minute demo of shipped work. Dinner on the second night is at the harbour restaurant.',
  'Password rotation for service accounts happens on the first Monday of each quarter. The vault operator generates new secrets and updates the deployment manifests. Old credentials stay valid for forty eight hours to allow a safe switch. Audit logs record every rotation.',
  'My sourdough starter likes whole rye flour and lukewarm water. Feed it twice a day when the kitchen is warm. A good loaf needs about eighteen hours of cold proofing in the fridge. Bake at high heat in a covered cast iron pot.',
  'The mobile app crashes on Android twelve when the camera permission is revoked mid session. Reproduce by opening the scanner and toggling the permission in settings. The fix is to check permission state on resume. QA should cover tablets as well as phones.',
  'Customer interviews this sprint focus on onboarding friction for small agencies. Ask how long setup took and which step felt confusing. Record calls only with explicit consent. Summaries go into the research board within two days.',
  'The marathon training plan builds weekly mileage by ten percent at most. Long runs happen on Sunday mornings at an easy conversational pace. Every fourth week is a recovery week with reduced volume. Tempo runs start in the second month.',
  'Our office lease renewal is due in March and the landlord proposed a seven percent increase. Finance wants three comparable offers from nearby buildings. A shorter two year term would keep options open. Legal reviews the break clause wording.',
  'Garden notes: tomatoes go in the south bed after the last frost. Basil grows well between the tomato plants and keeps pests away. Water deeply twice a week instead of a little every day. Mulch with straw to keep the soil moist.',
  'The search service uses a nightly reindex job that reads from the primary replica. Large tenants are split into shards of roughly two million documents. Query latency alerts fire above three hundred milliseconds at the ninety fifth percentile. Cache warming runs right after the reindex.',
  'Book club picked a historical novel set in Venice for next month. We meet at the library reading room on the last Thursday. Everyone brings one question for discussion. Snacks rotate alphabetically by first name.',
  'Incident review template: write a timeline, list contributing factors, and record what went well. Avoid blame and name systems rather than people. Action items need an owner and a due date. Publish the review within five working days.',
  'The new design system uses an eight pixel spacing grid and two typefaces. Buttons come in primary, secondary, and ghost variants. Color tokens are defined once and referenced everywhere. Components ship with accessibility notes and keyboard behaviour.',
  'Grandma keeps her recipe for plum dumplings in a blue notebook. The dough uses boiled potatoes, flour, and one egg. Each dumpling hides a whole plum with a sugar cube inside. Serve them rolled in buttered breadcrumbs and cinnamon.',
  'Data retention policy: application logs are kept for thirty days and metrics for thirteen months. Personal data in support tickets is redacted after ninety days. Backups are encrypted and stored in a second region. Deletion requests are handled within one week.',
  'The hiring loop for backend engineers has four stages. A recruiter screen comes first, followed by a take home exercise. The onsite includes system design and a pairing session. Feedback must be submitted within twenty four hours.',
  'Bicycle maintenance checklist: clean and lube the chain every few hundred kilometres. Check tyre pressure before each ride. Replace brake pads when the groove disappears. Have the wheels trued once a season at the local shop.',
  'Our analytics pipeline lands raw events in object storage every five minutes. A batch job compacts them into daily parquet files. Dashboards read from the compacted tables only. Late events older than three days are dropped and counted.',
  'Trip to Kyoto in November: stay near Gion for easy evening walks. Visit the moss temple with an advance reservation by postcard. Rent bicycles to reach the northern shrines. Try the tofu restaurant near the philosopher path.',
  'Feature flags are created in the admin console with an owner and an expiry date. Flags older than ninety days trigger a cleanup reminder. Percentage rollouts start at five percent of traffic. Kill switches must never depend on the flag service itself.',
  'The choir rehearses on Wednesday evenings in the church hall. Sopranos are learning the descant for the winter concert. Bring a pencil to mark breathing points in the score. The concert is on the second Saturday of December.',
  'Database migrations run in a separate pipeline step before the application deploy. Every migration must be backwards compatible with the previous release. Long running index builds use the concurrent option. A dry run against a snapshot happens first.',
  'Weekly review habit: clear the inbox, look at the calendar for the next two weeks, and update project lists. Pick three priorities for the coming week. Archive anything that no longer matters. The review takes about forty minutes on Friday.',
];

const SYNONYMS: Readonly<Record<string, string>> = {
  every: 'each', after: 'once', needs: 'requires', should: 'must', uses: 'relies on', happens: 'takes place', first: 'initial', keep: 'retain',
  new: 'fresh', rehearses: 'practises', bring: 'carry', large: 'big', good: 'solid', twice: 'two times', week: 'seven days', month: 'four weeks', only: 'solely', before: 'prior to',
};

/** Reworded: a few words swapped for synonyms (at most four). */
function reword(t: string): string {
  let n = 0;
  return t.replace(/\b([a-z]+)\b/g, (w) => (SYNONYMS[w] !== undefined && n++ < 4 ? SYNONYMS[w]! : w));
}
/** Reordered: sentences in reverse order. */
const reorder = (t: string): string => t.split(/(?<=\.) /).reverse().join(' ');
/** Extended: one more sentence. */
const extend = (t: string): string => `${t} This was confirmed again at the last team meeting.`;

describe('dedup (deterministic near-duplicate detection)', () => {
  it('minhash uses fixed seeds and is deterministic', () => {
    assert.equal(SEEDS.length, 128);
    assert.equal(new Set(SEEDS).size, 128);
    const a = textShingles(TEXTS[0]!);
    assert.deepEqual(minhash(a), minhash(textShingles(TEXTS[0]!)));
    assert.equal(estimateJaccard(minhash(a), minhash(a)), 1);
    assert.ok(estimateJaccard(minhash(a), minhash(textShingles(TEXTS[1]!))) < 0.1);
    // Normalization: case, punctuation, Markdown, and comments do not matter.
    assert.deepEqual(textShingles('We **deploy** on Fridays, always! <!-- x -->'), textShingles('we deploy on fridays always'));
  });

  it('corpus: exact, reworded, reordered, and extended duplicates are found; unrelated notes are not (FP <= 2%)', () => {
    const items: { key: string; text: string }[] = TEXTS.map((t, i) => ({ key: `base-${String(i).padStart(2, '0')}`, text: t }));
    const positives = new Set<string>();
    const variants: [string, (t: string) => string][] = [['exact', (t) => t], ['reworded', reword], ['reordered', reorder], ['extended', extend]];
    TEXTS.forEach((t, i) => {
      const [name, f] = variants[i % variants.length]!;
      const key = `var-${String(i).padStart(2, '0')}-${name}`;
      items.push({ key, text: f(t) });
      positives.add(`base-${String(i).padStart(2, '0')}\0${key}`);
    });
    for (const [name] of variants) assert.ok([...positives].some((p) => p.endsWith(name)), name);
    for (const it of items) if (/-(reworded|reordered|extended)$/.test(it.key)) assert.notEqual(it.text, TEXTS[Number(it.key.slice(4, 6))], it.key);
    assert.ok(positives.size >= 20);
    const r = findDuplicates(items, { threshold: 0.5 });
    const found = new Set(r.pairs.map((p) => `${p.a}\0${p.b}`));
    for (const p of positives) assert.ok(found.has(p), `missed ${p.replace('\0', ' ~ ')}`);
    // Negatives: every pair of different bases (and their variants): 24*23/2 base pairs.
    const negatives = TEXTS.length * (TEXTS.length - 1) / 2;
    assert.ok(negatives >= 20);
    // Only a base and its own variant share an index, so any other reported pair is a false positive.
    const falsePositives = r.pairs.filter((p) => !positives.has(`${p.a}\0${p.b}`)).length;
    assert.ok(falsePositives / negatives <= 0.02, `false positives: ${falsePositives} of ${negatives}`);
    assert.equal(falsePositives, 0);
    // Deterministic: same pairs, same order, every time.
    assert.deepEqual(findDuplicates([...items].reverse(), { threshold: 0.5 }).pairs, r.pairs);
    for (let i = 1; i < r.pairs.length; i++) assert.ok(r.pairs[i - 1]!.jaccard >= r.pairs[i]!.jaccard);
  });

  it('the threshold is configurable; extra candidates are confirmed by acceptExtra; empty texts are never paired', () => {
    const items = [{ key: 'a', text: TEXTS[2]! }, { key: 'b', text: reword(reorder(TEXTS[2]!)) }, { key: 'c', text: TEXTS[3]! }, { key: 'e', text: '<!-- only -->' }];
    const j = findDuplicates(items, { threshold: 0.01 }).pairs.find((p) => p.a === 'a' && p.b === 'b')!.jaccard;
    assert.equal(findDuplicates(items, { threshold: Math.min(1, j + 0.01) }).pairs.length, 0);
    const extra = findDuplicates(items, { threshold: 0.99, extraPairs: [['c', 'a'], ['e', 'a']], acceptExtra: (a, b) => a === 'a' && b === 'c' });
    assert.deepEqual(extra.pairs.map((p) => [p.a, p.b, p.via]), [['a', 'c', 'extra']]);
    assert.equal(extra.empty, 1);
  });

  it('uniqueLines keeps only lines the base does not already say', () => {
    const base = 'We deploy on Fridays after tests pass.\nRollbacks use the previous tag.\n';
    const other = '# Deploys\n\nwe deploy on fridays after tests pass\nRollbacks use the previous tag!\nCanaries get five percent of traffic first.\n';
    assert.deepEqual(uniqueLines(base, other), ['# Deploys', 'Canaries get five percent of traffic first.']);
    // A heading with nothing new under it is dropped.
    assert.deepEqual(uniqueLines(base, '## Old\nRollbacks use the previous tag.\n## New\nCanaries first.\n'), ['## New', 'Canaries first.']);
  });
});

interface Inst {
  vault: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

function setup(opts: { llm?: boolean; extra?: Record<string, unknown> } = {}): Inst {
  const base = realTmpDir('ebrain-cog5-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  const raw: Record<string, unknown> = {
    vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox',
    inbox: { maxPendingProposals: 500 }, cognition: { maxProposalsPerRun: 500 },
    ...(opts.llm === true ? { llm: { provider: 'openai-compatible', model: 'mock-1', baseUrl: `${llm.url}/v1`, maxCallsPerRun: 200 } } : {}),
    ...opts.extra,
  };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  parseConfig(raw);
  return { vault, stateDir, env: { EBRAIN_CONFIG: configPath, PATH: process.env['PATH'] ?? '' } };
}

interface NoteSpec {
  title: string;
  occurred?: string;
  tags?: string[];
  pinned?: boolean;
  untrusted?: boolean;
  kind?: string;
  status?: string;
}

function note(inst: Inst, rel: string, spec: NoteSpec, body: string): void {
  const fm = [`title: ${spec.title}`];
  if (spec.occurred !== undefined) fm.push(`occurred: ${spec.occurred}`);
  if (spec.tags !== undefined) fm.push(`tags: [${spec.tags.join(', ')}]`);
  if (spec.pinned === true) fm.push('pinned: true');
  if (spec.untrusted === true) fm.push('untrusted_origin: true');
  if (spec.kind !== undefined) fm.push(`kind: ${spec.kind}`);
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
  return runCognition(['run', 'consolidate', ...args], { env: inst.env, now: () => at });
};
const review = (inst: Inst, args: string[]) => runReview(args, { env: inst.env, now: () => NOW });
const lastRun = (inst: Inst): RunRecord => listRunRecords(ensurePrivateDir(inst.stateDir))[0]!;

interface ProposalFile {
  path: string;
  fm: Record<string, unknown>;
  text: string;
}

function proposals(inst: Inst): ProposalFile[] {
  const abs = path.join(inst.vault, '_inbox');
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => {
    const text = fs.readFileSync(path.join(abs, n), 'utf8');
    return { path: `_inbox/${n}`, fm: parseYaml(splitFrontmatter(text).yaml ?? '') as Record<string, unknown>, text };
  });
}

const targetPaths = (p: ProposalFile): string[] => (p.fm['targets'] as ProposalTarget[]).map((t) => t.path_at_proposal);
const ofType = (inst: Inst, t: string): ProposalFile[] => proposals(inst).filter((p) => p.fm['proposal_type'] === t);

/** Every file under the vault (relative paths), excluding _inbox/. */
function vaultFiles(inst: Inst, dir = inst.vault, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(inst.vault, full).split(path.sep).join('/');
    if (rel === '_inbox') continue;
    if (e.isDirectory()) vaultFiles(inst, full, out);
    else out.push(rel);
  }
  return out.sort();
}

describe('cognition run consolidate: merge', () => {
  it('finds exact, reworded, and reordered duplicates with embeddings off; unrelated notes are not flagged', async () => {
    const inst = setup();
    note(inst, 'notes/deploy.md', { title: 'Deploys', occurred: '2026-01-10' }, `${TEXTS[0]}\n`);
    note(inst, 'notes/deploy-copy.md', { title: 'Deploys copy', occurred: '2026-02-10' }, `${TEXTS[0]}\n`);
    note(inst, 'notes/rotation.md', { title: 'Rotation', occurred: '2026-01-10' }, `${TEXTS[3]}\n`);
    note(inst, 'notes/rotation-reworded.md', { title: 'Rotation again', occurred: '2026-03-10' }, `${reword(TEXTS[3]!)}\n`);
    note(inst, 'notes/search.md', { title: 'Search', occurred: '2026-01-10' }, `${TEXTS[10]}\n`);
    note(inst, 'notes/search-reordered.md', { title: 'Search notes', occurred: '2026-04-10' }, `${reorder(TEXTS[10]!)}\n`);
    for (const i of [1, 2, 4, 5, 6, 7, 8, 9]) note(inst, `notes/u${i}.md`, { title: `Unrelated ${i}` }, `${TEXTS[i]}\n`);
    ids(inst);
    const r = await cog(inst, []);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /3 near-duplicate pairs/);
    const merges = ofType(inst, 'merge');
    assert.deepEqual(merges.map(targetPaths).map((t) => [...t].sort()).sort(), [
      ['notes/deploy-copy.md', 'notes/deploy.md'],
      ['notes/rotation-reworded.md', 'notes/rotation.md'],
      ['notes/search-reordered.md', 'notes/search.md'],
    ]);
    for (const p of merges) {
      assert.equal(p.fm['job'], 'consolidate');
      assert.equal(p.fm['confidence'], 'unrated');
      assert.equal(p.fm['untrusted_origin'], false);
    }
    // Priority: highest overlap first (the exact duplicate leads).
    const order = lastRun(inst).proposals.map((x) => merges.find((p) => p.fm['id'] === x.id)!);
    assert.deepEqual(targetPaths(order[0]!), ['notes/deploy.md', 'notes/deploy-copy.md']);
  });

  it('accept keeps the more complete note, appends unique content with a citation, archives the other (C10); never deletes; undo restores both', async () => {
    const inst = setup();
    const extra = 'Canary deploys now get five percent of traffic for ten minutes first.';
    note(inst, 'notes/deploy.md', { title: 'Deploys', occurred: '2026-01-10' }, `${TEXTS[0]}\n`);
    note(inst, 'notes/deploy-v2.md', { title: 'Deploys v2', occurred: '2026-05-10' }, `${TEXTS[0]}\n\n${extra}\n`);
    ids(inst);
    const keepId = String(fmOf(inst, 'notes/deploy-v2.md')['id']);
    const otherId = String(fmOf(inst, 'notes/deploy.md')['id']);
    const before = { keep: read(inst, 'notes/deploy-v2.md'), other: read(inst, 'notes/deploy.md') };
    assert.equal((await cog(inst, [])).code, 0);
    const [p] = ofType(inst, 'merge');
    assert.ok(p);
    const parsed = parseProposal(p.text);
    // The more complete note (the longer v2) is kept although it is later.
    assert.deepEqual(targetPaths(p), ['notes/deploy-v2.md', 'notes/deploy.md']);
    const cite = parsed.meta.evidence[1]!;
    assert.match(cite, new RegExp(`^note:${otherId}@[0-9a-f]{16}$`));
    const archivedAt = parsed.ops[2];
    assert.ok(archivedAt?.op === 'set_frontmatter' && archivedAt.key === 'archived_at' && typeof archivedAt.value === 'string');
    assert.deepEqual(parsed.ops.slice(1), [
      { op: 'set_frontmatter', target: otherId, key: 'status', value: 'archived' },
      { op: 'set_frontmatter', target: otherId, key: 'archived_at', value: archivedAt.value },
      { op: 'set_frontmatter', target: otherId, key: 'merged_into', value: keepId },
      { op: 'move_note', target: otherId, to: '_archive/notes/deploy.md' },
    ]);
    const append = parsed.ops[0]!;
    assert.equal(append.op, 'append_section');
    // Exact duplicate content: nothing unique, but the section and citation are still recorded.
    assert.ok(append.op === 'append_section' && append.text.includes(cite) && append.text.startsWith('## Merged from Deploys'));

    const filesBefore = vaultFiles(inst);
    const acc = review(inst, ['accept', String(p.fm['id'])]);
    assert.equal(acc.code, 0, acc.stderr);
    assert.ok(!fs.existsSync(path.join(inst.vault, 'notes/deploy.md')));
    const archived = fmOf(inst, '_archive/notes/deploy.md');
    assert.equal(archived['status'], 'archived');
    assert.equal(archived['merged_into'], keepId);
    assert.equal(archived['id'], otherId);
    assert.ok(typeof archived['archived_at'] === 'string');
    assert.match(read(inst, '_archive/notes/deploy.md').toString('utf8'), /billing API every Friday/);
    const kept = read(inst, 'notes/deploy-v2.md').toString('utf8');
    assert.match(kept, /## Merged from Deploys/);
    assert.ok(kept.includes(cite));
    // Never deletes: the same number of files, the moved one at its archive path.
    const filesAfter = vaultFiles(inst);
    assert.equal(filesAfter.length, filesBefore.length);
    assert.deepEqual(filesAfter.filter((f) => !filesBefore.includes(f)), ['_archive/notes/deploy.md']);

    // A re-run proposes nothing (the archived note is no longer eligible).
    assert.match((await cog(inst, [])).stdout, /proposals: 0 created/);

    const u = review(inst, ['undo', String(p.fm['id'])]);
    assert.equal(u.code, 0, u.stderr);
    assert.deepEqual(read(inst, 'notes/deploy-v2.md'), before.keep);
    assert.deepEqual(read(inst, 'notes/deploy.md'), before.other);
    assert.ok(!fs.existsSync(path.join(inst.vault, '_archive/notes/deploy.md')));
  });

  it('unique lines of the archived note are appended; on equal completeness the earlier note is kept', async () => {
    const inst = setup();
    note(inst, 'notes/b-later.md', { title: 'Later', occurred: '2026-06-01' }, `${TEXTS[12]}\n`);
    note(inst, 'notes/a-earlier.md', { title: 'Earlier', occurred: '2026-02-01' }, `${TEXTS[12]}\n`);
    note(inst, 'notes/x.md', { title: 'X', occurred: '2026-01-01' }, `${TEXTS[16]}\n`);
    note(inst, 'notes/y.md', { title: 'Y', occurred: '2026-01-02' }, `${TEXTS[16]}\nOnsite candidates get lunch with the team.\n`);
    ids(inst);
    assert.equal((await cog(inst, [])).code, 0);
    const ms = ofType(inst, 'merge');
    const tie = ms.find((p) => targetPaths(p).includes('notes/a-earlier.md'))!;
    assert.deepEqual(targetPaths(tie), ['notes/a-earlier.md', 'notes/b-later.md']);
    const xy = ms.find((p) => targetPaths(p).includes('notes/x.md'))!;
    assert.deepEqual(targetPaths(xy), ['notes/y.md', 'notes/x.md']);
    // y keeps; x adds nothing unique. The reverse direction is covered by uniqueLines' own test.
    const op = parseProposal(xy.text).ops[0]!;
    assert.ok(op.op === 'append_section' && /added nothing beyond/.test(op.text));
  });

  it('skips pinned notes, _raw/, other principals\' journal entries, and provisional ids', async () => {
    const inst = setup();
    note(inst, 'notes/p1.md', { title: 'Pinned', pinned: true }, `${TEXTS[4]}\n`);
    note(inst, 'notes/p2.md', { title: 'Pinned copy' }, `${TEXTS[4]}\n`);
    note(inst, '_raw/r1.md', { title: 'Raw 1' }, `${TEXTS[5]}\n`);
    note(inst, '_raw/r2.md', { title: 'Raw 2' }, `${TEXTS[5]}\n`);
    note(inst, 'journal/other-agent/2026-01-01.md', { title: 'Other 1', status: 'journal' }, `${TEXTS[6]}\n`);
    note(inst, 'journal/other-agent/2026-01-02.md', { title: 'Other 2', status: 'journal' }, `${TEXTS[6]}\n`);
    note(inst, 'notes/m1.md', { title: 'Mine' }, `${TEXTS[7]}\n`);
    note(inst, 'journal/tester/2026-01-03.md', { title: 'My journal', status: 'journal' }, `${TEXTS[7]}\n`);
    let r = await cog(inst, []);
    assert.match(r.stdout, /notes have only a provisional id and were skipped/);
    assert.equal(proposals(inst).length, 0);
    ids(inst);
    r = await cog(inst, []);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipped 1 pinned, 2 journal entries of other principals/);
    const ms = ofType(inst, 'merge');
    assert.equal(ms.length, 1);
    assert.deepEqual([...targetPaths(ms[0]!)].sort(), ['journal/tester/2026-01-03.md', 'notes/m1.md']);
  });

  it('a note joins at most one merge per run; re-runs are idempotent; a rejected merge is not re-proposed unless --reconsider', async () => {
    const inst = setup();
    note(inst, 'notes/a.md', { title: 'A', occurred: '2026-01-01' }, `${TEXTS[8]}\n`);
    note(inst, 'notes/b.md', { title: 'B', occurred: '2026-01-02' }, `${TEXTS[8]}\n`);
    note(inst, 'notes/c.md', { title: 'C', occurred: '2026-01-03' }, `${reword(TEXTS[8]!)}\n`);
    ids(inst);
    let r = await cog(inst, []);
    assert.match(r.stdout, /proposals: 1 created/);
    assert.match(r.stdout, /2 overlapping another merge/);
    assert.deepEqual(targetPaths(ofType(inst, 'merge')[0]!), ['notes/a.md', 'notes/b.md']);
    r = await cog(inst, []);
    assert.match(r.stdout, /proposals: 0 created/);
    assert.equal(proposals(inst).length, 1);
    const p = proposals(inst)[0]!;
    assert.equal(review(inst, ['reject', String(p.fm['id']), '--reason', 'keep both']).code, 0);
    r = await cog(inst, []);
    // The rejected pair is skipped; its notes are free for the next pair (a ~ c).
    assert.match(r.stdout, /1 previously rejected \(skipped\)/);
    assert.deepEqual(ofType(inst, 'merge').map(targetPaths), [['notes/a.md', 'notes/c.md']]);
    r = await cog(inst, ['--reconsider']);
    assert.match(r.stdout, /1 created/);
    assert.ok(ofType(inst, 'merge').some((x) => x.fm['proposal_key'] === p.fm['proposal_key']));
  });

  it('with embeddings on, cosine neighbours from stored vectors are added (no embedder call); with embeddings off they are not', async () => {
    const para = (a: string, b: string): string => `${a}\n`.replace('X', b);
    const mk = (embeddings: boolean): Inst => {
      const inst = setup({ extra: embeddings ? { embeddings: { provider: 'ollama', model: 'm1', baseUrl: 'http://127.0.0.1:9' } } : {} });
      note(inst, 'notes/cats.md', { title: 'Cats' }, para('Feline companions X enjoy sleeping in warm sunny spots near windows all day long.', ''));
      note(inst, 'notes/kitties.md', { title: 'Kitties' }, para('Our house cats X love to nap where the afternoon light comes through the glass.', ''));
      note(inst, 'notes/tax.md', { title: 'Tax' }, `${TEXTS[15]}\n`);
      ids(inst);
      const h = openIndex({ vaultPath: inst.vault, stateDir: ensurePrivateDir(inst.stateDir) });
      refreshIndex(h);
      const embedder: Embedder = {
        provider: 'ollama', model: 'm1',
        embed: async (texts) => texts.map((t) => (/cats|Feline/i.test(t) ? [1, 0.01, 0] : [0, 0, 1])),
      };
      return { ...inst, h, embedder } as Inst & { h: ReturnType<typeof openIndex>; embedder: Embedder };
    };
    for (const on of [true, false]) {
      const inst = mk(on) as Inst & { h: ReturnType<typeof openIndex>; embedder: Embedder };
      await syncEmbeddings(inst.h.db, inst.embedder);
      closeIndex(inst.h);
      const r = await cog(inst, []);
      assert.equal(r.code, 0, r.stderr);
      const ms = ofType(inst, 'merge');
      if (on) {
        assert.deepEqual(ms.map(targetPaths).map((t) => [...t].sort()), [['notes/cats.md', 'notes/kitties.md']]);
        assert.match(ms[0]!.text, /embedding cosine/);
        assert.equal(lastRun(inst).counts['embedded_notes'], 3);
      } else {
        assert.equal(ms.length, 0);
      }
    }
  });
});

describe('cognition run consolidate: summary', () => {
  function cluster(inst: Inst, opts: { untrusted?: boolean; bad?: boolean } = {}): void {
    note(inst, 'notes/r1.md', { title: 'Roadmap Q1', tags: ['roadmap'], occurred: '2026-01-01' }, 'Q1 focuses on the onboarding flow for agencies. Design starts in January.\n');
    note(inst, 'notes/r2.md', { title: 'Roadmap Q2', tags: ['roadmap'], occurred: '2026-04-01', ...(opts.untrusted === true ? { untrusted: true } : {}) },
      'Q2 adds the billing dashboard and invoice exports. Finance reviews the mockups.\n');
    note(inst, 'notes/r3.md', { title: 'Roadmap Q3', tags: ['roadmap'], occurred: '2026-07-01' },
      `Q3 is reserved for performance work on search. Latency budgets get tightened.\n${opts.bad === true ? '<!-- mock:badclaim -->\n' : ''}`);
    note(inst, 'notes/other.md', { title: 'Other', tags: ['misc'] }, `${TEXTS[9]}\n`);
  }

  it('without an LLM: an extractive link-list summary note with derived_from and a citation per line; accept creates it; not re-proposed', async () => {
    const inst = setup();
    cluster(inst);
    ids(inst);
    const r = await cog(inst, []);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no LLM provider: summaries are extractive link lists/);
    const [s] = ofType(inst, 'summary');
    assert.ok(s);
    assert.equal(ofType(inst, 'summary').length, 1);
    const parsed = parseProposal(s.text);
    assert.deepEqual(parsed.meta.targets, []);
    assert.equal(parsed.meta.evidence.length, 3);
    const op = parsed.ops[0]!;
    assert.ok(op.op === 'create_note');
    assert.match(op.path, /^summaries\/tag-roadmap-[0-9a-f]{8}\.md$/);
    const fm = parseYaml(splitFrontmatter(op.content).yaml!) as Record<string, unknown>;
    assert.equal(fm['kind'], 'summary');
    assert.deepEqual(fm['derived_from'], parsed.meta.evidence);
    for (const c of parsed.meta.evidence) assert.match(c, /^note:[A-Za-z0-9_]+@[0-9a-f]{16}$/);
    const lines = splitFrontmatter(op.content).body.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, 3);
    lines.forEach((l, i) => assert.ok(l.includes(`\`${parsed.meta.evidence[i]}\``) && l.includes(`[[notes/r${i + 1}|Roadmap Q${i + 1}]]`), l));
    assert.match(lines[0]!, /Q1 focuses on the onboarding flow for agencies\. Design starts in January\./);
    assert.equal(fm['untrusted_origin'], undefined);

    assert.equal(review(inst, ['accept', String(s.fm['id'])]).code, 0, 'accept');
    assert.equal(fmOf(inst, op.path)['kind'], 'summary');
    const again = await cog(inst, []);
    assert.match(again.stdout, /proposals: 0 created/);
    assert.equal(lastRun(inst).counts['summary_exists'], 1);
  });

  it('with an LLM: claims carry citations and verbatim quotes; a claim without a supporting verbatim span is dropped', async () => {
    const inst = setup({ llm: true });
    cluster(inst, { bad: true });
    ids(inst);
    const r = await cog(inst, []);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /claims: 2 supported, 1 dropped/);
    const [s] = ofType(inst, 'summary');
    assert.ok(s);
    const op = parseProposal(s.text).ops[0]!;
    assert.ok(op.op === 'create_note');
    const body = splitFrontmatter(op.content).body;
    assert.match(body, /^## Claims$/m);
    assert.match(body, /> Q1 focuses on the onboarding flow for agencies\./);
    assert.match(body, /> Q2 adds the billing dashboard and invoice exports\./);
    assert.ok(!body.includes('not in any source note'));
    assert.ok(!/Source 3 says this/.test(body));
    assert.equal(lastRun(inst).prompt?.id, 'consolidate.v1');
    assert.equal(lastRun(inst).counts['claims_unsupported'], 1);
  });

  it('a cluster with no supported claim yields no summary', async () => {
    const inst = setup({ llm: true });
    for (let i = 1; i <= 3; i++) note(inst, `notes/z${i}.md`, { title: `Z${i}`, tags: ['zed'] }, `Zed fact number ${i} is here.\n<!-- mock:badclaim -->\n`);
    ids(inst);
    const r = await cog(inst, []);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ofType(inst, 'summary').length, 0);
    assert.equal(lastRun(inst).counts['summary_no_supported_claims'], 1);
  });

  it('taint from an untrusted_origin source carries into the summary proposal and the summary note', async () => {
    const inst = setup();
    cluster(inst, { untrusted: true });
    ids(inst);
    assert.equal((await cog(inst, [])).code, 0);
    const [s] = ofType(inst, 'summary');
    assert.ok(s);
    assert.equal(s.fm['untrusted_origin'], true);
    const r2 = fmOf(inst, 'notes/r2.md');
    const taint = s.fm['taint_sources'] as string[];
    assert.equal(taint.length, 1);
    assert.match(taint[0]!, new RegExp(`^note:${String(r2['id'])}@`));
    assert.match(s.text, /Untrusted origin/);
    const op = parseProposal(s.text).ops[0]!;
    assert.ok(op.op === 'create_note');
    assert.equal((parseYaml(splitFrontmatter(op.content).yaml!) as Record<string, unknown>)['untrusted_origin'], true);
  });

  it('linked notes form a cluster; clusters are capped by maxSummaries; largest first', async () => {
    const inst = setup({ extra: { cognition: { maxProposalsPerRun: 500, consolidate: { maxSummaries: 1 } } } });
    note(inst, 'notes/hub.md', { title: 'Hub' }, 'See [[l1]] and [[l2]] and [[l3]].\n');
    note(inst, 'notes/l1.md', { title: 'L1' }, 'Leaf one talks about the kettle.\n');
    note(inst, 'notes/l2.md', { title: 'L2' }, 'Leaf two talks about the toaster.\n');
    note(inst, 'notes/l3.md', { title: 'L3' }, 'Leaf three talks about the oven.\n');
    cluster(inst);
    ids(inst);
    const r = await cog(inst, []);
    assert.equal(r.code, 0, r.stderr);
    const ss = ofType(inst, 'summary');
    assert.equal(ss.length, 1);
    assert.match(String(ss[0]!.fm['title']), /notes linked with Hub/);
    assert.match(r.stdout, /1 over cognition\.consolidate\.maxSummaries/);
  });
});

describe('consolidate config', () => {
  it('cognition.consolidate keys have defaults and are validated', () => {
    const base = { vaultPath: '/tmp/v', stateDir: '/tmp/s', principal: { id: 'p', type: 'human' }, mode: 'inbox' };
    assert.deepEqual(parseConfig(base).cognition.consolidate, { minJaccard: 0.5, minCosine: 0.95, maxSummaries: 5 });
    assert.deepEqual(parseConfig({ ...base, cognition: { consolidate: { minJaccard: 0.7, minCosine: 0.9, maxSummaries: 2 } } }).cognition.consolidate,
      { minJaccard: 0.7, minCosine: 0.9, maxSummaries: 2 });
    for (const bad of [{ minJaccard: 0 }, { minJaccard: 2 }, { minCosine: '0.9' }, { maxSummaries: 0 }, { other: 1 }]) {
      assert.throws(() => parseConfig({ ...base, cognition: { consolidate: bad } }), ConfigError, JSON.stringify(bad));
    }
    assert.throws(() => parseConfig({ ...base, cognition: { consolidate: [] } }), ConfigError);
  });
});
