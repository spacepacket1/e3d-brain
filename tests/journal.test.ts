// Phase 9 unit and in-process tests: journal entry names and dedup
// normalization, the journal store (containment, create-only, limits from
// the filesystem), journal_append / journal_list through dispatch (strict
// scrubbing, provenance, audit of rejections, immediate search), the T1-T5
// ranking fixture and labels, expiry with include_expired, `journal prune`,
// and `import agent-workspace`.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AuditLog } from '../src/audit/audit.js';
import { DEFAULT_JOURNAL, parseConfig, type JournalConfig } from '../src/config.js';
import { closeIndex, openIndex, type IndexHandle } from '../src/index/indexer.js';
import { effectiveTier, hasWellFormedCitation } from '../src/index/rank.js';
import { toSlug } from '../src/inbox/note.js';
import { bodyHash, entryBody, entryNameMs, expiresAt, normalizeBody, renderEntry } from '../src/journal/entry.js';
import { importAgentWorkspace } from '../src/journal/import.js';
import { pruneJournal } from '../src/journal/prune.js';
import { appendEntry, JournalRefusedError, scanJournal } from '../src/journal/store.js';
import { dispatch, listTools, ToolRegistry, type DispatchContext, type ToolCallResponse } from '../src/mcp/dispatch.js';
import { registerInboxTools } from '../src/mcp/inbox-tools.js';
import { registerJournalTools } from '../src/mcp/journal-tools.js';
import { registerReadTools } from '../src/mcp/tools.js';
import { ensurePrivateDir, SafePathError, type SafePath } from '../src/safe-path.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { realTmpDir, rmrf, treeChecksum } from './helpers.js';
import { EVM_ADDRESS, fake, TX_HASH } from './scrub-fixtures.js';

const bases: string[] = [];
const handles: IndexHandle[] = [];
after(() => {
  for (const h of handles) closeIndex(h);
  for (const b of bases) rmrf(b);
});

const T0 = Date.parse('2026-10-14T12:00:00Z');
const PID = 'agent-a';

interface Env {
  base: string;
  vault: string;
  stateDir: SafePath;
  index: IndexHandle;
  registry: ToolRegistry;
  clock: { ms: number };
  ctx: (over?: Partial<DispatchContext>) => DispatchContext;
  call: (tool: string, args: Record<string, unknown>) => Promise<ToolCallResponse>;
  audit: () => Record<string, unknown>[];
}

function makeEnv(opts: { files?: Record<string, string>; limits?: Partial<JournalConfig>; pid?: string } = {}): Env {
  const base = realTmpDir('ebrain-p9-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault);
  for (const [rel, text] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const index = openIndex({ vaultPath: vault, stateDir });
  handles.push(index);
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const registry = new ToolRegistry();
  registerReadTools({ vaultPath: vault, index, now, mode: 'journal' }, registry);
  registerJournalTools({ vaultPath: vault, stateDir, index, limits: { ...DEFAULT_JOURNAL, ...opts.limits }, extraPatterns: [], now }, registry);
  const audit = new AuditLog(stateDir, { maxSegmentBytes: 50 * 1024 * 1024 });
  const pid = opts.pid ?? PID;
  const ctx = (over: Partial<DispatchContext> = {}): DispatchContext => ({
    mode: 'journal', principal: { id: pid, type: 'agent' }, maxCharsPerCall: 10000, registry, audit, ...over,
  });
  return {
    base, vault, stateDir, index, registry, clock, ctx,
    call: (tool, args) => dispatch(ctx(), tool, args),
    audit: () => {
      const f = path.join(stateDir, 'audit.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    },
  };
}

function text(r: ToolCallResponse): string {
  return r.content[0]!.text;
}
function headerOf(r: ToolCallResponse): Record<string, unknown> {
  return JSON.parse(text(r).split('\n')[0]!) as Record<string, unknown>;
}
function resultsOf(r: ToolCallResponse): Record<string, unknown>[] {
  const lines = text(r).split('\n');
  const open = lines.findIndex((l) => /^`{3,}text$/.test(l));
  if (open < 0) return [];
  const fence = lines[open]!.slice(0, -4);
  const close = lines.findIndex((l, i) => i > open && l === fence);
  return lines.slice(open + 1, close).map((l) => JSON.parse(l) as Record<string, unknown>);
}
function frontmatter(file: string): Record<string, unknown> {
  return parseYaml(splitFrontmatter(fs.readFileSync(file, 'utf8')).yaml ?? '') as Record<string, unknown>;
}
/** Every file under `dir` (relative, dot-files included). */
function allFiles(dir: string, rel = ''): string[] {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...allFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}
function okResult(r: ToolCallResponse): Record<string, unknown> {
  assert.notEqual(r.isError, true, text(r));
  return headerOf(r);
}

describe('journal entries (pure)', () => {
  it('parses entry file-name stamps and refuses other names', () => {
    assert.equal(entryNameMs('20261014-120000-hello.md'), T0);
    for (const bad of ['20261399-120000-x.md', '20261014-120000-.md', '20261014-120000-X.md', 'notes.md', '20261014-120000-a.md.tmp']) {
      assert.equal(entryNameMs(bad), undefined, bad);
    }
  });

  it('normalizes bodies for dedup and recovers the body from rendered text', () => {
    assert.equal(normalizeBody('a  \r\nb\n\n\n\nc\n'), 'a\nb\n\nc');
    assert.equal(bodyHash('x\n'), bodyHash('  x  '.trim()));
    assert.notEqual(bodyHash('x'), bodyHash('y'));
    const rendered = renderEntry(
      { id: '01J0000000000000000000000A', title: 'T', author: PID, origin: 'mcp', created: '2026-10-14T12:00:00Z', kind: 'log', sources: [], untrustedOrigin: false, expires: 'x', scrubVersion: 1 },
      'line one\n\nline two',
    );
    assert.equal(normalizeBody(entryBody(rendered)), 'line one\n\nline two');
    assert.equal(expiresAt(new Date(T0), 90), '2027-01-12T12:00:00Z');
  });

  it('config: journal limits default and validate', () => {
    const base = { vaultPath: '/v', stateDir: '/s', principal: { id: 'a', type: 'agent' }, mode: 'journal' };
    assert.deepEqual(parseConfig(base).journal, { ttlDays: 90, maxEntryChars: 4000, maxEntriesPerHour: 60, maxTotalMB: 100 });
    assert.equal(parseConfig({ ...base, journal: { maxTotalMB: 0.01 } }).journal.maxTotalMB, 0.01);
    for (const bad of [{ ttlDays: 0 }, { maxEntryChars: 1.5 }, { maxEntriesPerHour: '60' }, { maxTotalMB: -1 }, { other: 1 }]) {
      assert.throws(() => parseConfig({ ...base, journal: bad }), /journal/);
    }
  });
});

describe('journal store', () => {
  const limits: JournalConfig = { ...DEFAULT_JOURNAL };
  const req = (over: Partial<Parameters<typeof appendEntry>[1]> = {}) => ({
    principalId: PID, slug: toSlug('hello'), when: new Date(T0), text: '---\nstatus: journal\n---\n# hello\n\nbody\n', body: 'body', submittedChars: 4, ...over,
  });

  it('refuses hostile principal ids and never writes outside journal/<principal-id>/', () => {
    const env = makeEnv();
    for (const pid of ['../x', 'a/b', '_archive', '', 'A', '..', 'x\0y', 'a\\b', '.hidden']) {
      assert.throws(() => appendEntry({ vaultPath: env.vault, stateDir: env.stateDir, limits }, req({ principalId: pid })), Error, JSON.stringify(pid));
    }
    assert.deepEqual(allFiles(env.vault), []);
    assert.throws(() => appendEntry({ vaultPath: env.vault, stateDir: env.stateDir, limits }, req({ slug: '../x' as never })), SafePathError);
  });

  it('refuses a symlinked journal/<principal-id>/ (a write would land elsewhere in the vault)', () => {
    const env = makeEnv({ files: { 'notes/keep.md': 'x' } });
    fs.mkdirSync(path.join(env.vault, 'journal'));
    fs.symlinkSync(path.join(env.vault, 'notes'), path.join(env.vault, 'journal', PID));
    assert.throws(() => appendEntry({ vaultPath: env.vault, stateDir: env.stateDir, limits }, req()), SafePathError);
    assert.deepEqual(fs.readdirSync(path.join(env.vault, 'notes')), ['keep.md']);
  });

  it('never overwrites an existing entry: a name collision is an error and the old file is untouched', () => {
    const env = makeEnv();
    const first = appendEntry({ vaultPath: env.vault, stateDir: env.stateDir, limits }, req());
    assert.equal(first.relPath, `journal/${PID}/2026/20261014-120000-hello.md`);
    const before = fs.readFileSync(path.join(env.vault, first.relPath), 'utf8');
    assert.throws(
      () => appendEntry({ vaultPath: env.vault, stateDir: env.stateDir, limits }, req({ text: 'other', body: 'other' })),
      (e) => e instanceof JournalRefusedError && e.code === 'exists',
    );
    assert.equal(fs.readFileSync(path.join(env.vault, first.relPath), 'utf8'), before);
    assert.equal(fs.statSync(path.join(env.vault, first.relPath)).mode & 0o777, 0o600);
    assert.deepEqual(allFiles(path.join(env.vault, 'journal')), [`${PID}/2026/20261014-120000-hello.md`]);
  });

  it('computes counts and sizes from the journal directory (file-name stamps, stat sizes)', () => {
    const env = makeEnv({
      files: {
        [`journal/${PID}/2026/20261014-115959-a.md`]: 'x'.repeat(100),
        [`journal/${PID}/2026/20261014-105959-old.md`]: 'y',
        [`journal/${PID}/imported/memory-abc.md`]: 'z'.repeat(10),
        [`journal/${PID}/2026/.20261014-115959-tmp.md.1.tmp`]: 'tmp',
        ['journal/other/2026/20261014-115959-b.md']: 'w'.repeat(1000),
      },
    });
    const scan = scanJournal(env.vault, PID);
    assert.equal(scan.totalBytes, 111);
    assert.deepEqual(scan.files.filter((f) => f.ms !== undefined).map((f) => f.relPath).sort(), [
      `journal/${PID}/2026/20261014-105959-old.md`, `journal/${PID}/2026/20261014-115959-a.md`,
    ]);
  });
});

describe('journal_append and journal_list through dispatch', () => {
  it('creates journal/<pid>/<yyyy>/<stamp>-<slug>.md with full provenance, 0600, then search finds it immediately', async () => {
    const env = makeEnv();
    const h = okResult(await env.call('journal_append', {
      title: '../../Etc/Passwd ..\\ escape', body: 'journalmarker observed the queue draining', kind: 'observation',
      sources: ['commit:abc1234', 'url:https://example.com/post'], untrusted_origin: true,
    }));
    assert.equal(h['path'], `journal/${PID}/2026/20261014-120000-etc-passwd-escape.md`);
    const file = path.join(env.vault, h['path'] as string);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const fm = frontmatter(file);
    assert.equal(fm['schema'], 1);
    assert.equal(fm['id'], h['id']);
    assert.equal(fm['author'], PID);
    assert.equal(fm['origin'], 'mcp');
    assert.equal(fm['created'], '2026-10-14T12:00:00Z');
    assert.equal(fm['kind'], 'observation');
    assert.deepEqual(fm['sources'], ['commit:abc1234', 'url:https://example.com/post']);
    assert.equal(fm['untrusted_origin'], true);
    assert.equal(fm['status'], 'journal');
    assert.equal(fm['expires'], '2027-01-12T12:00:00Z');
    assert.equal(fm['scrubVersion'], 1);
    assert.deepEqual(allFiles(env.vault), [`journal/${PID}/2026/20261014-120000-etc-passwd-escape.md`]);

    const s = await env.call('search', { query: 'journalmarker' });
    const rs = resultsOf(s);
    assert.equal(rs.length, 1, text(s));
    assert.deepEqual(rs[0]!['labels'], ['agent-journal', 'untrusted_origin']);
    assert.equal(rs[0]!['untrusted_origin'], true);
    assert.equal(rs[0]!['author'], PID);
    assert.match(String(headerOf(s)['notice']), /agent-journal/);

    const l = await env.call('journal_list', {});
    assert.equal(resultsOf(l).length, 1);
    assert.equal(resultsOf(l)[0]!['path'], h['path']);
  });

  it('ignores caller identity: author/principal are refused by schema (audited), the file author is the config principal', async () => {
    const env = makeEnv();
    for (const key of ['author', 'principal']) {
      const r = await env.call('journal_append', { title: 't', body: `b ${key}`, [key]: 'mallory' });
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent?.error.type, 'invalid');
    }
    assert.deepEqual(allFiles(env.vault), []);
    assert.equal(env.audit().filter((l) => l['tool'] === 'journal_append' && l['outcome'] === 'invalid').length, 2);
  });

  it('strict scrubbing: a fake private key, mnemonic, or API key rejects the whole append and stores nothing', async () => {
    const env = makeEnv();
    const label = ['RSA', 'PRIVATE', 'KEY'].join(' ');
    const pem = `-----BEGIN ${label}-----\n${fake.pemBody(4)}\n-----END ${label}-----`;
    const cases: Record<string, unknown>[] = [
      { title: 'k', body: `note\n${pem}\n` },
      { title: 'k', body: `seed: ${fake.mnemonic(12)}` },
      { title: 'k', body: `use ${fake.openai()}` },
      { title: `token ${fake.github()}`, body: 'clean' },
    ];
    for (const args of cases) {
      const r = await env.call('journal_append', args);
      assert.equal(r.structuredContent?.error.type, 'strict-scrub', text(r));
    }
    assert.deepEqual(allFiles(env.vault), []);
    const lines = env.audit().filter((l) => l['outcome'] === 'rejected');
    assert.equal(lines.length, 4);
    for (const l of lines) assert.equal((l['error'] as { type: string }).type, 'strict-scrub');

    const ok = okResult(await env.call('journal_append', { title: 'addr', body: `sent to ${EVM_ADDRESS} in ${TX_HASH}` }));
    const stored = fs.readFileSync(path.join(env.vault, ok['path'] as string), 'utf8');
    assert.ok(stored.includes(EVM_ADDRESS) && stored.includes(TX_HASH));
  });

  it('untrusted_origin needs a source; sources must be citations', async () => {
    const env = makeEnv();
    assert.equal((await env.call('journal_append', { title: 't', body: 'b', untrusted_origin: true })).structuredContent?.error.type, 'invalid');
    assert.equal((await env.call('journal_append', { title: 't', body: 'b', sources: ['not a citation'] })).structuredContent?.error.type, 'invalid');
    assert.deepEqual(allFiles(env.vault), []);
  });

  it('size, rate, total-size, and duplicate limits reject (never truncate) and are audited by code', async () => {
    const env = makeEnv({ limits: { maxEntryChars: 50, maxEntriesPerHour: 3, maxTotalMB: 2000 / (1024 * 1024) } });
    const code = (r: ToolCallResponse) => {
      assert.equal(r.isError, true, text(r));
      return env.audit().at(-1)!['error'] as { type: string; code?: string };
    };
    assert.deepEqual(code(await env.call('journal_append', { title: 'big', body: 'x'.repeat(51) })), { type: 'limit', code: 'entry-size' });
    okResult(await env.call('journal_append', { title: 'one', body: 'first body' }));
    const dup = await env.call('journal_append', { title: 'again', body: '  first body \n' });
    assert.deepEqual(code(dup), { type: 'limit', code: 'duplicate' });
    assert.match(text(dup), new RegExp(`journal/${PID}/2026/20261014-120000-one\\.md`));
    env.clock.ms += 1000;
    okResult(await env.call('journal_append', { title: 'two', body: 'second body' }));
    env.clock.ms += 1000;
    okResult(await env.call('journal_append', { title: 'three', body: 'third body' }));
    env.clock.ms += 1000;
    assert.deepEqual(code(await env.call('journal_append', { title: 'four', body: 'fourth body' })), { type: 'limit', code: 'rate' });
    // An hour later the window has moved; a day later the duplicate is allowed again.
    env.clock.ms = T0 + 25 * 3600_000;
    okResult(await env.call('journal_append', { title: 'one again', body: 'first body' }));
    // Total size: pad the journal directory on disk (not via the index) past the budget.
    fs.writeFileSync(path.join(env.vault, 'journal', PID, 'pad.bin'), 'p'.repeat(1500));
    env.clock.ms += 1000;
    assert.deepEqual(code(await env.call('journal_append', { title: 'five', body: 'fifth body' })), { type: 'limit', code: 'total-size' });
    assert.equal(allFiles(path.join(env.vault, 'journal', PID)).filter((f) => f.endsWith('.md')).length, 4);
    // Audit lines never carry bodies.
    for (const l of env.audit()) assert.ok(!/first body|second body|xxxx/.test(JSON.stringify(l)), JSON.stringify(l));
  });

  it('a stale index does not loosen the limits (they are read from the filesystem)', async () => {
    const env = makeEnv({ limits: { maxEntriesPerHour: 2 } });
    fs.mkdirSync(path.join(env.vault, 'journal', PID, '2026'), { recursive: true });
    fs.writeFileSync(path.join(env.vault, 'journal', PID, '2026', '20261014-115900-a.md'), '---\nstatus: journal\n---\n# a\n\nsame text\n');
    fs.writeFileSync(path.join(env.vault, 'journal', PID, '2026', '20261014-115901-b.md'), '---\nstatus: journal\n---\n# b\n\nb\n');
    // Neither file is indexed yet; both count.
    const r = await env.call('journal_append', { title: 'c', body: 'c' });
    assert.equal(r.isError, true);
    assert.equal((env.audit().at(-1)!['error'] as { code: string }).code, 'rate');
  });

  it('journal_list filters by since and kind, newest first within a tier, own principal only', async () => {
    const env = makeEnv({ files: { 'journal/other-agent/2026/20261014-110000-x.md': '---\nstatus: journal\nkind: log\ncreated: 2026-10-14T11:00:00Z\n---\nother\n' } });
    for (const [i, kind] of ['log', 'log', 'todo'].entries()) {
      env.clock.ms = T0 + i * 60_000;
      okResult(await env.call('journal_append', { title: `e${i}`, body: `entry ${i}`, kind }));
    }
    const all = resultsOf(await env.call('journal_list', {}));
    assert.deepEqual(all.map((r) => r['title']), ['e2', 'e1', 'e0']);
    assert.deepEqual(resultsOf(await env.call('journal_list', { kind: 'log' })).map((r) => r['title']), ['e1', 'e0']);
    assert.deepEqual(resultsOf(await env.call('journal_list', { since: '2026-10-14T12:01:00Z' })).map((r) => r['title']), ['e2', 'e1']);
    assert.deepEqual(resultsOf(await env.call('journal_list', { limit: 1, format: 'compact' })).map((r) => r['path']), [`journal/${PID}/2026/20261014-120200-e2.md`]);
    assert.equal((await env.call('journal_list', { since: 'yesterday' })).structuredContent?.error.type, 'invalid');
  });

  it('journal tools exist only in journal mode; include_expired only in journal mode', () => {
    const reg = new ToolRegistry();
    const base = realTmpDir('ebrain-p9m-');
    bases.push(base);
    fs.mkdirSync(path.join(base, 'v'));
    const index = openIndex({ vaultPath: path.join(base, 'v'), stateDir: ensurePrivateDir(path.join(base, 's')) });
    handles.push(index);
    registerReadTools({ vaultPath: path.join(base, 'v'), index, mode: 'inbox' }, reg);
    registerInboxTools({ vaultPath: path.join(base, 'v'), index, extraPatterns: [] }, reg);
    const names = listTools('inbox', reg).map((t) => t.name);
    assert.ok(!names.includes('journal_append'));
    const search = listTools('inbox', reg).find((t) => t.name === 'search')!;
    assert.ok(!('include_expired' in search.inputSchema.properties));
    const env = makeEnv();
    assert.deepEqual(listTools('journal', env.registry).map((t) => t.name).filter((n) => n.startsWith('journal_')), ['journal_append', 'journal_list']);
    assert.deepEqual(listTools('inbox', env.registry).map((t) => t.name).filter((n) => n.startsWith('journal_')), []);
    for (const t of ['search', 'list_notes']) assert.ok('include_expired' in listTools('journal', env.registry).find((x) => x.name === t)!.inputSchema.properties);
  });
});

describe('ranking and labels (T1-T5)', () => {
  it('rank.ts: a well-formed citation is thesis/outcome/commit/note; url and ref do not ground a lesson', () => {
    assert.ok(hasWellFormedCitation(['thesis:T1']));
    assert.ok(hasWellFormedCitation(['outcome:O_9']));
    assert.ok(hasWellFormedCitation(['commit:abc1234']));
    assert.ok(hasWellFormedCitation(['note:01J0000000000000000000000A@0123456789abcdef']));
    assert.ok(!hasWellFormedCitation(['url:https://example.com/']));
    assert.ok(!hasWellFormedCitation(['ref:book/ch1/3']));
    assert.ok(!hasWellFormedCitation(['commit:XYZ', 'thesis:']));
    assert.equal(effectiveTier('journal', 'journal', { kind: 'lesson', sources: ['url:https://example.com/'] }), 4);
    assert.equal(effectiveTier('journal', 'journal', { kind: 'lesson', sources: ['url:https://example.com/', 'outcome:o1'] }), 3);
    assert.equal(effectiveTier('journal', 'journal', { kind: 'decision', sources: ['commit:abc1234'] }), 5);
  });

  it('curated > inbox > cited journal lesson > uncited journal lesson > other journal; untrusted_origin is visible', async () => {
    const env = makeEnv({
      files: {
        'notes/curated.md': '# Curated\n\nrankmarker curated\n',
        '_inbox/20261014-110000-prop.md': '---\nstatus: proposed\nkind: idea\n---\n# Prop\n\nrankmarker inbox\n',
      },
    });
    okResult(await env.call('journal_append', { title: 'other', body: 'rankmarker other entry', kind: 'observation', sources: ['url:https://example.com/a'], untrusted_origin: true }));
    okResult(await env.call('journal_append', { title: 'uncited', body: 'rankmarker uncited lesson', kind: 'lesson', sources: ['url:https://example.com/b'] }));
    okResult(await env.call('journal_append', { title: 'cited', body: 'rankmarker cited lesson', kind: 'lesson', sources: ['thesis:T42'] }));
    const rs = resultsOf(await env.call('search', { query: 'rankmarker' }));
    assert.deepEqual(rs.map((r) => [r['path'], r['tier']]), [
      ['notes/curated.md', 1],
      ['_inbox/20261014-110000-prop.md', 2],
      [`journal/${PID}/2026/20261014-120000-cited.md`, 3],
      [`journal/${PID}/2026/20261014-120000-uncited.md`, 4],
      [`journal/${PID}/2026/20261014-120000-other.md`, 5],
    ]);
    assert.equal(rs[0]!['labels'], undefined);
    assert.deepEqual(rs[4]!['labels'], ['agent-journal', 'untrusted_origin']);
    const listed = resultsOf(await env.call('list_notes', { folder: 'journal' }));
    assert.deepEqual(listed.map((r) => r['tier']), [3, 4, 5]);
  });
});

describe('expiry, include_expired, and journal prune', () => {
  it('search and list_notes hide expired entries unless include_expired; prune archives them and never deletes', async () => {
    const env = makeEnv({ limits: { ttlDays: 1 } });
    okResult(await env.call('journal_append', { title: 'old', body: 'expirymarker old entry' }));
    env.clock.ms = T0 + 3 * 86_400_000;
    okResult(await env.call('journal_append', { title: 'fresh', body: 'expirymarker fresh entry' }));
    const paths = (r: ToolCallResponse) => resultsOf(r).map((x) => x['path']);
    assert.deepEqual(paths(await env.call('search', { query: 'expirymarker' })), [`journal/${PID}/2026/20261017-120000-fresh.md`]);
    assert.equal(paths(await env.call('search', { query: 'expirymarker', include_expired: true })).length, 2);
    assert.deepEqual(paths(await env.call('list_notes', {})), [`journal/${PID}/2026/20261017-120000-fresh.md`]);
    assert.equal(paths(await env.call('list_notes', { include_expired: true })).length, 2);
    assert.equal(paths(await env.call('journal_list', {})).length, 1);

    const before = allFiles(env.vault).length;
    const oldText = fs.readFileSync(path.join(env.vault, 'journal', PID, '2026', '20261014-120000-old.md'), 'utf8');
    const dry = pruneJournal(env.vault, { now: new Date(env.clock.ms), dryRun: true });
    assert.equal(dry.archived.length, 1);
    assert.ok(fs.existsSync(path.join(env.vault, 'journal', PID, '2026', '20261014-120000-old.md')));
    const r = pruneJournal(env.vault, { now: new Date(env.clock.ms) });
    assert.deepEqual(r.archived.map((a) => [a.from, a.to]), [[
      `journal/${PID}/2026/20261014-120000-old.md`, `journal/_archive/${PID}/2026/20261014-120000-old.md`,
    ]]);
    assert.equal(allFiles(env.vault).length, before);
    assert.equal(fs.readFileSync(path.join(env.vault, 'journal', '_archive', PID, '2026', '20261014-120000-old.md'), 'utf8'), oldText);
    assert.ok(!fs.existsSync(path.join(env.vault, 'journal', PID, '2026', '20261014-120000-old.md')));
    assert.deepEqual(pruneJournal(env.vault, { now: new Date(env.clock.ms) }).archived, []);
    // Archived: hidden by default even with include_expired; shown (labeled) with include_archived.
    assert.equal(paths(await env.call('search', { query: 'expirymarker', include_expired: true })).length, 1);
    const arch = resultsOf(await env.call('search', { query: 'expirymarker', include_archived: true }));
    assert.equal(arch.length, 2);
    assert.ok(arch.some((x) => (x['labels'] as string[] | undefined)?.includes('agent-journal') && String(x['path']).startsWith('journal/_archive/')));
  });

  it('prune keeps principals apart and refuses to overwrite an existing archive name', () => {
    const fm = '---\nstatus: journal\nexpires: 2026-01-01\n---\nx\n';
    const env = makeEnv({
      files: {
        'journal/a1/2026/20260101-000000-x.md': fm,
        'journal/b2/2026/20260101-000000-x.md': fm,
        'journal/b2/2026/20260101-000001-y.md': fm,
        'journal/_archive/b2/2026/20260101-000001-y.md': 'already here',
      },
    });
    const r = pruneJournal(env.vault, { now: new Date(T0) });
    assert.deepEqual(r.archived.map((a) => a.to).sort(), ['journal/_archive/a1/2026/20260101-000000-x.md', 'journal/_archive/b2/2026/20260101-000000-x.md']);
    assert.deepEqual(r.skipped, [{ path: 'journal/b2/2026/20260101-000001-y.md', reason: 'archive target already exists' }]);
    assert.equal(fs.readFileSync(path.join(env.vault, 'journal/_archive/b2/2026/20260101-000001-y.md'), 'utf8'), 'already here');
    assert.ok(fs.existsSync(path.join(env.vault, 'journal/b2/2026/20260101-000001-y.md')));
  });
});

describe('import agent-workspace', () => {
  function workspace(base: string): string {
    const ws = path.join(base, 'workspace');
    fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Memory\n\nThe deploy key lives in the vault, not here.\n');
    fs.writeFileSync(path.join(ws, 'GOALS.md'), '# Goals\n\n- ship phase 9\n');
    fs.writeFileSync(path.join(ws, 'memory', '2026-10-01.md'), 'Talked to the team.\n');
    fs.writeFileSync(path.join(ws, 'memory', '2026-10-02.md'), `Paid ${EVM_ADDRESS}\n`);
    fs.writeFileSync(path.join(ws, 'memory', 'notes.txt'), 'ignored');
    const label = ['EC', 'PRIVATE', 'KEY'].join(' ');
    fs.writeFileSync(path.join(ws, 'SOUL.md'), `who I am\n-----BEGIN ${label}-----\n${fake.pemBody(3)}\n-----END ${label}-----\n`);
    fs.writeFileSync(path.join(ws, 'TOOLS.md'), 'tools list\n');
    return ws;
  }

  it('imports, skips a file with a fake private key whole, leaves the source unchanged, and is idempotent', () => {
    const env = makeEnv();
    const ws = workspace(env.base);
    const sum = treeChecksum(ws);
    const opts = { vaultPath: env.vault, stateDir: env.stateDir, principalId: PID, now: new Date(T0) };
    const r1 = importAgentWorkspace(ws, opts);
    assert.deepEqual(r1.imported.map((x) => x.source).sort(), ['GOALS.md', 'MEMORY.md', 'TOOLS.md', 'memory/2026-10-01.md', 'memory/2026-10-02.md']);
    assert.deepEqual(r1.skipped.map((x) => x.source), ['SOUL.md']);
    assert.match(r1.skipped[0]!.reason, /strict scrub \(.*private-key/);
    for (const x of r1.imported) assert.ok(x.path.startsWith(`journal/${PID}/imported/`), x.path);
    assert.equal(treeChecksum(ws), sum);
    const soulish = allFiles(path.join(env.vault, 'journal', PID, 'imported')).filter((f) => f.startsWith('soul'));
    assert.deepEqual(soulish, []);
    const daily = r1.imported.find((x) => x.source === 'memory/2026-10-02.md')!;
    const fm = frontmatter(path.join(env.vault, daily.path));
    assert.equal(fm['kind'], 'log');
    assert.equal(fm['origin'], 'import');
    assert.equal(fm['author'], PID);
    assert.equal(fm['status'], 'journal');
    assert.equal(fm['occurred'], '2026-10-02');
    assert.equal(fm['expires'], undefined);
    assert.ok(fs.readFileSync(path.join(env.vault, daily.path), 'utf8').includes(EVM_ADDRESS));
    assert.equal(frontmatter(path.join(env.vault, r1.imported.find((x) => x.source === 'TOOLS.md')!.path))['kind'], 'reference');

    const vaultBefore = treeChecksum(env.vault);
    const r2 = importAgentWorkspace(ws, { ...opts, now: new Date(T0 + 60_000) });
    assert.equal(r2.imported.length, 0);
    assert.equal(r2.unchanged.length, 5);
    assert.equal(treeChecksum(env.vault), vaultBefore);
    assert.equal(treeChecksum(ws), sum);

    // A changed file is imported as a new entry beside the old one.
    fs.writeFileSync(path.join(ws, 'GOALS.md'), '# Goals\n\n- ship phase 10\n');
    const r3 = importAgentWorkspace(ws, opts);
    assert.deepEqual(r3.imported.map((x) => x.source), ['GOALS.md']);
    assert.equal(allFiles(path.join(env.vault, 'journal', PID, 'imported')).filter((f) => f.startsWith('goals-')).length, 2);
  });

  it('refuses a symlink escaping the workspace (skipped, listed)', () => {
    const env = makeEnv();
    const ws = path.join(env.base, 'ws2');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(env.base, 'outside.md'), 'outside secret text');
    fs.symlinkSync(path.join(env.base, 'outside.md'), path.join(ws, 'MEMORY.md'));
    const r = importAgentWorkspace(ws, { vaultPath: env.vault, stateDir: env.stateDir, principalId: PID });
    assert.deepEqual(r.imported, []);
    assert.deepEqual(r.skipped.map((x) => x.source), ['MEMORY.md']);
  });
});
