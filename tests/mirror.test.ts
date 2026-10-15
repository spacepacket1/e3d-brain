// Mirrors (`ebrain sync`): config validation, then end to end through the CLI against a fake source repo.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigError, parseConfig } from '../src/config.js';
import { realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';

const cli = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const FAKE_PASSWORD = 'SuperSecretValue99';
const OUTSIDE_CANARY = 'OUTSIDE-MIRROR-CANARY';

const baseRaw = (mirrors: unknown, over: Record<string, unknown> = {}) => ({
  vaultPath: '/tmp/ebrain-mirror-vault', stateDir: '/tmp/ebrain-mirror-state', principal: { id: 'chris', type: 'human' }, mode: 'inbox',
  ...(mirrors === undefined ? {} : { mirrors }), ...over,
});
const parse = (mirrors: unknown, over: Record<string, unknown> = {}) => parseConfig(baseRaw(mirrors, over), { homeDir: '/home/x' });

describe('mirror config', () => {
  it('defaults: into repos/<name>, no excludes, 400 KB', () => {
    const [m] = parse([{ name: 'alpha', path: '/srv/alpha' }]).mirrors;
    assert.deepEqual(m, { name: 'alpha', path: '/srv/alpha', into: 'repos/alpha', exclude: [], maxFileKB: 400 });
  });
  it('no mirrors key means none', () => assert.deepEqual(parse(undefined).mirrors, []));
  const bad: [string, unknown, RegExp, Record<string, unknown>?][] = [
    ['unknown key', [{ name: 'a', path: '/s/a', extra: 1 }], /unknown config key "mirrors\[0\]\.extra"/],
    ['bad name', [{ name: 'Bad Name', path: '/s/a' }], /name/],
    ['duplicate name', [{ name: 'a', path: '/s/a' }, { name: 'a', path: '/s/b', into: 'x' }], /twice/],
    ['relative traversal in path', [{ name: 'a', path: '/s/../a' }], /"\.\." segments/],
    ['path inside the vault', [{ name: 'a', path: '/tmp/ebrain-mirror-vault/docs' }], /inside the vault/],
    ['path containing the state dir', [{ name: 'a', path: '/tmp' }], /inside the vault or state/],
    ['into with ..', [{ name: 'a', path: '/s/a', into: '../x' }], /plain vault-relative/],
    ['into absolute', [{ name: 'a', path: '/s/a', into: '/x' }], /plain vault-relative/],
    ['into hidden', [{ name: 'a', path: '/s/a', into: '.obsidian/x' }], /plain vault-relative/],
    ['into _inbox', [{ name: 'a', path: '/s/a', into: '_inbox/x' }], /fixed meanings/],
    ['into journal', [{ name: 'a', path: '/s/a', into: 'journal/x' }], /fixed meanings/],
    ['into references', [{ name: 'a', path: '/s/a', into: 'references' }], /fixed meanings/],
    ['overlapping folders', [{ name: 'a', path: '/s/a', into: 'repos/x' }, { name: 'b', path: '/s/b', into: 'repos/x/y' }], /overlaps/],
    ['exclude with a slash', [{ name: 'a', path: '/s/a', exclude: ['a/b'] }], /plain directory names/],
    ['maxFileKB zero', [{ name: 'a', path: '/s/a', maxFileKB: 0 }], /maxFileKB/],
    ['not an array', { name: 'a' }, /must be an array/],
    ['agent principal', [{ name: 'a', path: '/s/a' }], /requires "principal.type": "human"/, { principal: { id: 'bot', type: 'agent' }, mode: 'journal' }],
  ];
  for (const [label, mirrors, re, over] of bad) {
    it(`rejects ${label}`, () => assert.throws(() => parse(mirrors, over ?? {}), (e: unknown) => e instanceof ConfigError && re.test(e.message)));
  }
});

describe('ebrain sync (end to end)', () => {
  let base: string, vault: string, src: string, stateDir: string, config: string;

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli(), ...args], { env: { PATH: process.env.PATH ?? '', HOME: base, EBRAIN_CONFIG: config }, encoding: 'utf8' });
  const sync = (...a: string[]) => run('sync', ...a);
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  };
  const note = (rel: string) => fs.readFileSync(path.join(vault, 'repos', 'alpha', rel), 'utf8');
  const noteExists = (rel: string) => fs.existsSync(path.join(vault, 'repos', 'alpha', rel));

  before(() => {
    base = realTmpDir('ebrain-mirror-');
    vault = path.join(base, 'vault');
    src = path.join(base, 'alpha');
    stateDir = path.join(base, 'state');
    fs.mkdirSync(path.join(vault, '_inbox'), { recursive: true });
    w('README.md', `# Alpha\n\nAlpha is a test repo.\npassword = ${FAKE_PASSWORD}\n`);
    w('docs/guide.md', '---\nname: Guide\nstatus: active\n---\n\n# Guide\n\nHow to use alpha.\n');
    w('llms.txt', 'Alpha overview for language models.\n');
    w('docs/My Doc!.md', '# Odd name\n\nsanitised on the way in.\n');
    w('node_modules/pkg/README.md', '# not me\n');
    w('.hidden/secret.md', '# hidden\n');
    w('logs/run.md', '# log\n');
    w('empty.md', '');
    w('big.md', `# Big\n\n${'x '.repeat(2000)}\n`);
    fs.writeFileSync(path.join(base, 'outside.md'), `# Outside\n${OUTSIDE_CANARY}\n`);
    fs.symlinkSync(path.join(base, 'outside.md'), path.join(src, 'link.md'));
    w('.git/HEAD', 'ref: refs/heads/main\n');
    w('.git/refs/heads/main', `${COMMIT}\n`);
    config = path.join(base, 'config.json');
    fs.writeFileSync(config, JSON.stringify({
      vaultPath: vault, stateDir, principal: { id: 'futco', type: 'human' }, mode: 'inbox',
      mirrors: [{ name: 'alpha', path: src, maxFileKB: 1 }],
    }), { mode: 0o600 });
    fs.chmodSync(config, 0o600);
  });
  after(() => rmrf(base));

  it('copies documents with provenance, scrubbed, private, and skips what it should', () => {
    const r = sync();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scanned 4, added 4, updated 0, unchanged 0, orphaned 0; skipped: 1 too large, 1 empty/);
    for (const rel of ['README.md', 'docs/guide.md', 'llms.txt.md', 'docs/My Doc_.md']) assert.ok(noteExists(rel), rel);
    for (const rel of ['node_modules/pkg/README.md', '.hidden/secret.md', 'logs/run.md', 'big.md', 'empty.md', 'link.md']) assert.ok(!noteExists(rel), rel);
    const readme = note('README.md');
    assert.match(readme, /^---\n/);
    assert.match(readme, /\nmirror: alpha\n/);
    assert.match(readme, /\npinned: true\n/);
    assert.match(readme, /\nsource_repo: alpha\n/);
    assert.match(readme, /\nsource_path: README\.md\n/);
    assert.match(readme, new RegExp(`\\nsource_commit: ${COMMIT.slice(0, 12)}\\n`));
    assert.match(readme, /\nsource_sha256: [0-9a-f]{16}\n/);
    assert.match(readme, /\nkind: reference\n/);
    assert.match(readme, /\nstatus: accepted\n/);
    assert.match(note('docs/guide.md'), /source_frontmatter:\n {2}name: Guide\n {2}status: active/);
    assert.equal(fs.statSync(path.join(vault, 'repos', 'alpha', 'README.md')).mode & 0o777, 0o600);
  });

  it('scrubs before writing and never prints secrets', () => {
    const r = sync('--dry-run');
    assert.ok(!note('README.md').includes(FAKE_PASSWORD));
    assert.match(note('README.md'), /\[REDACTED:password-assignment\]/);
    assert.ok(!r.stdout.includes(FAKE_PASSWORD) && !r.stderr.includes(FAKE_PASSWORD));
    assert.match(r.stdout, /scrubbed \(counts only\): password-assignment x1/);
    assert.match(r.stdout, /check these sources for real secrets/);
    assert.match(r.stdout, /README\.md: password-assignment x1/);
  });

  it('never follows symlinks out of the source', () => {
    const all = fs.readdirSync(path.join(vault, 'repos', 'alpha'), { recursive: true }).map(String);
    for (const f of all) {
      const p = path.join(vault, 'repos', 'alpha', f);
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(OUTSIDE_CANARY), f);
    }
  });

  it('is a true no-op when nothing changed, and --dry-run writes nothing', () => {
    const before = treeChecksum(vault);
    const r = sync();
    assert.match(r.stdout, /added 0, updated 0, unchanged 4/);
    assert.equal(treeChecksum(vault), before);
    const stateBefore = fs.readFileSync(path.join(stateDir, 'mirrors.json'), 'utf8');   // after the real run, which stamps last_sync
    w('docs/new.md', '# New\n\nfresh.\n');
    try {
      const d = sync('--dry-run');
      assert.match(d.stdout, /\(dry run\).*added 1/);
      assert.ok(!noteExists('docs/new.md'));
      assert.equal(treeChecksum(vault), before);
      assert.equal(fs.readFileSync(path.join(stateDir, 'mirrors.json'), 'utf8'), stateBefore, 'a dry run leaves the sync state alone');
    } finally {
      fs.rmSync(path.join(src, 'docs', 'new.md'));
    }
  });

  it('keeps ids the brain assigned and the original created date across re-syncs and edits', () => {
    const a = run('ids', 'assign');
    assert.equal(a.status, 0, a.stderr);
    const idOf = (rel: string) => /^id: (\S+)$/m.exec(note(rel))![1];
    const createdOf = (rel: string) => /^created: (\S+)$/m.exec(note(rel))![1];
    const [id, created] = [idOf('docs/guide.md'), createdOf('docs/guide.md')];
    assert.match(note('docs/guide.md'), /^---\nid: /, 'the brain writes id first');
    const same = sync();
    assert.match(same.stdout, /added 0, updated 0, unchanged 4/, 'ids and created dates do not churn');
    w('docs/guide.md', '---\nname: Guide\nstatus: active\n---\n\n# Guide\n\nHow to use alpha, now with more.\n');
    const edited = sync();
    assert.match(edited.stdout, /updated 1, unchanged 3/);
    assert.match(note('docs/guide.md'), /now with more/);
    assert.equal(idOf('docs/guide.md'), id);
    assert.equal(createdOf('docs/guide.md'), created);
  });

  it('reports a vanished source as orphaned and keeps the note; status shows drift', () => {
    fs.rmSync(path.join(src, 'docs', 'My Doc!.md'));
    w('docs/added-later.md', '# Later\n\nnew source file.\n');
    const st = run('mirrors', 'status');
    assert.match(st.stdout, /alpha: last sync .*source has 1 new, 0 changed, 1 gone; 0 note\(s\) missing from the vault; STALE/);
    const r = sync();
    assert.match(r.stdout, /added 1, updated 0, unchanged 3, orphaned 1/);
    assert.match(r.stdout, /orphaned \(the source file is gone; the note is kept\):\n {4}repos\/alpha\/docs\/My Doc_\.md/);
    assert.ok(noteExists('docs/My Doc_.md'), 'nothing is deleted');
    const again = sync();
    assert.match(again.stdout, /orphaned 1/, 'still reported until the owner deals with it');
  });

  it('doctor shows each mirror, and list names them', () => {
    const d = run('doctor');
    assert.match(d.stdout, /mirror alpha: last sync \d{4}-\d{2}-\d{2} \(\d+ notes\)/);
    const l = run('mirrors', 'list');
    assert.match(l.stdout, new RegExp(`^alpha\\t${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\t-> repos/alpha/`, 'm'));
  });

  it('usage and config errors', () => {
    assert.equal(sync('nosuchmirror').status, 2);
    assert.equal(sync('--bogus').status, 2);
    assert.equal(run('mirrors').status, 2);
    const noMirrors = path.join(base, 'plain.json');
    fs.writeFileSync(noMirrors, JSON.stringify({ vaultPath: vault, stateDir, principal: { id: 'futco', type: 'human' }, mode: 'inbox' }), { mode: 0o600 });
    const r = spawnSync(process.execPath, [cli(), 'sync'], { env: { PATH: process.env.PATH ?? '', HOME: base, EBRAIN_CONFIG: noMirrors }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no mirrors configured/);
  });
});
