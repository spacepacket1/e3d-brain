import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/** A fresh temp dir under the realpath of os.tmpdir() (macOS /var and /tmp are symlinks). */
export function realTmpDir(prefix = 'ebrain-test-'): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

/** A fresh temp dir addressed through os.tmpdir() as given (may be a symlinked path). */
export function lexicalTmpDir(prefix = 'ebrain-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Repository root (the directory holding package.json), from dist/tests or tests. */
export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
  return dir;
}

/** Deterministic PRNG (mulberry32) for property-style tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

export interface FixtureEntry {
  path: string;
  content: string;
}

export interface FixtureManifest {
  files: FixtureEntry[];
  collisions: FixtureEntry[];
}

export function fixtureManifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(path.join(repoRoot(), 'tests', 'fixtures', 'vault-extra.json'), 'utf8')) as FixtureManifest;
}

/**
 * Copy tests/fixtures/vault (symlinks kept as symlinks) and tests/fixtures/outside
 * into `base`, then add the manifest's portable extra files (names git cannot
 * store portably). Returns the vault path.
 */
export function materializeFixture(base: string): string {
  const src = path.join(repoRoot(), 'tests', 'fixtures');
  const vault = path.join(base, 'vault');
  fs.cpSync(path.join(src, 'vault'), vault, { recursive: true, verbatimSymlinks: true });
  fs.cpSync(path.join(src, 'outside'), path.join(base, 'outside'), { recursive: true });
  for (const f of fixtureManifest().files) fs.writeFileSync(path.join(vault, f.path), f.content);
  return vault;
}

/** SHA-256 over every entry (path, type, link target or content) below `dir`, without following symlinks. */
export function treeChecksum(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string, rel: string) => {
    const names = fs.readdirSync(d).sort();
    for (const name of names) {
      const full = path.join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) hash.update(`L ${r} ${fs.readlinkSync(full)}\n`);
      else if (st.isDirectory()) {
        hash.update(`D ${r}\n`);
        walk(full, r);
      } else hash.update(`F ${r} ${st.mode & 0o777} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}\n`);
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/** Write a 0600 config file for a test instance and return its path. */
export function writeTestConfig(base: string, vault: string, stateDir: string, name = 'config.json'): string {
  const file = path.join(base, name);
  const body = { vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox' };
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
