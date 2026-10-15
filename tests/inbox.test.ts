// Phase 8 unit tests: slugs and the inbox writer (I2: nothing outside
// _inbox/, never an overwrite, length limits), `capture` and `list_inbox`
// through dispatch in-process (scrubbing for human and agent principals,
// frontmatter, ranking and labels), the review gate (accept/reject moves,
// frontmatter, id preservation, destination rules, crash recovery), and the
// static scan that src/mcp/ writes only through the inbox writer.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { closeIndex, openIndex, type IndexHandle } from '../src/index/indexer.js';
import {
  acceptProposal, destinationStem, rejectProposal, resolveDestination, ReviewError, setFrontmatter, showProposal, listProposals,
  type ReviewEnv,
} from '../src/inbox/review.js';
import { cleanTitle, fileStamp, isSlug, MAX_SLUG_CHARS, MAX_TITLE_CHARS, renderProposal, suffixedSlug, toSlug } from '../src/inbox/note.js';
import { inboxDir, writeInboxFile } from '../src/inbox/writer.js';
import { dispatch, listTools, ToolRegistry, type DispatchContext, type ToolCallResponse } from '../src/mcp/dispatch.js';
import { registerInboxTools } from '../src/mcp/inbox-tools.js';
import { registerReadTools } from '../src/mcp/tools.js';
import { ULID_RE } from '../src/mcp/ulid.js';
import { ensurePrivateDir, SafePathError } from '../src/safe-path.js';
import { parseNote, revOf, splitFrontmatter } from '../src/vault/parse.js';
import { realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';
import { fake } from './scrub-fixtures.js';

const WHEN = new Date('2026-10-14T12:34:56Z');
const bases: string[] = [];
const handles: IndexHandle[] = [];

after(() => {
  for (const h of handles) closeIndex(h);
  for (const b of bases) rmrf(b);
});

interface Env {
  base: string;
  vault: string;
  index: IndexHandle;
  registry: ToolRegistry;
  ctx: (type?: 'human' | 'agent', mode?: DispatchContext['mode']) => DispatchContext;
  review: (over?: Partial<ReviewEnv>) => ReviewEnv;
}

function makeEnv(files: Record<string, string> = {}, extraPatterns: string[] = []): Env {
  const base = realTmpDir('ebrain-p8-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  const index = openIndex({ vaultPath: vault, stateDir: ensurePrivateDir(path.join(base, 'state')) });
  handles.push(index);
  const registry = new ToolRegistry();
  const now = () => WHEN;
  registerReadTools({ vaultPath: vault, index, now }, registry);
  registerInboxTools({ vaultPath: vault, index, extraPatterns, now }, registry);
  return {
    base,
    vault,
    index,
    registry,
    ctx: (type = 'human', mode = 'inbox') => ({ mode, principal: { id: 'tester', type }, maxCharsPerCall: 10000, registry }),
    review: (over = {}) => ({ vaultPath: vault, index, now: () => new Date('2026-10-15T08:00:00Z'), ...over }),
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

function inboxFiles(vault: string): string[] {
  const dir = path.join(vault, '_inbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [];
}

function frontmatter(file: string): Record<string, unknown> {
  return parseYaml(splitFrontmatter(fs.readFileSync(file, 'utf8')).yaml ?? '') as Record<string, unknown>;
}

/** Every file path under `dir`, relative, including dot-files. */
function allFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...allFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}

describe('slugs and file names', () => {
  it('sanitizes path syntax, hidden names, and unicode; limits length', () => {
    assert.equal(toSlug('../../x'), 'x');
    assert.equal(toSlug('.obsidian/app'), 'obsidian-app');
    assert.equal(toSlug('Café Déjà vu!'), 'cafe-deja-vu');
    assert.equal(toSlug('日本語'), 'note');
    assert.equal(toSlug('   '), 'note');
    assert.equal(toSlug('a\\b\0c/..\u202Ed'), 'a-b-c-d');
    const long = toSlug('word '.repeat(2000));
    assert.ok(long.length <= MAX_SLUG_CHARS && isSlug(long), long);
    assert.ok(isSlug(toSlug('x'.repeat(10_000))));
    assert.equal(toSlug('x'.repeat(10_000)).length, MAX_SLUG_CHARS);
    for (let i = 0; i < 5; i++) assert.ok(isSlug(suffixedSlug(long, i)) && suffixedSlug(long, i).length <= MAX_SLUG_CHARS);
    assert.equal(suffixedSlug(toSlug('idea'), 0), 'idea');
    assert.equal(suffixedSlug(toSlug('idea'), 1), 'idea-2');
    assert.equal(fileStamp(WHEN), '20261014-123456');
    assert.ok(!isSlug('../x') && !isSlug('A') && !isSlug('a--b') && !isSlug(''));
  });

  it('cleans titles to one bounded line', () => {
    assert.equal(cleanTitle('  a\nb\tc\u202E '), 'a b c');
    assert.equal(cleanTitle('t'.repeat(10_000)).length, MAX_TITLE_CHARS);
  });

  it('renders a proposal the parser reads back with schema 1, an id, and status proposed', () => {
    const t = renderProposal(
      { id: '01JABCDEFGHJKMNPQRSTVWXYZ0', title: 'A: "quoted" #title', kind: 'fact', created: '2026-10-14T12:34:56Z', origin: 'mcp', author: 'tester', sources: ['commit:abc1234'], scrubVersion: 1 },
      'Body line.\r\n',
    );
    const p = parseNote('_inbox/x.md', Buffer.from(t));
    assert.deepEqual(p.problems, []);
    assert.equal(p.fields.schema, 1);
    assert.equal(p.fields.id, '01JABCDEFGHJKMNPQRSTVWXYZ0');
    assert.equal(p.fields.status, 'proposed');
    assert.equal(p.fields.origin, 'mcp');
    assert.equal(p.fields.scrubVersion, '1');
    assert.deepEqual(p.fields.sources, ['commit:abc1234']);
    assert.equal(p.title, 'A: "quoted" #title');
    assert.ok(t.endsWith('Body line.\n'));
  });
});

describe('inbox writer (I2)', () => {
  it('writes only inside _inbox/, 0600, suffixing instead of overwriting', () => {
    const env = makeEnv({ 'keep.md': 'curated\n' });
    const a = writeInboxFile(env.vault, toSlug('Same'), WHEN, 'one\n');
    const b = writeInboxFile(env.vault, toSlug('Same'), WHEN, 'two\n');
    assert.equal(a.relPath, '_inbox/20261014-123456-same.md');
    assert.equal(b.relPath, '_inbox/20261014-123456-same-2.md');
    assert.equal(fs.readFileSync(path.join(env.vault, a.relPath), 'utf8'), 'one\n');
    assert.equal(fs.statSync(path.join(env.vault, a.relPath)).mode & 0o777, 0o600);
    assert.deepEqual(allFiles(env.vault), ['_inbox/20261014-123456-same-2.md', '_inbox/20261014-123456-same.md', 'keep.md'], 'no temp files left');
  });

  it('refuses an unsanitized slug and a symlinked _inbox/', () => {
    const env = makeEnv();
    assert.throws(() => writeInboxFile(env.vault, '../x' as never, WHEN, 'x'), SafePathError);
    assert.throws(() => writeInboxFile(env.vault, 'a/b' as never, WHEN, 'x'), SafePathError);
    const elsewhere = path.join(env.base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(env.vault, '_inbox'));
    assert.throws(() => writeInboxFile(env.vault, toSlug('x'), WHEN, 'x'), SafePathError);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  it('creates _inbox/ (0700) when missing', () => {
    const env = makeEnv();
    inboxDir(env.vault);
    assert.equal(fs.statSync(path.join(env.vault, '_inbox')).mode & 0o777, 0o700);
  });
});

describe('capture and list_inbox through dispatch', () => {
  it('exist in inbox mode only', () => {
    const env = makeEnv();
    const names = (mode: DispatchContext['mode']) => listTools(mode, env.registry).map((t) => t.name);
    assert.ok(names('inbox').includes('capture') && names('inbox').includes('list_inbox'));
    for (const mode of ['journal', 'read-only'] as const) {
      assert.ok(!names(mode).includes('capture') && !names(mode).includes('list_inbox'), mode);
    }
  });

  it('a capture in journal or read-only mode is an unknown tool and writes nothing', async () => {
    const env = makeEnv();
    for (const mode of ['journal', 'read-only'] as const) {
      const r = await dispatch(env.ctx('agent', mode), 'capture', { title: 'x', body: 'y' });
      assert.equal(r.isError, true);
      assert.match(text(r), /unknown tool/);
    }
    assert.deepEqual(inboxFiles(env.vault), []);
  });

  it('creates _inbox/<stamp>-<slug>.md with the specified frontmatter and indexes it', async () => {
    const env = makeEnv({ 'keep.md': '# Keep\n\nunrelated\n' });
    const r = await dispatch(env.ctx(), 'capture', {
      title: 'Prefer tabs', body: 'We indent with tabs.', kind: 'preference', sources: ['commit:abc1234', 'url:https://example.com/x'],
    });
    assert.notEqual(r.isError, true, text(r));
    const h = headerOf(r);
    assert.equal(h['path'], '_inbox/20261014-123456-prefer-tabs.md');
    assert.equal(h['status'], 'proposed');
    assert.match(String(h['id']), ULID_RE);
    const file = path.join(env.vault, String(h['path']));
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(h['rev'], revOf(raw));
    assert.equal(h['citation'], `note:${String(h['id'])}@${revOf(raw)}`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const fm = frontmatter(file);
    assert.deepEqual(fm, {
      schema: 1, id: h['id'], title: 'Prefer tabs', status: 'proposed', kind: 'preference', created: '2026-10-14T12:34:56Z',
      origin: 'mcp', author: 'tester', sources: ['commit:abc1234', 'url:https://example.com/x'], scrubVersion: 1,
    });
    assert.ok(raw.includes('We indent with tabs.'));

    const listed = await dispatch(env.ctx(), 'list_inbox', {});
    const rows = resultsOf(listed);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['id'], h['id']);
    assert.equal(rows[0]!['status'], 'proposed');
    assert.equal(rows[0]!['folder_class'], 'inbox');
    assert.equal(rows[0]!['tier'], 2);
    assert.equal(rows[0]!['citation'], h['citation']);
    assert.match(String(headerOf(listed)['notice']), /unreviewed proposals/);
    assert.match(String(headerOf(listed)['recall_id']), ULID_RE);
  });

  it('defaults kind, rejects bad sources, author/principal arguments, and bad kinds', async () => {
    const env = makeEnv();
    const ok = await dispatch(env.ctx(), 'capture', { title: 'k', body: '' });
    assert.equal(frontmatter(path.join(env.vault, String(headerOf(ok)['path'])))['kind'], 'idea');
    for (const args of [
      { title: 't', body: 'b', sources: ['not a citation'] },
      { title: 't', body: 'b', author: 'mallory' },
      { title: 't', body: 'b', principal: 'mallory' },
      { title: 't', body: 'b', kind: 'summary' },
      { title: 't', body: 'b', path: '../x.md' },
      { title: '\u0000\n', body: 'b' },
      { title: '', body: 'b' },
    ]) {
      const r = await dispatch(env.ctx(), 'capture', args);
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.equal(inboxFiles(env.vault).length, 1);
  });

  it('hostile titles stay inside _inbox/, never overwrite, and fit length limits', async () => {
    const env = makeEnv({ 'x.md': 'outside x\n', '.obsidian/app.json': '{}' });
    const before = treeChecksum(env.vault);
    const titles = ['../../x', '.obsidian/app', 'y'.repeat(10_000), 'same slug', 'Same Slug', '/etc/passwd', 'C:\\x', '_inbox/../../z'];
    const written: string[] = [];
    for (const title of titles) {
      const r = await dispatch(env.ctx(), 'capture', { title, body: 'b' });
      assert.notEqual(r.isError, true, `${title.slice(0, 20)}: ${text(r)}`);
      const rel = String(headerOf(r)['path']);
      assert.match(rel, /^_inbox\/20261014-123456-[a-z0-9-]+\.md$/);
      assert.ok(Buffer.byteLength(path.basename(rel)) <= 255);
      written.push(rel);
    }
    assert.equal(new Set(written).size, titles.length, 'every capture got its own file');
    assert.ok(written.includes('_inbox/20261014-123456-same-slug.md') && written.includes('_inbox/20261014-123456-same-slug-2.md'));
    // Outside _inbox/ nothing changed.
    fs.rmSync(path.join(env.vault, '_inbox'), { recursive: true });
    assert.equal(treeChecksum(env.vault), before);
  });

  it('human principal: a fake API key is stored as [REDACTED:...]', async () => {
    const env = makeEnv();
    const key = fake.openai();
    const r = await dispatch(env.ctx('human'), 'capture', { title: 'Key note', body: `the key is ${key} ok` });
    assert.notEqual(r.isError, true, text(r));
    const raw = fs.readFileSync(path.join(env.vault, String(headerOf(r)['path'])), 'utf8');
    assert.ok(!raw.includes(key));
    assert.match(raw, /\[REDACTED:openai-key\]/);
    assert.deepEqual(headerOf(r)['redacted'], [{ type: 'openai-key', count: 1 }]);
    assert.ok(!text(r).includes(key));
  });

  it('agent principal: a fake private key, mnemonic, or API key rejects the whole capture and stores nothing', async () => {
    const env = makeEnv();
    const before = allFiles(env.vault);
    const label = ['RSA', 'PRIVATE', 'KEY'].join(' ');
    const pem = `-----BEGIN ${label}-----\n${fake.pemBody(4)}\n-----END ${label}-----`;
    const mnemonic = fake.mnemonic(12);
    const openai = fake.openai();
    const github = fake.github();
    const cases: [string, Record<string, unknown>, string][] = [
      ['private key', { title: 'k', body: `note\n${pem}\n` }, pem.split('\n')[1]!],
      ['mnemonic', { title: 'k', body: `seed: ${mnemonic}` }, mnemonic],
      ['api key', { title: 'k', body: `use ${openai}` }, openai],
      ['api key in the title', { title: `token ${github}`, body: 'clean' }, github],
    ];
    for (const [what, args, secret] of cases) {
      const r = await dispatch(env.ctx('agent'), 'capture', args);
      assert.equal(r.isError, true, what);
      assert.equal(r.structuredContent?.error.type, 'strict-scrub', what);
      assert.ok(!text(r).includes(secret), `${what}: response echoes no secret`);
    }
    assert.deepEqual(allFiles(env.vault), before, 'nothing stored');
    // PII still redacts and continues for agents; a public address is kept.
    const ok = await dispatch(env.ctx('agent'), 'capture', { title: 'pii', body: 'ssn 123-45-6789 at 0x52908400098527886E0F7030069857D2E4169EE7' });
    assert.notEqual(ok.isError, true, text(ok));
    const raw = fs.readFileSync(path.join(env.vault, String(headerOf(ok)['path'])), 'utf8');
    assert.match(raw, /\[REDACTED:us-ssn\]/);
    assert.ok(raw.includes('0x52908400098527886E0F7030069857D2E4169EE7'));
  });

  it('a source carrying credentials is refused (human) or strictly rejected (agent)', async () => {
    const env = makeEnv();
    const src = 'url:https://bob:hunter2pass@example.com/x';
    const human = await dispatch(env.ctx('human'), 'capture', { title: 't', body: 'b', sources: [src] });
    assert.equal(human.isError, true);
    const agent = await dispatch(env.ctx('agent'), 'capture', { title: 't', body: 'b', sources: [src] });
    assert.equal(agent.structuredContent?.error.type, 'strict-scrub');
    assert.deepEqual(inboxFiles(env.vault), []);
  });

  it('config extraPatterns are redacted in captures', async () => {
    const env = makeEnv({}, ['ProjectFalcon']);
    const r = await dispatch(env.ctx(), 'capture', { title: 'codename', body: 'ProjectFalcon ships soon' });
    const raw = fs.readFileSync(path.join(env.vault, String(headerOf(r)['path'])), 'utf8');
    assert.ok(!raw.includes('ProjectFalcon'));
    assert.match(raw, /\[REDACTED:extra-pattern\]/);
  });

  it('search ranks inbox notes below curated ones, labels them proposed, and hides _rejected/_applied', async () => {
    const env = makeEnv({
      'curated.md': '# Curated\n\nzebramarker once.\n',
      '_inbox/claims-accepted.md': '---\nstatus: accepted\n---\nzebramarker zebramarker zebramarker zebramarker\n',
      '_inbox/_rejected/r.md': '---\nstatus: rejected\n---\nzebramarker\n',
      '_inbox/_applied/a.md': '---\nstatus: proposed\n---\nzebramarker\n',
    });
    await dispatch(env.ctx(), 'capture', { title: 'Zebra', body: 'zebramarker zebramarker zebramarker' });
    const r = await dispatch(env.ctx(), 'search', { query: 'zebramarker' });
    const rows = resultsOf(r);
    assert.deepEqual(rows.map((x) => x['tier']), [1, 2, 2]);
    assert.equal(rows[0]!['path'], 'curated.md');
    for (const x of rows.slice(1)) {
      assert.equal(x['status'], 'proposed', 'an inbox note claiming accepted is still a proposal');
      assert.equal(x['folder_class'], 'inbox');
    }
    assert.match(String(headerOf(r)['notice']), /not established facts/);
    const listed = resultsOf(await dispatch(env.ctx(), 'list_inbox', {}));
    assert.deepEqual(listed.map((x) => x['path']).sort(), ['_inbox/20261014-123456-zebra.md', '_inbox/claims-accepted.md']);
    const plain = resultsOf(await dispatch(env.ctx(), 'search', { query: 'once' }));
    assert.equal(headerOf(await dispatch(env.ctx(), 'search', { query: 'once' }))['notice'], undefined);
    assert.equal(plain.length, 1);
  });

  it('list_inbox honors limit, compact format, and max_chars', async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) await dispatch(env.ctx(), 'capture', { title: `p${i}`, body: 'x'.repeat(2000) });
    assert.equal(resultsOf(await dispatch(env.ctx(), 'list_inbox', { limit: 2 })).length, 2);
    for (const x of resultsOf(await dispatch(env.ctx(), 'list_inbox', { format: 'compact' }))) assert.ok(String(x['excerpt']).length <= 200);
    assert.ok(text(await dispatch(env.ctx(), 'list_inbox', { max_chars: 700 })).length <= 700);
  });
});

describe('review gate: accept and reject', () => {
  async function propose(env: Env, title: string, body = 'proposal body'): Promise<{ id: string; rel: string }> {
    const r = await dispatch(env.ctx(), 'capture', { title, body });
    const h = headerOf(r);
    return { id: String(h['id']), rel: String(h['path']) };
  }

  it('accept moves the note to notes/, sets status/accepted, keeps id and unknown keys, changes rev', async () => {
    const env = makeEnv();
    const { id, rel } = await propose(env, 'Ship Friday');
    const src = path.join(env.vault, rel);
    fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace('---\n# ', 'custom_key: kept\n---\n# '));
    const before = fs.readFileSync(src, 'utf8');
    const r = acceptProposal(env.review(), id);
    assert.equal(r.outcome, 'moved');
    assert.equal(r.to, 'notes/ship-friday.md');
    assert.ok(!fs.existsSync(src));
    const dest = path.join(env.vault, r.to);
    const fm = frontmatter(dest);
    assert.equal(fm['id'], id);
    assert.equal(fm['status'], 'accepted');
    assert.equal(fm['accepted'], '2026-10-15T08:00:00Z');
    assert.equal(fm['custom_key'], 'kept');
    assert.equal(fm['schema'], 1);
    assert.equal(fm['author'], 'tester');
    const after = fs.readFileSync(dest, 'utf8');
    assert.equal(splitFrontmatter(after).body, splitFrontmatter(before).body, 'body unchanged');
    assert.notEqual(revOf(after), revOf(before));
    assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
    // Accepted notes are curated (T1) and no longer listed as proposals.
    const found = resultsOf(await dispatch(env.ctx(), 'search', { query: 'proposal body' }));
    assert.deepEqual(found.map((x) => [x['path'], x['tier'], x['status'], x['id']]), [['notes/ship-friday.md', 1, 'accepted', id]]);
    assert.deepEqual(listProposals(env.review()), []);
    // Re-running is a no-op.
    assert.equal(acceptProposal(env.review(), id).outcome, 'already');
  });

  it('accept --to: refuses _inbox/, journal/x, ../x, _raw, _archive, dot-dirs; suffixes an existing name', async () => {
    const env = makeEnv({ 'Ideas/plan.md': 'existing\n' });
    const { id } = await propose(env, 'Plan');
    for (const to of ['_inbox', '_inbox/sub', 'journal/x', '../x', '_raw', '_archive/y', '.obsidian', 'a/.hidden', '/abs', '_Inbox', '']) {
      assert.throws(() => acceptProposal(env.review(), id, { to }), ReviewError, to);
    }
    // A symlink inside the vault that points into _inbox/ is refused too.
    fs.symlinkSync(path.join(env.vault, '_inbox'), path.join(env.vault, 'sneaky'));
    assert.throws(() => acceptProposal(env.review(), id, { to: 'sneaky' }), ReviewError);
    assert.equal(inboxFiles(env.vault).length, 1, 'still in the inbox after refusals');
    const r = acceptProposal(env.review(), id, { to: 'Ideas/' });
    assert.equal(r.to, 'Ideas/plan-2.md');
    assert.equal(fs.readFileSync(path.join(env.vault, 'Ideas/plan.md'), 'utf8'), 'existing\n', 'never overwritten');
    assert.equal(resolveDestination(env.vault, 'new/deep').rel, 'new/deep');
    assert.ok(fs.statSync(path.join(env.vault, 'new/deep')).isDirectory());
  });

  it('a crash between destination write and source unlink is recovered by re-running accept', async () => {
    const env = makeEnv();
    const { id, rel } = await propose(env, 'Crashy');
    assert.throws(() => acceptProposal(env.review({ afterDestinationWrite: () => { throw new Error('simulated crash'); } }), id), /simulated crash/);
    assert.ok(fs.existsSync(path.join(env.vault, rel)), 'source still there');
    assert.ok(fs.existsSync(path.join(env.vault, 'notes/crashy.md')), 'destination written first');
    const r = acceptProposal(env.review(), id);
    assert.equal(r.outcome, 'recovered');
    assert.equal(r.to, 'notes/crashy.md');
    assert.ok(!fs.existsSync(path.join(env.vault, rel)));
    assert.deepEqual(allFiles(env.vault).filter((f) => f.endsWith('.md')), ['notes/crashy.md'], 'no second copy');
  });

  it('a duplicate id that is not an interrupted accept is refused', async () => {
    const env = makeEnv();
    const { id } = await propose(env, 'Dup');
    fs.mkdirSync(path.join(env.vault, 'other'));
    fs.writeFileSync(path.join(env.vault, 'other/copy.md'), `---\nid: ${id}\nstatus: proposed\n---\nhand copy\n`);
    assert.throws(() => acceptProposal(env.review(), id), /resolve the duplicate/);
  });

  it('reject moves to _inbox/_rejected/ (kept) with status rejected and the reason; hidden afterwards', async () => {
    const env = makeEnv();
    const { id, rel } = await propose(env, 'Bad idea');
    const r = rejectProposal(env.review(), id, { reason: 'not true\nat all' });
    assert.equal(r.outcome, 'moved');
    assert.equal(r.to, `_inbox/_rejected/${path.basename(rel)}`);
    assert.ok(!fs.existsSync(path.join(env.vault, rel)));
    const fm = frontmatter(path.join(env.vault, r.to));
    assert.equal(fm['status'], 'rejected');
    assert.equal(fm['id'], id);
    assert.equal(fm['rejected'], '2026-10-15T08:00:00Z');
    assert.equal(fm['rejected_reason'], 'not true at all');
    assert.deepEqual(resultsOf(await dispatch(env.ctx(), 'list_inbox', {})), []);
    assert.deepEqual(resultsOf(await dispatch(env.ctx(), 'search', { query: 'proposal body' })), []);
    assert.equal(showProposal(env.review(), id).path, r.to);
    assert.throws(() => acceptProposal(env.review(), id), ReviewError, 'a rejected proposal is not accepted by id');
    // Crash recovery works for reject too.
    const second = await propose(env, 'Also bad');
    assert.throws(() => rejectProposal(env.review({ afterDestinationWrite: () => { throw new Error('boom'); } }), second.id), /boom/);
    assert.equal(rejectProposal(env.review(), second.id).outcome, 'recovered');
    assert.ok(!fs.existsSync(path.join(env.vault, second.rel)));
  });

  it('a hand-placed inbox note without an id is accepted by its provisional id and gets a ULID', () => {
    const env = makeEnv({ '_inbox/hand.md': 'Hand-written idea.\n' });
    const [p] = listProposals(env.review());
    assert.ok(p && p.provisional && p.id.startsWith('prov_'));
    const r = acceptProposal(env.review(), p.id);
    const fm = frontmatter(path.join(env.vault, r.to));
    assert.match(String(fm['id']), ULID_RE);
    assert.equal(r.id, fm['id']);
    assert.equal(fm['status'], 'accepted');
    assert.equal(fm['schema'], 1);
    assert.equal(r.to, 'notes/hand.md');
  });

  it('setFrontmatter preserves keys and body; refuses malformed frontmatter', () => {
    const out = setFrontmatter('---\nb: 1\nstatus: proposed\n---\nbody\n---\nmore\n', { status: 'accepted', accepted: '2026-01-01T00:00:00Z' });
    assert.equal(out, '---\nb: 1\nstatus: accepted\naccepted: 2026-01-01T00:00:00Z\n---\nbody\n---\nmore\n');
    assert.equal(setFrontmatter('plain\n', { status: 'accepted' }), '---\nstatus: accepted\n---\nplain\n');
    assert.throws(() => setFrontmatter('---\na: [\n---\nx\n', { status: 'accepted' }), ReviewError);
    assert.throws(() => setFrontmatter('---\na: 1\nno close\n', { status: 'accepted' }), ReviewError);
    assert.equal(destinationStem('_inbox/20261014-123456-slug.md'), 'slug');
    assert.equal(destinationStem('_inbox/My Idea.md'), 'My Idea');
  });
});

// Static scan (Phase 8 acceptance): src/mcp/ performs no filesystem writes;
// its only route to the vault is the inbox writer, and it never imports the
// CLI review module.
const WRITE_CALLS = /\b(?:createExclusive|writeAtomic|renameSafe|unlinkSafe|mkdirSafe|appendSafe|ensurePrivateDir|ensureOwnerDir|writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|openSync|linkSync|symlinkSync|copyFileSync|writeSync)\b/;

export function mcpWriteOffenders(root: string): string[] {
  const dir = path.join(root, 'src', 'mcp');
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const rel = `src/mcp/${name}`;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (WRITE_CALLS.test(src)) offenders.push(`${rel}: filesystem write call`);
    if (/from\s+['"]node:fs|from\s+['"]fs['"]/.test(src)) offenders.push(`${rel}: imports node:fs`);
    for (const m of src.matchAll(/from\s+['"](\.\.\/inbox\/[^'"]+)['"]/g)) {
      if (m[1] !== '../inbox/writer.js' && m[1] !== '../inbox/note.js') offenders.push(`${rel}: imports ${m[1]}`);
    }
    if (/\bwriteInboxFile\b/.test(src) && name !== 'inbox-tools.ts') offenders.push(`${rel}: uses the inbox writer outside the inbox tools`);
    if (/\.\.\/exec\//.test(src) || /\.\.\/cli\//.test(src)) offenders.push(`${rel}: imports exec/ or cli/`);
  }
  // The writer module itself writes only through createExclusive / mkdirSafe.
  const writer = fs.readFileSync(path.join(root, 'src', 'inbox', 'writer.ts'), 'utf8');
  for (const call of ['writeAtomic', 'renameSafe', 'unlinkSafe', 'appendSafe']) {
    if (new RegExp(`\\b${call}\\b`).test(writer)) offenders.push(`src/inbox/writer.ts: uses ${call}`);
  }
  if (/\.\.\/inbox\/review/.test(fs.readFileSync(path.join(root, 'src', 'inbox', 'writer.ts'), 'utf8'))) offenders.push('writer imports review');
  return offenders;
}

describe('static scan: no filesystem writes in src/mcp/ outside the inbox writer', () => {
  it('src/mcp/ has no write calls and reaches the vault only through src/inbox/writer.ts', () => {
    assert.deepEqual(mcpWriteOffenders(repoRoot()), []);
  });

  it('the scan detects write calls', () => {
    assert.ok(WRITE_CALLS.test('createExclusive(p, x)'));
    assert.ok(WRITE_CALLS.test('fs.writeFileSync(p, x)'));
    assert.ok(!WRITE_CALLS.test('readFileSafe(p)'));
  });
});
