// Cognition Phase 1: the undo store (src/undo/store.ts). Rewrite, create,
// and move ops; byte-for-byte restore; refusal after an edit; rollback of a
// failed or crashed operation; hostile operation ids and paths; and undo
// data only under <stateDir>/undo/.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import {
  APPLY_LOCK, listOperations, readManifest, recoverPending, restore, runOperation, sha256, UndoError, UNDO_DIR, type UndoEnv,
} from '../src/undo/store.js';
import { mode, realTmpDir, rmrf, treeChecksum } from './helpers.js';

const bases: string[] = [];
after(() => bases.forEach(rmrf));

interface Env extends UndoEnv {
  base: string;
  stateDir: SafePath;
  write: (rel: string, content: string | Buffer) => void;
  read: (rel: string) => Buffer;
  exists: (rel: string) => boolean;
}

function setup(files: Record<string, string> = {}): Env {
  const base = realTmpDir('ebrain-undo-');
  bases.push(base);
  const vaultPath = path.join(base, 'vault');
  fs.mkdirSync(vaultPath);
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(vaultPath, rel)), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return {
    base, vaultPath, stateDir, write,
    read: (rel) => fs.readFileSync(path.join(vaultPath, rel)),
    exists: (rel) => fs.existsSync(path.join(vaultPath, rel)),
  };
}

const B = (s: string) => Buffer.from(s, 'utf8');

function undoNamesInVault(vault: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/undo/i.test(e.name)) out.push(path.join(d, e.name));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name));
    }
  };
  walk(vault);
  return out;
}

describe('undo store', () => {
  it('rewrite, create, and move are recorded and restored byte for byte', () => {
    const env = setup({ 'notes/a.md': '---\ntitle: A\n---\r\nbody A\n', 'notes/b.md': 'b body', 'c.md': 'c' });
    fs.chmodSync(path.join(env.vaultPath, 'notes/a.md'), 0o644);
    const before = treeChecksum(env.vaultPath);
    const m = runOperation(env, 'test op', [
      { type: 'rewrite', path: 'notes/a.md', data: B('---\nid: X\ntitle: A\n---\r\nbody A\n') },
      { type: 'create', path: 'new/dir/n.md', data: B('created') },
      { type: 'move', from: 'notes/b.md', path: '_archive/notes/b.md' },
    ])!;
    assert.equal(m.status, 'committed');
    assert.equal(m.command, 'test op');
    assert.deepEqual(m.ops.map((o) => o.type), ['rewrite', 'create', 'move']);
    assert.equal(env.read('notes/a.md').toString(), '---\nid: X\ntitle: A\n---\r\nbody A\n');
    assert.equal(mode(path.join(env.vaultPath, 'notes/a.md')), 0o644, 'rewrite keeps the file mode');
    assert.equal(env.read('new/dir/n.md').toString(), 'created');
    assert.ok(!env.exists('notes/b.md') && env.exists('_archive/notes/b.md'));

    const rw = m.ops[0]!;
    assert.equal(rw.type === 'rewrite' && rw.sha256_before, sha256(B('---\ntitle: A\n---\r\nbody A\n')));
    assert.equal(rw.sha256_after, sha256(B('---\nid: X\ntitle: A\n---\r\nbody A\n')));
    const mv = m.ops[2]!;
    assert.ok(mv.type === 'move' && mv.from === 'notes/b.md' && mv.path === '_archive/notes/b.md');

    // Stored under <stateDir>/undo/<id>/ with private modes; the original keeps its relative path.
    const dir = path.join(env.stateDir, UNDO_DIR, m.operation_id);
    const saved = path.join(dir, 'files', 'notes', 'a.md');
    assert.equal(fs.readFileSync(saved).toString(), '---\ntitle: A\n---\r\nbody A\n');
    assert.equal(mode(saved), 0o600);
    assert.equal(mode(path.join(dir, 'manifest.json')), 0o600);
    assert.equal(mode(dir), 0o700);
    assert.equal(fs.readdirSync(path.join(dir, 'files')).join(), 'notes', 'create and move save no original');
    assert.deepEqual(undoNamesInVault(env.vaultPath), []);

    const r = restore(env, m.operation_id);
    assert.equal(r.status, 'rolled_back');
    assert.equal(readManifest(env, m.operation_id).status, 'rolled_back');
    // The created file is removed (C10 undo exception); its new folders stay, empty.
    fs.rmSync(path.join(env.vaultPath, 'new'), { recursive: true });
    fs.rmSync(path.join(env.vaultPath, '_archive'), { recursive: true });
    assert.equal(treeChecksum(env.vaultPath), before);
    assert.throws(() => restore(env, m.operation_id), (e: unknown) => e instanceof UndoError && e.code === 'state');
  });

  it('refuses to undo when any affected file was edited (or removed) since, changing nothing', () => {
    const env = setup({ 'a.md': 'one', 'b.md': 'two' });
    const m = runOperation(env, 'test op', [
      { type: 'rewrite', path: 'a.md', data: B('ONE') },
      { type: 'rewrite', path: 'b.md', data: B('TWO') },
    ])!;
    env.write('b.md', 'TWO edited in Obsidian');
    assert.throws(() => restore(env, m.operation_id), (e: unknown) => e instanceof UndoError && e.code === 'conflict' && /b\.md was edited/.test(e.message));
    assert.equal(env.read('a.md').toString(), 'ONE', 'nothing reversed');
    assert.equal(readManifest(env, m.operation_id).status, 'committed');
    fs.rmSync(path.join(env.vaultPath, 'b.md'));
    assert.throws(() => restore(env, m.operation_id), /b\.md was removed/);
    env.write('b.md', 'TWO');
    restore(env, m.operation_id);
    assert.equal(env.read('a.md').toString(), 'one');
    assert.equal(env.read('b.md').toString(), 'two');
  });

  it('refuses a move undo when the source path is occupied again, and a create undo when the file was edited', () => {
    const env = setup({ 'a.md': 'a' });
    const mv = runOperation(env, 'test op', [{ type: 'move', from: 'a.md', path: 'x/a.md' }])!;
    env.write('a.md', 'someone else');
    assert.throws(() => restore(env, mv.operation_id), /a\.md exists again/);
    fs.rmSync(path.join(env.vaultPath, 'a.md'));
    restore(env, mv.operation_id);
    assert.equal(env.read('a.md').toString(), 'a');

    const cr = runOperation(env, 'test op', [{ type: 'create', path: 'n.md', data: B('n') }])!;
    env.write('n.md', 'n plus edits');
    assert.throws(() => restore(env, cr.operation_id), /n\.md was edited/);
    assert.equal(env.read('n.md').toString(), 'n plus edits', 'an edited created file is never removed');
  });

  it('plans are validated before anything is written', () => {
    const env = setup({ 'a.md': 'a', 'b.md': 'b' });
    const before = treeChecksum(env.vaultPath);
    const cases: [string, Parameters<typeof runOperation>[2]][] = [
      ['stale expectation', [{ type: 'rewrite', path: 'a.md', data: B('A'), expectSha256: sha256(B('not a')) }]],
      ['missing rewrite target', [{ type: 'rewrite', path: 'nope.md', data: B('x') }]],
      ['create over an existing file', [{ type: 'rewrite', path: 'a.md', data: B('A') }, { type: 'create', path: 'b.md', data: B('x') }]],
      ['move onto an existing file', [{ type: 'move', from: 'a.md', path: 'b.md' }]],
      ['same path twice', [{ type: 'rewrite', path: 'a.md', data: B('A') }, { type: 'rewrite', path: 'a.md', data: B('AA') }]],
    ];
    for (const [label, plan] of cases) assert.throws(() => runOperation(env, 'test op', plan), UndoError, label);
    assert.equal(treeChecksum(env.vaultPath), before);
    assert.deepEqual(listOperations(env), []);
    assert.equal(runOperation(env, 'test op', []), undefined, 'an empty plan creates no operation');
    assert.ok(!fs.existsSync(path.join(env.stateDir, UNDO_DIR)));
  });

  it('a conflict part-way through rolls back the ops already published', () => {
    const env = setup({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
    const m = () =>
      runOperation({ ...env, afterPublish: (i) => i === 0 && env.write('c.md', 'edited meanwhile') }, 'test op', [
        { type: 'rewrite', path: 'a.md', data: B('A') },
        { type: 'create', path: 'new.md', data: B('new') },
        { type: 'rewrite', path: 'c.md', data: B('C') },
      ]);
    assert.throws(m, (e: unknown) => e instanceof UndoError && e.code === 'conflict' && /c\.md changed/.test(e.message));
    assert.equal(env.read('a.md').toString(), 'a');
    assert.ok(!env.exists('new.md'));
    assert.equal(env.read('c.md').toString(), 'edited meanwhile', 'the outside edit is kept');
    const [op] = listOperations(env);
    assert.equal(op!.status, 'rolled_back');
  });

  it('a crash leaves a pending manifest that recovery (and the next operation) rolls back', () => {
    const env = setup({ 'a.md': 'a', 'b.md': 'b' });
    const storeUrl = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'undo', 'store.js')).href;
    const code = `
      const { runOperation } = await import(${JSON.stringify(storeUrl)});
      const env = { vaultPath: ${JSON.stringify(env.vaultPath)}, stateDir: ${JSON.stringify(env.stateDir)}, afterPublish: (i) => { if (i === 1) process.exit(9); } };
      const B = (s) => Buffer.from(s);
      runOperation(env, 'crash op', [
        { type: 'rewrite', path: 'a.md', data: B('A') },
        { type: 'move', from: 'b.md', path: 'moved/b.md' },
        { type: 'create', path: 'c.md', data: B('c') },
      ]);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 9, r.stderr);
    const [pending] = listOperations(env);
    assert.equal(pending!.status, 'pending');
    assert.equal(env.read('a.md').toString(), 'A');
    assert.ok(env.exists('moved/b.md'), 'op 1 was published but not recorded done');
    // The crashed process's apply lock is stale-broken by age; remove it to keep the test fast.
    fs.rmSync(path.join(env.stateDir, 'locks', `${APPLY_LOCK}.lock`), { force: true });
    assert.deepEqual(recoverPending(env), [pending!.operation_id]);
    assert.equal(env.read('a.md').toString(), 'a');
    assert.equal(env.read('b.md').toString(), 'b');
    assert.ok(!env.exists('moved/b.md') && !env.exists('c.md'));
    assert.equal(readManifest(env, pending!.operation_id).status, 'rolled_back');
    assert.deepEqual(recoverPending(env), []);
  });

  it('hostile operation ids are rejected before touching the filesystem', () => {
    const env = setup({ 'a.md': 'a' });
    for (const id of ['../../etc', '/etc/passwd', '..', '', 'manifest.json', '01ARZ3NDEKTSV4RRFFQ69G5FA/', '01ARZ3NDEKTSV4RRFFQ69G5FAV/../x', '01arz3ndektsv4rrffq69g5fav']) {
      assert.throws(() => restore(env, id), (e: unknown) => e instanceof UndoError && e.code === 'invalid', JSON.stringify(id));
    }
    assert.throws(() => restore(env, '01ARZ3NDEKTSV4RRFFQ69G5FAV'), (e: unknown) => e instanceof UndoError && e.code === 'not-found');
  });

  it('hostile op paths (dot segments, absolute, hidden, symlink escape) are rejected', () => {
    const env = setup({ 'a.md': 'a' });
    const outside = path.join(env.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
    fs.symlinkSync(outside, path.join(env.vaultPath, 'link'));
    const sums = () => [treeChecksum(env.vaultPath), treeChecksum(outside)];
    const before = sums();
    for (const p of ['../outside/secret.md', '/etc/passwd', path.join(outside, 'secret.md'), 'link/secret.md', '.ebrain-undo/x.md', '.obsidian/x.md', 'a/../../x.md', 'a\\..\\x.md']) {
      assert.throws(() => runOperation(env, 'test op', [{ type: 'rewrite', path: p, data: B('x') }]), UndoError, p);
      assert.throws(() => runOperation(env, 'test op', [{ type: 'create', path: p, data: B('x') }]), UndoError, p);
      assert.throws(() => runOperation(env, 'test op', [{ type: 'move', from: 'a.md', path: p }]), UndoError, p);
    }
    assert.deepEqual(sums(), before);
    assert.ok(!fs.existsSync(path.join(env.stateDir, UNDO_DIR)));
  });

  it('a tampered manifest cannot redirect a restore outside the vault', () => {
    const env = setup({ 'a.md': 'a' });
    const outside = path.join(env.base, 'victim.md');
    fs.writeFileSync(outside, 'victim');
    const m = runOperation(env, 'test op', [{ type: 'rewrite', path: 'a.md', data: B('A') }])!;
    const file = path.join(env.stateDir, UNDO_DIR, m.operation_id, 'manifest.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of ['../victim.md', outside]) {
      raw.ops[0].path = p;
      fs.writeFileSync(file, JSON.stringify(raw));
      assert.throws(() => restore(env, m.operation_id), (e: unknown) => e instanceof UndoError && e.code === 'invalid');
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'victim');
    assert.equal(env.read('a.md').toString(), 'A');
  });

  it('a symlinked undo directory escaping the state dir is refused', () => {
    const env = setup({ 'a.md': 'a' });
    const elsewhere = path.join(env.base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(env.stateDir, UNDO_DIR));
    assert.throws(() => runOperation(env, 'test op', [{ type: 'rewrite', path: 'a.md', data: B('A') }]), /escapes/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    assert.equal(env.read('a.md').toString(), 'a');
  });

  it('lists operations newest first', () => {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const env = setup({ 'a.md': 'a' });
    const clock = { ...env, now: () => new Date((t += 1000)) };
    const first = runOperation(clock, 'first op', [{ type: 'rewrite', path: 'a.md', data: B('1') }])!;
    const second = runOperation(clock, 'second op', [{ type: 'rewrite', path: 'a.md', data: B('2') }])!;
    assert.deepEqual(listOperations(env).map((m) => m.operation_id), [second.operation_id, first.operation_id]);
    assert.throws(() => restore(env, first.operation_id), /edited/, 'the older op is stale once the file moved on');
  });
});
