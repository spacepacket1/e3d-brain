// Cognition Phase 1: `ebrain ids assign` (src/ids/assign.ts) and the
// `ebrain ids|undo` CLI. Dry run writes nothing; a real run adds ids only to
// notes lacking them and changes no other byte; undo restores originals
// byte for byte; the old provisional id resolves as an alias until a full
// rebuild; undo refuses after an edit; no undo data ever lands in the vault.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runIds, runUndo } from '../src/cli/undo-commands.js';
import { checkNoteCitation } from '../src/cite/citation.js';
import { citingNotes, missingIdentities, noteIdentityById, noteIdentityByPath, noteLookup } from '../src/index/identity.js';
import { closeIndex, openIndex, refreshIndex, reindex } from '../src/index/indexer.js';
import { assignIds, insertId } from '../src/ids/assign.js';
import { ULID_RE } from '../src/mcp/ulid.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import { listOperations, UNDO_DIR } from '../src/undo/store.js';
import { parseNote } from '../src/vault/parse.js';
import { realTmpDir, rmrf, treeChecksum, writeTestConfig } from './helpers.js';

const bases: string[] = [];
after(() => bases.forEach(rmrf));

const FIXTURE: Record<string, string | Buffer> = {
  'notes/plain.md': '# Plain\n\nNo frontmatter at all.\n',
  'notes/fm.md': '---\ntitle: With FM\ntags: [a, b]\npinned: true\ncustom_key: {nested: 1}\n---\nBody text\n\n- list\n',
  'notes/has-id.md': '---\nid: 01HAVEID00000000000000000A\ntitle: Has id\n---\nalready\n',
  'notes/schema2.md': '---\nschema: 2\nstatus: accepted\n---\nschema two\n',
  'notes/crlf.md': '---\r\ntitle: CRLF\r\n---\r\nwindows body\r\n',
  'notes/bom.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\ntitle: BOM\n---\nbom body\n')]),
  'notes/bom-plain.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom without frontmatter\n')]),
  'notes/empty-fm.md': '---\n---\nempty frontmatter\n',
  'notes/comment-fm.md': '---\n# a comment\ntitle: Commented\n---\nbody\n',
  'notes/malformed.md': '---\ntitle: [unclosed\n---\nbad yaml\n',
  'notes/flow.md': '---\n{title: Flow}\n---\nflow mapping\n',
  'notes/bad-id.md': '---\nid: 123\n---\nnumeric id\n',
  'notes/dup-a.md': '---\nid: SAME_ID\n---\nfirst\n',
  'notes/dup-b.md': '---\nid: SAME_ID\n---\nsecond\n',
  'journal/bot/2026/20260101-000000-x.md': '---\nstatus: journal\n---\njournal entry\n',
  '_raw/conversations/claude-code/x.md': '---\nkind: raw\n---\nraw transcript\n',
  'other/o.md': 'other folder\n',
};
const EXPECT_ASSIGNED = [
  'journal/bot/2026/20260101-000000-x.md', 'notes/bom-plain.md', 'notes/bom.md', 'notes/comment-fm.md', 'notes/crlf.md',
  'notes/empty-fm.md', 'notes/fm.md', 'notes/plain.md', 'notes/schema2.md', 'other/o.md',
];

interface Env {
  base: string;
  vault: string;
  stateDir: SafePath;
  write: (rel: string, content: string | Buffer) => void;
  read: (rel: string) => Buffer;
}

function setup(files: Record<string, string | Buffer> = FIXTURE): Env {
  const base = realTmpDir('ebrain-ids-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault);
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return { base, vault, stateDir, write, read: (rel) => fs.readFileSync(path.join(vault, rel)) };
}

/** Ways to take the inserted `id:` line (and `schema: 1` line, or the whole new block) back out. */
function stripInserted(data: Buffer, id: string): Buffer[] {
  const s = data.toString('latin1');
  const block = new RegExp(`^(\\xef\\xbb\\xbf)?---(\\r?\\n)id: ${id}\\2schema: 1\\2---\\2`);
  const lines = new RegExp(`id: ${id}(\\r?\\n)(schema: 1\\1)?`);
  return [s.replace(block, '$1'), s.replace(lines, '')].map((x) => Buffer.from(x, 'latin1'));
}

function assertNoVaultUndo(vault: string): void {
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      assert.ok(!/undo/i.test(e.name), `undo data in the vault: ${path.join(d, e.name)}`);
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(vault);
}

describe('insertId', () => {
  it('inserts id (and schema: 1 when absent) and nothing else', () => {
    const id = '01JTESTID0000000000000000A';
    const r = insertId(Buffer.from('---\ntitle: T\n---\nbody\n'), id);
    assert.ok(r.ok);
    assert.equal(r.data.toString(), `---\nid: ${id}\nschema: 1\ntitle: T\n---\nbody\n`);
    const s = insertId(Buffer.from('---\nschema: 3\n---\nbody'), id);
    assert.ok(s.ok);
    assert.equal(s.data.toString(), `---\nid: ${id}\nschema: 3\n---\nbody`);
    const n = insertId(Buffer.from(''), id);
    assert.ok(n.ok);
    assert.equal(parseNote('x.md', n.data).fields.id, id);
  });

  it('refuses edits it cannot make safely', () => {
    const id = '01JTESTID0000000000000000A';
    for (const [text, reason] of [
      ['---\ntitle: [x\n---\n', /malformed/],
      ['---\ntitle: x\n', /malformed/],
      ['---\n{title: x}\n---\n', /block mapping/],
      ['---\n- a\n- b\n---\n', /malformed|block mapping/],
      ['---\nid: 5\n---\n', /id key/],
      ['---\n  title: indented\n---\n', /other frontmatter/],
    ] as const) {
      const r = insertId(Buffer.from(text), id);
      assert.ok(!r.ok, text);
      assert.match(r.reason, reason, text);
    }
  });
});

describe('ids assign', () => {
  it('--dry-run changes nothing; a real run adds ids only where missing; undo restores byte for byte', () => {
    const env = setup();
    const before = treeChecksum(env.vault);
    const originals = new Map(Object.keys(FIXTURE).map((rel) => [rel, env.read(rel)]));

    const dry = assignIds({ vaultPath: env.vault, stateDir: env.stateDir, dryRun: true });
    assert.deepEqual(dry.assigned.map((a) => a.path), EXPECT_ASSIGNED);
    assert.equal(dry.operationId, undefined);
    assert.equal(treeChecksum(env.vault), before, 'dry run wrote to the vault');
    assert.ok(!fs.existsSync(path.join(env.stateDir, UNDO_DIR)), 'dry run created undo data');

    const r = assignIds({ vaultPath: env.vault, stateDir: env.stateDir });
    assert.deepEqual(r.assigned.map((a) => a.path), EXPECT_ASSIGNED);
    assert.deepEqual(
      r.skipped.map((s) => s.path).sort(),
      ['_raw/conversations/claude-code/x.md', 'notes/bad-id.md', 'notes/dup-b.md', 'notes/flow.md', 'notes/malformed.md'],
    );
    assert.ok(r.operationId !== undefined && ULID_RE.test(r.operationId));
    assert.equal(r.aliases, EXPECT_ASSIGNED.length);
    for (const a of r.assigned) {
      assert.match(a.id, ULID_RE);
      assert.match(a.previous, /^prov_/);
      const now = env.read(a.path);
      const was = originals.get(a.path)!;
      assert.ok(stripInserted(now, a.id).some((b) => b.equals(was)), `${a.path}: only the id lines may differ`);
      const p0 = parseNote(a.path, was);
      const p1 = parseNote(a.path, now);
      assert.equal(p1.fields.id, a.id);
      assert.equal(p1.body, p0.body);
      assert.deepEqual({ ...p1.fields, id: null, schema: null }, { ...p0.fields, id: null, schema: null });
      assert.deepEqual(p1.extra, p0.extra);
      assert.equal(p1.fields.schema, p0.fields.schema ?? 1);
    }
    assert.equal(parseNote('fm.md', env.read('notes/fm.md')).fields.pinned, true, 'pinned is kept as a flag');
    assert.ok(env.read('notes/crlf.md').toString().startsWith('---\r\nid: '), 'CRLF notes get CRLF lines');
    assert.deepEqual([...env.read('notes/bom.md').subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM stays first');
    for (const rel of Object.keys(FIXTURE)) {
      if (!EXPECT_ASSIGNED.includes(rel)) assert.deepEqual(env.read(rel), originals.get(rel), `${rel} must be untouched`);
    }
    assertNoVaultUndo(env.vault);

    // A second run finds nothing to do and creates no operation.
    const again = assignIds({ vaultPath: env.vault, stateDir: env.stateDir });
    assert.equal(again.assigned.length, 0);
    assert.equal(again.operationId, undefined);
    assert.equal(listOperations({ vaultPath: env.vault, stateDir: env.stateDir }).length, 1);

    const out = runUndo([r.operationId], { env: { EBRAIN_CONFIG: writeTestConfig(env.base, env.vault, env.stateDir) }, homeDir: env.base });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`undo ${r.operationId}: restored ${EXPECT_ASSIGNED.length} files \\(ids assign\\)`));
    assert.equal(treeChecksum(env.vault), before, 'undo did not restore every original byte for byte');
    assertNoVaultUndo(env.vault);
  });

  it('the old provisional id resolves as an alias until a full rebuild', () => {
    const env = setup({ 'notes/a.md': '# A\n\nalpha wombat\n', 'notes/citer.md': '' });
    const h = openIndex({ vaultPath: env.vault, stateDir: env.stateDir });
    refreshIndex(h);
    const prov = noteIdentityByPath(h.db, 'notes/a.md')!;
    assert.equal(prov.provisional, true);
    // A note citing the provisional id (made before assignment).
    env.write('notes/citer.md', `---\nid: 01CITER000000000000000000A\nsources: ["note:${prov.id}@${prov.rev}"]\n---\ncites a\n`);
    closeIndex(h);

    const r = assignIds({ vaultPath: env.vault, stateDir: env.stateDir, folder: 'notes' });
    const a = r.assigned.find((x) => x.path === 'notes/a.md')!;
    assert.equal(a.previous, prov.id);

    const h2 = openIndex({ vaultPath: env.vault, stateDir: env.stateDir });
    refreshIndex(h2);
    const resolved = noteIdentityById(h2.db, prov.id);
    assert.deepEqual(resolved && { path: resolved.path, id: resolved.id, provisional: resolved.provisional }, { path: 'notes/a.md', id: a.id, provisional: false });
    assert.equal(checkNoteCitation({ kind: 'note', id: prov.id, rev: prov.rev }, noteLookup(h2.db)), 'stale', 'the note changed, so the old citation is stale, not missing');
    assert.deepEqual(citingNotes(h2.db, a.id).map((c) => c.fromPath), ['notes/citer.md']);

    // Renamed and edited in one step: the prov_id no longer follows, but the alias does.
    fs.renameSync(path.join(env.vault, 'notes/a.md'), path.join(env.vault, 'notes/a-renamed.md'));
    fs.appendFileSync(path.join(env.vault, 'notes/a-renamed.md'), 'more\n');
    refreshIndex(h2);
    assert.equal(noteIdentityById(h2.db, prov.id)?.path, 'notes/a-renamed.md');
    assert.ok(noteLookup(h2.db)(prov.id) !== undefined);
    assert.ok(!missingIdentities(h2.db).some((m) => m.id === prov.id), 'an aliased id is not reported missing');

    reindex(h2, { full: true });
    assert.equal(noteIdentityById(h2.db, prov.id), undefined, 'aliases are best effort: a full rebuild drops them');
    assert.equal(noteIdentityById(h2.db, a.id)?.path, 'notes/a-renamed.md');
    closeIndex(h2);
  });

  it('undo refuses when an assigned note was edited afterwards', () => {
    const env = setup({ 'a.md': 'a\n', 'b.md': 'b\n' });
    const r = assignIds({ vaultPath: env.vault, stateDir: env.stateDir });
    fs.appendFileSync(path.join(env.vault, 'b.md'), 'edited\n');
    const config = writeTestConfig(env.base, env.vault, env.stateDir);
    const out = runUndo([r.operationId!], { env: { EBRAIN_CONFIG: config }, homeDir: env.base });
    assert.equal(out.code, 1);
    assert.match(out.stderr, /b\.md was edited after operation .*refusing to undo/);
    assert.match(env.read('a.md').toString(), /^---\nid: /, 'nothing was reversed');
  });

  it('--folder limits the run; hostile folders are rejected', () => {
    const env = setup({ 'notes/a.md': 'a', 'other/b.md': 'b', 'notesx/c.md': 'c' });
    const r = assignIds({ vaultPath: env.vault, stateDir: env.stateDir, folder: 'notes/' });
    assert.deepEqual(r.assigned.map((a) => a.path), ['notes/a.md']);
    const outside = path.join(env.base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(env.vault, 'link'));
    for (const f of ['../outside', '/etc', 'link', '.obsidian', 'missing']) {
      assert.throws(() => assignIds({ vaultPath: env.vault, stateDir: env.stateDir, folder: f }), f);
    }
  });

  it('a note edited between planning and publishing is not overwritten', () => {
    const env = setup({ 'a.md': 'a' });
    let calls = 0;
    const r = () => assignIds({
      vaultPath: env.vault,
      stateDir: env.stateDir,
      newId: () => {
        if (calls++ === 0) env.write('a.md', 'edited by a human');
        return `01JRACE${String(calls).padStart(19, '0')}`;
      },
    });
    assert.throws(r, /changed since it was read/);
    assert.equal(env.read('a.md').toString(), 'edited by a human');
  });
});

describe('ids and undo CLI', () => {
  it('ids assign prints what it did and the undo command; undo --list shows it', () => {
    const env = setup({ 'notes/a.md': 'a\n', 'notes/b.md': '---\nid: 01HAVEID00000000000000000A\n---\nb\n' });
    const opts = { env: { EBRAIN_CONFIG: writeTestConfig(env.base, env.vault, env.stateDir) }, homeDir: env.base };
    const dry = runIds(['assign', '--dry-run'], opts);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^would assign notes\/a\.md$/m);
    assert.match(dry.stdout, /1 would assign, 0 skipped \(dry run: nothing written\)/);
    const real = runIds(['assign', '--folder', 'notes'], opts);
    assert.equal(real.code, 0, real.stderr);
    const op = /undo with: ebrain undo ([0-9A-Z]{26})/.exec(real.stdout)?.[1];
    assert.ok(op, real.stdout);
    assert.match(real.stdout, /^assigned [0-9A-Z]{26} notes\/a\.md \(was prov_[0-9a-f]+\)$/m);
    const list = runUndo(['--list'], opts);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, new RegExp(`^${op}  \\S+  committed    ids assign  \\(1 ops\\)$`, 'm'));
    assert.equal(runUndo([op], opts).code, 0);
    assert.match(runUndo(['--list'], opts).stdout, /rolled_back/);
    assert.equal(runUndo([op], opts).code, 1, 'a second undo is refused');
  });

  it('rejects bad arguments and hostile operation ids', () => {
    const env = setup({ 'a.md': 'a' });
    const opts = { env: { EBRAIN_CONFIG: writeTestConfig(env.base, env.vault, env.stateDir) }, homeDir: env.base };
    assert.equal(runIds([], opts).code, 2);
    assert.equal(runIds(['assign', '--bogus'], opts).code, 2);
    assert.equal(runIds(['assign', '--folder'], opts).code, 2);
    assert.equal(runUndo([], opts).code, 2);
    assert.equal(runUndo(['--force'], opts).code, 2);
    for (const id of ['../../etc/passwd', '/etc/passwd', '..', 'ZZZ']) {
      const r = runUndo([id], opts);
      assert.equal(r.code, 1, id);
      assert.match(r.stderr, /operation id must be a 26-character ULID/);
    }
    const f = runIds(['assign', '--folder', '../x'], opts);
    assert.equal(f.code, 1);
    assert.equal(fs.existsSync(path.join(env.stateDir, UNDO_DIR)), false);
  });
});
