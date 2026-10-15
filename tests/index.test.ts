import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDoctor } from '../src/cli/doctor.js';
import { dumpIndex } from '../src/index/dump.js';
import { setMeta } from '../src/index/db.js';
import { closeIndex, indexTotals, openIndex, refreshIndex, reindex, type IndexHandle } from '../src/index/indexer.js';
import { listNotePaths, matchChunks } from '../src/index/query.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import {
  fixtureManifest, materializeFixture, mode, realTmpDir, repoRoot, rmrf, treeChecksum, writeTestConfig,
} from './helpers.js';

const bases: string[] = [];
after(() => bases.forEach(rmrf));

interface Env {
  base: string;
  vault: string;
  stateDir: SafePath;
  open: (opts?: { maxChunkChars?: number }) => IndexHandle;
}

function setup(opts: { fixture?: boolean } = {}): Env {
  const base = realTmpDir('ebrain-index-');
  bases.push(base);
  let vault = path.join(base, 'vault');
  if (opts.fixture === false) fs.mkdirSync(vault);
  else vault = materializeFixture(base);
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  return { base, vault, stateDir, open: (o = {}) => openIndex({ vaultPath: vault, stateDir, ...o }) };
}

function withIndex<T>(env: Env, fn: (h: IndexHandle) => T): T {
  const h = env.open();
  try {
    return fn(h);
  } finally {
    closeIndex(h);
  }
}

function removeIndexFiles(stateDir: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(stateDir, `index.db${suffix}`), { force: true });
}

const GOLDEN = path.join(repoRoot(), 'tests', 'fixtures', 'vault.dump');
const FIXTURE_NOTES = 21;

describe('index over the fixture vault', () => {
  it('matches the checked-in golden dump (same on macOS and Linux)', () => {
    const env = setup();
    const dump = withIndex(env, (h) => {
      reindex(h);
      return dumpIndex(h.db);
    });
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, dump);
    const golden = fs.readFileSync(GOLDEN, 'utf8');
    assert.equal(dump, golden, `dump differs from tests/fixtures/vault.dump on ${process.platform}/${process.arch}`);
  });

  it('indexes every expected note and skips hidden files, non-markdown, and symlinks', () => {
    const env = setup();
    withIndex(env, (h) => {
      const r = reindex(h);
      assert.equal(r.scanned, FIXTURE_NOTES);
      assert.equal(r.skipped.symlinks, 3);
      const paths = listNotePaths(h.db);
      assert.equal(paths.length, FIXTURE_NOTES);
      for (const p of paths) {
        assert.ok(!p.split('/').some((s) => s.startsWith('.')), p);
        assert.ok(!['outside-link.md', 'inside-link.md'].includes(p) && !p.startsWith('linked-dir/'), p);
      }
      assert.ok(paths.includes('Projects/Sub/Deep/Beta.md'));
    });
  });

  it('never reads symlink targets, and the outside canary never enters the index', () => {
    const env = setup();
    const secret = path.join(env.base, 'outside', 'secret.md');
    // An unreadable target would make any read attempt fail loudly.
    fs.chmodSync(secret, 0o000);
    try {
      const dump = withIndex(env, (h) => {
        reindex(h, { full: true });
        return dumpIndex(h.db);
      });
      assert.ok(!dump.includes('OUTSIDE-SECRET-CANARY'));
      assert.ok(!dump.includes('outside-link'));
    } finally {
      fs.chmodSync(secret, 0o644);
    }
  });

  it('reindex twice, refresh, and a full rebuild all give byte-identical dumps', () => {
    const env = setup();
    const first = withIndex(env, (h) => {
      reindex(h);
      return dumpIndex(h.db);
    });
    const second = withIndex(env, (h) => {
      const r = reindex(h);
      assert.equal(r.unchanged, FIXTURE_NOTES);
      assert.equal(r.added + r.updated + r.removed, 0);
      return dumpIndex(h.db);
    });
    assert.equal(second, first);
    const refreshed = withIndex(env, (h) => {
      const r = refreshIndex(h);
      assert.equal(r.added + r.updated + r.removed, 0);
      return dumpIndex(h.db);
    });
    assert.equal(refreshed, first);
    removeIndexFiles(env.stateDir);
    const rebuilt = withIndex(env, (h) => {
      reindex(h, { full: true });
      return dumpIndex(h.db);
    });
    assert.equal(rebuilt, first);
    const fullAgain = withIndex(env, (h) => {
      reindex(h, { full: true });
      return dumpIndex(h.db);
    });
    assert.equal(fullAgain, first);
  });

  it('leaves the vault byte-for-byte unchanged', () => {
    const env = setup();
    const before = treeChecksum(env.vault);
    withIndex(env, (h) => {
      reindex(h);
      refreshIndex(h);
      reindex(h, { full: true });
      dumpIndex(h.db);
    });
    assert.equal(treeChecksum(env.vault), before);
  });

  it('counts malformed frontmatter and keeps those bodies searchable', () => {
    const env = setup();
    withIndex(env, (h) => {
      reindex(h);
      const t = indexTotals(h.db);
      assert.equal(t.malformedFrontmatter, 2);
      assert.equal(t.unknownStatuses, 1);
      assert.equal(t.invalidDates, 2);
      assert.deepEqual(matchChunks(h.db, 'zebrafinch').map((m) => m.path), ['Bad Frontmatter.md']);
      assert.deepEqual(matchChunks(h.db, 'okapi').map((m) => m.path), ['Unclosed Frontmatter.md']);
      // The malformed (closed) YAML block of Bad Frontmatter.md is not indexed as body.
      // (The word is also in this note's title and path, so its opening chunk matches too: compare distinct notes.)
      assert.deepEqual([...new Set(matchChunks(h.db, 'unclosed').map((m) => m.path))], ['Unclosed Frontmatter.md']);
      // FTS syntax in user text is inert.
      assert.deepEqual(matchChunks(h.db, 'zebrafinch OR "NEAR(" *'), []);
      assert.deepEqual(matchChunks(h.db, '"zebrafinch"'), matchChunks(h.db, 'zebrafinch'));
    });
  });

  it('creates the index 0600 in WAL mode with a busy timeout', () => {
    const env = setup();
    withIndex(env, (h) => {
      reindex(h);
      assert.equal(h.db.pragma('journal_mode', { simple: true }), 'wal');
      assert.ok(Number(h.db.pragma('busy_timeout', { simple: true })) >= 1000);
      assert.equal(mode(path.join(env.stateDir, 'index.db')), 0o600);
      const wal = path.join(env.stateDir, 'index.db-wal');
      if (fs.existsSync(wal)) assert.equal(mode(wal), 0o600);
    });
  });
});

describe('refreshIndex', () => {
  it('makes new, edited, and deleted notes visible without a full reindex', () => {
    const env = setup();
    withIndex(env, (h) => {
      reindex(h);
      assert.deepEqual(matchChunks(h.db, 'pangolin'), []);

      fs.writeFileSync(path.join(env.vault, '_inbox', 'capture.md'), '---\nstatus: proposed\n---\nA pangolin sighting.\n');
      let r = refreshIndex(h);
      assert.equal(r.added, 1);
      assert.equal(r.unchanged, FIXTURE_NOTES);
      assert.deepEqual(matchChunks(h.db, 'pangolin').map((m) => m.path), ['_inbox/capture.md']);

      fs.writeFileSync(path.join(env.vault, '_inbox', 'capture.md'), '---\nstatus: proposed\n---\nA narwhal sighting.\n');
      r = refreshIndex(h);
      assert.equal(r.updated, 1);
      assert.deepEqual(matchChunks(h.db, 'pangolin'), []);
      assert.deepEqual(matchChunks(h.db, 'narwhal').map((m) => m.path), ['_inbox/capture.md']);

      fs.rmSync(path.join(env.vault, '_inbox', 'capture.md'));
      r = refreshIndex(h);
      assert.equal(r.removed, 1);
      assert.deepEqual(matchChunks(h.db, 'narwhal'), []);
    });
  });

  it('re-resolves links when the set of notes changes', () => {
    const env = setup();
    withIndex(env, (h) => {
      reindex(h);
      const link = () =>
        h.db.prepare("SELECT resolution, resolved_path FROM links WHERE note_path = 'Home.md' AND target = 'Missing Note'").get();
      assert.deepEqual({ ...(link() as object) }, { resolution: 'unresolved', resolved_path: null });
      fs.mkdirSync(path.join(env.vault, 'later'));
      fs.writeFileSync(path.join(env.vault, 'later', 'missing note.md'), 'now it exists\n');
      refreshIndex(h);
      assert.deepEqual({ ...(link() as object) }, { resolution: 'basename', resolved_path: 'later/missing note.md' });
      fs.rmSync(path.join(env.vault, 'later', 'missing note.md'));
      refreshIndex(h);
      assert.deepEqual({ ...(link() as object) }, { resolution: 'unresolved', resolved_path: null });
    });
  });

  it('re-hashes only when the stat key changed, and re-parses only when content changed', () => {
    const env = setup();
    const file = path.join(env.vault, 'Home.md');
    withIndex(env, (h) => {
      reindex(h);
      const dump = dumpIndex(h.db);
      // A touch changes mtime/ctime but not content: no note is re-parsed.
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
      let r = refreshIndex(h);
      assert.equal(r.updated, 0);
      assert.equal(dumpIndex(h.db), dump);
      // Same size, same mtime, different bytes: ctime still moves, so the edit is seen.
      const st = fs.statSync(file);
      const text = fs.readFileSync(file, 'utf8').replace('Welcome', 'Wombats');
      fs.writeFileSync(file, text);
      fs.utimesSync(file, st.atime, st.mtime);
      r = refreshIndex(h);
      assert.equal(r.updated, 1);
      assert.equal(matchChunks(h.db, 'Wombats')[0]?.path, 'Home.md');
    });
  });

  it('rebuilds when parser settings change', () => {
    const env = setup();
    withIndex(env, (h) => reindex(h));
    const h = env.open({ maxChunkChars: 400 });
    try {
      const r = refreshIndex(h);
      assert.equal(r.rebuilt, true);
      const long = h.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE note_path = 'Projects/Alpha.md'").get() as { n: number };
      assert.ok(long.n > 7);
      assert.equal(refreshIndex(h).rebuilt, false);
    } finally {
      closeIndex(h);
    }
  });

  it('recreates an index written by another schema version', () => {
    const env = setup();
    withIndex(env, (h) => {
      reindex(h);
      setMeta(h.db, 'schema_version', '0');
    });
    withIndex(env, (h) => {
      assert.equal(listNotePaths(h.db).length, 0);
      refreshIndex(h);
      assert.equal(listNotePaths(h.db).length, FIXTURE_NOTES);
    });
  });
});

describe('unicode and case collisions', () => {
  it('resolves links across NFC/NFD and case, with NFD names listed by their NFC form', () => {
    const env = setup({ fixture: false });
    const nfd = 'Cafe\u0301 Note.md';
    fs.writeFileSync(path.join(env.vault, nfd), '# Caf\u00E9\n');
    fs.writeFileSync(path.join(env.vault, 'links.md'), '[[caf\u00E9 note]] [[CAFE\u0301 NOTE]] [[Caf\u00E9 Note]]\n');
    withIndex(env, (h) => {
      reindex(h);
      const rows = h.db.prepare('SELECT target, resolution, resolved_path FROM links ORDER BY ordinal').all() as {
        resolution: string; resolved_path: string;
      }[];
      assert.deepEqual(rows.map((r) => [r.resolution, r.resolved_path]), [
        ['basename', nfd], ['basename', nfd], ['path', nfd],
      ]);
      const dump = dumpIndex(h.db);
      assert.ok(dump.includes('note "Caf\u00E9 Note.md"\n  raw "Cafe\\u0301 Note.md"\n'), dump);
    });
  });

  it('indexes both members of a case or normalization pair where the filesystem allows, and reports the collision', () => {
    const env = setup({ fixture: false });
    const created: string[] = [];
    for (const f of fixtureManifest().collisions) {
      try {
        fs.writeFileSync(path.join(env.vault, f.path), f.content, { flag: 'wx' });
        created.push(f.path);
      } catch (err) {
        // Case- or normalization-insensitive filesystems (APFS, HFS+) refuse the twin.
        assert.equal((err as NodeJS.ErrnoException).code, 'EEXIST');
      }
    }
    const onDisk = fs.readdirSync(env.vault);
    withIndex(env, (h) => {
      reindex(h);
      const paths = listNotePaths(h.db);
      assert.equal(paths.length, onDisk.length);
      const t = indexTotals(h.db);
      // One group per twin pair the filesystem kept as two names (0 to 2, platform-dependent).
      const kept = (a: string, b: string) => onDisk.includes(a) && onDisk.includes(b) ? 1 : 0;
      const [c1, c2, n1, n2] = fixtureManifest().collisions.map((f) => f.path) as [string, string, string, string];
      const expectedGroups = kept(c1, c2) + kept(n1, n2);
      assert.equal(t.collisions.length, expectedGroups, `created ${JSON.stringify(created)} on ${process.platform}`);
      const config = writeTestConfig(env.base, env.vault, env.stateDir);
      const report = runDoctor({ env: { EBRAIN_CONFIG: config }, homeDir: env.base });
      const line = report.lines.find((l) => l.startsWith('path collisions:'));
      assert.ok(line, report.lines.join('\n'));
      if (expectedGroups === 0) assert.equal(line, 'path collisions: none');
      else {
        assert.match(line, new RegExp(`WARN ${expectedGroups} `));
        assert.equal(report.lines.filter((l) => l.startsWith('  collision: ')).length, expectedGroups);
      }
    });
  });
});

describe('CLI', () => {
  const cli = path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
  const run = (env: Env, config: string, args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: env.base, EBRAIN_CONFIG: config },
      encoding: 'utf8',
    });

  it('reindex prints a summary with the malformed count; index dump matches the API', () => {
    const env = setup();
    const config = writeTestConfig(env.base, env.vault, env.stateDir);
    const missing = run(env, config, ['index', 'dump']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /index not built/);
    const r = run(env, config, ['reindex']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^malformed frontmatter: 2$/m);
    assert.match(r.stdout, new RegExp(`: ${FIXTURE_NOTES} notes;`));
    const d1 = run(env, config, ['index', 'dump']);
    assert.equal(d1.status, 0, d1.stderr);
    assert.equal(d1.stdout, fs.readFileSync(GOLDEN, 'utf8'));
    const full = run(env, config, ['reindex', '--full']);
    assert.equal(full.status, 0, full.stderr);
    assert.equal(run(env, config, ['index', 'dump']).stdout, d1.stdout);
    assert.equal(run(env, config, ['reindex', '--bogus']).status, 2);
    assert.equal(run(env, config, ['index', 'nope']).status, 2);
  });
});

describe('concurrency', () => {
  it('a reindex, a refresh, and a query process share index.db without errors or lockouts', async () => {
    const env = setup();
    withIndex(env, (h) => reindex(h));
    const worker = path.join(repoRoot(), 'dist', 'tests', 'index-worker.js');
    const start = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('close', (code) => resolve({ code, out, err }));
      });
    const results = await Promise.all([
      start(['reindex', env.vault, env.stateDir, '1500']),
      start(['refresh', env.vault, env.stateDir, '1500']),
      start(['query', env.vault, env.stateDir, '1500', String(FIXTURE_NOTES)]),
      start(['query', env.vault, env.stateDir, '1500', String(FIXTURE_NOTES)]),
    ]);
    for (const r of results) assert.equal(r.code, 0, `${r.out}${r.err}`);
    const stats = results.map((r) => JSON.parse(r.out) as { rounds: number; start: number; end: number });
    // The workers really ran at the same time.
    assert.ok(Math.max(...stats.map((s) => s.start)) < Math.min(...stats.map((s) => s.end)), JSON.stringify(stats));
    assert.ok(stats[0]!.rounds >= 5);
    const golden = fs.readFileSync(GOLDEN, 'utf8');
    assert.equal(withIndex(env, (h) => dumpIndex(h.db)), golden);
    const check = withIndex(env, (h) => h.db.pragma('integrity_check', { simple: true }));
    assert.equal(check, 'ok');
  });
});
