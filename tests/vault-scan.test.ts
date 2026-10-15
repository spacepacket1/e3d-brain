import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanVault } from '../src/vault/scan.js';
import { readFileWithStatSafe, resolveInVault, SafePathError, statBigSafe, vaultChild } from '../src/safe-path.js';
import { lexicalTmpDir, realTmpDir, rmrf } from './helpers.js';

const bases: string[] = [];
after(() => bases.forEach(rmrf));

function vaultWith(files: Record<string, string>): string {
  const base = realTmpDir('ebrain-scan-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), content);
  }
  return vault;
}

describe('scanVault', () => {
  it('includes *.md only and skips dot-dirs, dot-files, and temp files', () => {
    const vault = vaultWith({
      'a.md': 'a',
      'sub/b.md': 'b',
      'sub/deeper/c.md': 'c',
      'readme.txt': 'x',
      'upper.MD': 'x',
      '.git/HEAD.md': 'x',
      '.obsidian/app.md': 'x',
      '.trash/old.md': 'x',
      'sub/.hidden/d.md': 'x',
      '.dotfile.md': 'x',
      'sub/.b.md.123.abc.tmp': 'x',
    });
    const scan = scanVault(vault);
    assert.deepEqual(scan.files.map((f) => f.relPath), ['a.md', 'sub/b.md', 'sub/deeper/c.md']);
    assert.equal(scan.skipped.hidden, 6);
    for (const f of scan.files) assert.match(f.stat.mtimeNs, /^\d+$/);
  });

  it('does not follow symlinks to files or directories, inside or outside the vault', () => {
    const vault = vaultWith({ 'real.md': 'r', 'dir/inner.md': 'i' });
    const outside = path.join(path.dirname(vault), 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(vault, 'out-file.md'));
    fs.symlinkSync(outside, path.join(vault, 'out-dir'));
    fs.symlinkSync('real.md', path.join(vault, 'in-file.md'));
    fs.symlinkSync('dir', path.join(vault, 'in-dir'));
    fs.symlinkSync('missing.md', path.join(vault, 'dangling.md'));
    fs.symlinkSync('loop.md', path.join(vault, 'loop.md'));
    const scan = scanVault(vault);
    assert.deepEqual(scan.files.map((f) => f.relPath), ['dir/inner.md', 'real.md']);
    assert.equal(scan.skipped.symlinks, 6);
    assert.deepEqual(scan.skippedPaths, ['dangling.md', 'in-dir', 'in-file.md', 'loop.md', 'out-dir', 'out-file.md']);
  });

  it('skips names the vault path rules refuse instead of failing', () => {
    const vault = vaultWith({ 'ok.md': 'x', 'back\\slash.md': 'x', 'pct%2e.md': 'x', 'ctl\u0007.md': 'x' });
    const scan = scanVault(vault);
    assert.deepEqual(scan.files.map((f) => f.relPath), ['ok.md']);
    assert.equal(scan.skipped.unsafeNames, 3);
  });

  it('skips and counts an unreadable subdirectory instead of failing', { skip: process.getuid?.() === 0 }, () => {
    const vault = vaultWith({ 'a.md': 'x', 'locked/b.md': 'x' });
    fs.chmodSync(path.join(vault, 'locked'), 0o000);
    try {
      const scan = scanVault(vault);
      assert.deepEqual(scan.files.map((f) => f.relPath), ['a.md']);
      assert.deepEqual(scan.skippedPaths, ['locked']);
    } finally {
      fs.chmodSync(path.join(vault, 'locked'), 0o700);
    }
  });

  it('accepts the vault through a symlinked root path', () => {
    const vault = vaultWith({ 'n.md': 'x' });
    const link = path.join(lexicalTmpDir('ebrain-scanlink-'), 'v');
    bases.push(path.dirname(link));
    fs.symlinkSync(vault, link);
    assert.deepEqual(scanVault(link).files.map((f) => f.relPath), ['n.md']);
  });
});

describe('safe-path additions', () => {
  it('vaultChild accepts one ordinary segment and refuses everything else', () => {
    const vault = vaultWith({});
    const root = resolveInVault(vault, '');
    assert.equal(vaultChild(root, 'note.md'), path.join(root, 'note.md'));
    assert.equal(vaultChild(root, 'caf\u00E9.md'), path.join(root, 'caf\u00E9.md'));
    for (const bad of ['', '.', '..', 'a/b', '.git', '.obsidian', '.hidden.md', 'x\u0000', 'a\\b', '%2e%2e', '\uFF0E\uFF0E']) {
      assert.throws(() => vaultChild(root, bad), SafePathError, JSON.stringify(bad));
    }
  });

  it('readFileWithStatSafe refuses symlinks and oversized files, and stats before reading', () => {
    const vault = vaultWith({ 'a.md': 'hello', 'big.md': 'x'.repeat(100) });
    const root = resolveInVault(vault, '');
    fs.symlinkSync('a.md', path.join(vault, 'link.md'));
    const r = readFileWithStatSafe(vaultChild(root, 'a.md'));
    assert.equal(r.data.toString(), 'hello');
    assert.equal(r.stat.size, 5n);
    assert.equal(typeof r.stat.mtimeNs, 'bigint');
    assert.throws(() => readFileWithStatSafe(vaultChild(root, 'link.md')), (e: SafePathError) => e.code === 'symlink');
    assert.throws(() => readFileWithStatSafe(vaultChild(root, 'big.md'), { maxBytes: 10 }), (e: SafePathError) => e.code === 'too-large');
  });

  it('statBigSafe returns nanosecond lstat or undefined', () => {
    const vault = vaultWith({ 'a.md': 'x' });
    const root = resolveInVault(vault, '');
    const st = statBigSafe(vaultChild(root, 'a.md'));
    assert.ok(st && typeof st.ctimeNs === 'bigint' && typeof st.ino === 'bigint');
    assert.equal(statBigSafe(vaultChild(root, 'missing.md')), undefined);
  });
});
