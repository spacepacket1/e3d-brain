import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertInside,
  createExclusive,
  mkdirSafe,
  openExternalFile,
  readDirSafe,
  readFileSafe,
  renameSafe,
  resolveInRoot,
  resolveInState,
  resolveInVault,
  SafePathError,
  statSafe,
  unlinkSafe,
  writeAtomic,
} from '../src/safe-path.js';
import { lexicalTmpDir, mode, prng, realTmpDir, rmrf } from './helpers.js';

let base: string;
let vault: string;
let outside: string;

before(() => {
  base = realTmpDir();
  vault = path.join(base, 'vault');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(vault, 'notes', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(vault, '.obsidian'));
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{}');
  fs.mkdirSync(path.join(vault, '_inbox'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  fs.writeFileSync(path.join(vault, 'notes', 'a.md'), 'a');
  fs.symlinkSync(outside, path.join(vault, 'link-out'));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(vault, 'notes', 'secret-link.md'));
  fs.symlinkSync(path.join(outside, 'missing.md'), path.join(vault, 'dangling.md'));
  fs.symlinkSync(path.join(vault, 'loop-b'), path.join(vault, 'loop-a'));
  fs.symlinkSync(path.join(vault, 'loop-a'), path.join(vault, 'loop-b'));
  fs.symlinkSync(path.join(vault, 'notes'), path.join(vault, 'link-in'));
});

after(() => rmrf(base));

function rejects(rel: string): SafePathError {
  try {
    resolveInVault(vault, rel);
  } catch (err) {
    assert.ok(err instanceof SafePathError, `expected SafePathError for ${JSON.stringify(rel)}, got ${String(err)}`);
    return err;
  }
  assert.fail(`resolveInVault accepted hostile path ${JSON.stringify(rel)}`);
}

describe('resolveInVault: hostile corpus', () => {
  const corpus = (): string[] => [
    '..',
    '../x',
    '../../etc/passwd',
    'a/../../x',
    'a/..',
    'notes/../../outside/secret.md',
    './x',
    'a/./b',
    '/etc/passwd',
    path.join(outside, 'secret.md'),
    path.join(vault, 'notes', 'a.md'),
    '%2e%2e/x',
    '%2e%2e%2fx',
    '..%2fx',
    'notes/%2E%2E/%2E%2E/x',
    'a\0b.md',
    'notes/a.md\0.png',
    '..\\x',
    'a\\..\\..\\x',
    'notes\\a.md',
    'C:\\x',
    'C:/x',
    'a//b',
    'a/',
    '\u0007bell.md',
    '\u202Egnp.md',
    '\uFEFF.obsidian/app.json',
    '\uFF0E\uFF0E/x',
    '\u2024\u2024/x',
    'link-out/secret.md',
    'link-out',
    'link-out/new.md',
    'notes/secret-link.md',
    'dangling.md',
    'loop-a',
    'loop-a/x.md',
    '.obsidian',
    '.obsidian/app.json',
    '.OBSIDIAN/app.json',
    '.Obsidian/workspace.json',
    '.git/config',
    '.GIT/config',
    '.trash/x.md',
    '\uFF0Eobsidian/app.json',
    '.\uFF4F\uFF42\uFF53\uFF49\uFF44\uFF49\uFF41\uFF4E/app.json',
    '\u2024obsidian/app.json',
    '\u200C.obsidian/app.json',
    '\u200D.git/config',
    'notes/.hidden.md',
    'x'.repeat(256),
    `${'a/'.repeat(2100)}x`,
  ];

  it('rejects every hostile path', () => {
    for (const rel of corpus()) rejects(rel);
  });

  it('classifies symlink escapes and loops', () => {
    assert.equal(rejects('link-out/secret.md').code, 'escape');
    assert.equal(rejects('notes/secret-link.md').code, 'escape');
    assert.equal(rejects('loop-a').code, 'symlink');
    assert.equal(rejects('dangling.md').code, 'symlink');
    assert.equal(rejects('.OBSIDIAN/app.json').code, 'protected');
  });

  it('rejects non-string input', () => {
    assert.throws(() => resolveInVault(vault, 42 as unknown as string), SafePathError);
  });

  it('property: inserting a traversal segment anywhere is always rejected', () => {
    const rand = prng(0xe3d);
    const names = ['notes', 'deep', 'café', '日本', 'x.md', 'a b', '_inbox'];
    const hostile = ['..', '.', '%2e%2e', '..\\..', '', '\0', '.obsidian', '.Git', '\uFF0E\uFF0E'];
    for (let i = 0; i < 500; i++) {
      const segs = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => names[Math.floor(rand() * names.length)]!);
      const at = Math.floor(rand() * (segs.length + 1));
      segs.splice(at, 0, hostile[Math.floor(rand() * hostile.length)]!);
      rejects(segs.join('/'));
    }
  });
});

describe('resolveInVault: ordinary paths', () => {
  const ordinary = [
    'notes/a.md',
    'notes/deep/new.md',
    'brand/new/dir/file.md',
    '_inbox/proposal.md',
    'a..b.md',
    'notes/x.y.z.md',
    'with space/x y.md',
    '100% done.md',
    'caf\u00e9/na\u00efve.md',
    'cafe\u0301/nai\u0308ve.md',
    '日本語/メモ.md',
    'Ελληνικά/σημείωση.md',
    'emoji 🧠/👨\u200D👩\u200D👧.md',
    'می\u200Cخواهم.md',
    'link-in/a.md',
  ];

  it('accepts ordinary nested paths, including unicode filenames', () => {
    for (const rel of ordinary) {
      const p = resolveInVault(vault, rel);
      assert.ok(p.startsWith(vault + path.sep), `${rel} -> ${p}`);
    }
  });

  it('resolves an internal symlink to its target', () => {
    assert.equal(resolveInVault(vault, 'link-in/a.md'), path.join(vault, 'notes', 'a.md'));
  });

  it('the empty path is the vault root', () => {
    assert.equal(resolveInVault(vault, ''), vault);
  });

  it('property: random unicode nested paths are accepted and stay inside', () => {
    const rand = prng(42);
    const alphabet = ['a', 'Z', '0', '-', '_', ' ', 'é', 'ü', 'ß', '中', '文', 'Я', 'ö', '🧠', '.'];
    for (let i = 0; i < 300; i++) {
      const depth = 1 + Math.floor(rand() * 4);
      const segs: string[] = [];
      for (let d = 0; d < depth; d++) {
        let s = alphabet[Math.floor(rand() * 9)]!; // never starts with '.'
        const len = Math.floor(rand() * 12);
        for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)]!;
        segs.push(rand() < 0.5 ? s.normalize('NFC') : s.normalize('NFD'));
      }
      const rel = segs.join('/');
      const p = resolveInVault(vault, rel);
      assert.ok(p.startsWith(vault + path.sep), rel);
      assert.ok(!path.relative(vault, p).split(path.sep).includes('..'), rel);
    }
  });
});

describe('root handling', () => {
  it('accepts the root given as a symlinked path or as the resolved path', () => {
    const linkParent = realTmpDir('ebrain-link-');
    try {
      const link = path.join(linkParent, 'vault-link');
      fs.symlinkSync(vault, link);
      assert.equal(resolveInVault(link, 'notes/a.md'), path.join(vault, 'notes', 'a.md'));
      assert.equal(resolveInVault(vault, 'notes/a.md'), path.join(vault, 'notes', 'a.md'));
      assert.throws(() => resolveInVault(link, 'link-out/secret.md'), SafePathError);
      assert.equal(assertInside(link, path.join(link, 'notes', 'a.md')), path.join(vault, 'notes', 'a.md'));
    } finally {
      rmrf(linkParent);
    }
  });

  it('accepts a root under the unresolved os.tmpdir()', () => {
    const lexical = lexicalTmpDir();
    try {
      fs.mkdirSync(path.join(lexical, 'n'));
      const p = resolveInVault(lexical, 'n/x.md');
      assert.equal(p, path.join(fs.realpathSync(lexical), 'n', 'x.md'));
    } finally {
      rmrf(lexical);
    }
  });

  it('rejects relative, missing, and non-directory roots', () => {
    assert.throws(() => resolveInVault('relative/vault', 'x.md'), SafePathError);
    assert.throws(() => resolveInVault(path.join(base, 'nope'), 'x.md'), SafePathError);
    assert.throws(() => resolveInVault(path.join(vault, 'notes', 'a.md'), 'x.md'), SafePathError);
  });
});

describe('resolveInState / resolveInRoot / assertInside', () => {
  it('state and external roots apply traversal and symlink rules but allow dot names', () => {
    assert.ok(resolveInState(vault, '.lock').endsWith('.lock'));
    assert.ok(resolveInRoot(vault, '.obsidian/app.json').endsWith(path.join('.obsidian', 'app.json')));
    for (const rel of ['../x', 'a/../../x', '/etc/passwd', '%2e%2e/x', 'a\0b', '..\\x', 'link-out/secret.md', 'loop-a']) {
      assert.throws(() => resolveInState(vault, rel), SafePathError, rel);
      assert.throws(() => resolveInRoot(vault, rel), SafePathError, rel);
    }
  });

  it('assertInside accepts inside paths and rejects outside ones and escaping symlinks', () => {
    assert.equal(assertInside(vault, path.join(vault, 'notes', 'new.md')), path.join(vault, 'notes', 'new.md'));
    assert.equal(assertInside(vault, path.join(vault, 'notes', '..', 'notes', 'a.md')), path.join(vault, 'notes', 'a.md'));
    assert.throws(() => assertInside(vault, path.join(outside, 'secret.md')), SafePathError);
    assert.throws(() => assertInside(vault, path.join(vault, '..', 'outside', 'secret.md')), SafePathError);
    assert.throws(() => assertInside(vault, path.join(vault, 'link-out', 'secret.md')), SafePathError);
    assert.throws(() => assertInside(vault, 'notes/a.md'), SafePathError);
    assert.throws(() => assertInside(vault, `${vault}2/x`), SafePathError);
  });
});

describe('openExternalFile', () => {
  it('opens a regular file inside an allowed root', () => {
    const file = openExternalFile(path.join(outside, 'secret.md'), [vault, outside]);
    try {
      assert.equal(file.readText(), 'secret');
      assert.ok(file.stat.isFile());
    } finally {
      file.close();
    }
  });

  it('rejects files outside every allowed root, symlink escapes, and directories', () => {
    assert.throws(() => openExternalFile(path.join(outside, 'secret.md'), [vault]), SafePathError);
    assert.throws(() => openExternalFile(path.join(vault, 'notes', 'secret-link.md'), [vault]), SafePathError);
    assert.throws(() => openExternalFile(path.join(vault, 'notes'), [vault]), SafePathError);
    assert.throws(() => openExternalFile(path.join(outside, 'secret.md'), []), SafePathError);
  });
});

describe('filesystem wrappers', () => {
  it('createExclusive never overwrites (link and O_EXCL strategies) and leaves no temp files', () => {
    for (const strategy of ['link', 'excl'] as const) {
      const p = resolveInVault(vault, `_inbox/new-${strategy}.md`);
      createExclusive(p, 'first', { strategy });
      assert.equal(readFileSafe(p, 'utf8'), 'first');
      assert.equal(mode(p), 0o600);
      assert.throws(
        () => createExclusive(p, 'second', { strategy }),
        (err: unknown) => err instanceof SafePathError && err.code === 'exists',
      );
      assert.equal(readFileSafe(p, 'utf8'), 'first');
    }
    const leftovers = readDirSafe(resolveInVault(vault, '_inbox')).filter((e) => e.name.startsWith('.'));
    assert.deepEqual(leftovers, []);
  });

  it('writeAtomic replaces a file and keeps 0600', () => {
    const p = resolveInVault(vault, 'notes/atomic.md');
    writeAtomic(p, 'one');
    writeAtomic(p, 'two');
    assert.equal(readFileSafe(p, 'utf8'), 'two');
    assert.equal(mode(p), 0o600);
    assert.deepEqual(readDirSafe(resolveInVault(vault, 'notes')).filter((e) => e.name.startsWith('.')), []);
  });

  it('renameSafe refuses to overwrite unless asked', () => {
    const a = resolveInVault(vault, 'notes/ren-a.md');
    const b = resolveInVault(vault, 'notes/ren-b.md');
    createExclusive(a, 'A');
    createExclusive(b, 'B');
    assert.throws(() => renameSafe(a, b), (err: unknown) => err instanceof SafePathError && err.code === 'exists');
    assert.equal(readFileSafe(b, 'utf8'), 'B');
    const c = resolveInVault(vault, 'notes/ren-c.md');
    renameSafe(a, c);
    assert.equal(statSafe(a), undefined);
    assert.equal(readFileSafe(c, 'utf8'), 'A');
    renameSafe(c, b, { overwrite: true });
    assert.equal(readFileSafe(b, 'utf8'), 'A');
  });

  it('mkdirSafe creates nested directories 0700 and statSafe reports missing paths', () => {
    const d = resolveInVault(vault, 'made/one/two');
    mkdirSafe(d);
    for (const rel of ['made', 'made/one', 'made/one/two']) assert.equal(mode(path.join(vault, rel)), 0o700);
    assert.equal(statSafe(resolveInVault(vault, 'made/nothing')), undefined);
  });

  it('readFileSafe refuses a symlink swapped in after resolution', () => {
    const p = resolveInVault(vault, 'notes/swap.md');
    fs.symlinkSync(path.join(outside, 'secret.md'), p);
    assert.throws(() => readFileSafe(p), SafePathError);
    fs.unlinkSync(p);
  });

  it('writes revalidate the parent directory realpath', () => {
    const dir = path.join(vault, 'swapdir');
    fs.mkdirSync(dir);
    const p = resolveInVault(vault, 'swapdir/x.md');
    fs.rmdirSync(dir);
    fs.symlinkSync(outside, dir);
    assert.throws(() => createExclusive(p, 'x'), (err: unknown) => err instanceof SafePathError && err.code === 'changed');
    assert.throws(() => writeAtomic(p, 'x'), (err: unknown) => err instanceof SafePathError && err.code === 'changed');
    assert.equal(fs.existsSync(path.join(outside, 'x.md')), false);
    assert.deepEqual(fs.readdirSync(outside).sort(), ['secret.md']);
    fs.unlinkSync(dir);
  });

  it('unlinkSafe removes files but never directories', () => {
    const p = resolveInVault(vault, 'notes/gone.md');
    createExclusive(p, 'x');
    unlinkSafe(p);
    assert.equal(statSafe(p), undefined);
    assert.throws(() => unlinkSafe(resolveInVault(vault, 'notes/deep')), SafePathError);
  });
});
