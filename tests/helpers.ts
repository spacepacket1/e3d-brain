import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
