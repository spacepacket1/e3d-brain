// A minimal, defensive reader for the tar stream `git archive --format=tar`
// produces (cognition Phase 9, `ebrain eval replay`). Regular files and
// directories are extracted under a caller-made root through `safe-path`
// (I1: every entry path is resolved inside the root; `..`, absolute paths,
// and symlink escapes are refused). Symlinks, hard links, and every other
// entry type are skipped and counted: a replay copy never follows a link out
// of its temporary directory. Supports ustar names with a prefix and pax
// `path` records (long names); base-256 sizes are refused.

import * as path from 'node:path';
import { createExclusive, mkdirSafe, resolveInRoot, type SafePath } from '../safe-path.js';

const BLOCK = 512;
export const MAX_TAR_ENTRIES = 200_000;

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

export interface ExtractResult {
  files: number;
  dirs: number;
  /** Symlinks, hard links, and other entry types that were not extracted. */
  skipped: number;
}

function field(h: Buffer, start: number, len: number): string {
  const raw = h.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

function octal(h: Buffer, start: number, len: number, label: string): number {
  if ((h[start]! & 0x80) !== 0) throw new TarError(`tar ${label} uses base-256 encoding (unsupported)`);
  const s = field(h, start, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`tar ${label} is not octal`);
  return parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === octal(h, 148, 8, 'checksum');
}

/** `path` from pax extended-header records (`<len> key=value\n`). */
function paxPath(data: Buffer): string | undefined {
  let off = 0;
  let found: string | undefined;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const len = Number(data.subarray(off, sp).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0 || off + len > data.length) throw new TarError('malformed pax header');
    const rec = data.subarray(sp + 1, off + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') found = rec.slice(eq + 1);
    off += len;
  }
  return found;
}

function cleanRel(name: string): string | undefined {
  const rel = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (rel === '' || rel === '.') return undefined;
  if (path.posix.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw new TarError(`tar entry ${JSON.stringify(rel.slice(0, 80))} has an unsafe path`);
  }
  return rel;
}

/** Extract `tar` under `root` (an existing, empty directory). Throws TarError on malformed input. */
export function extractTar(tar: Buffer, root: SafePath): ExtractResult {
  const out: ExtractResult = { files: 0, dirs: 0, skipped: 0 };
  let off = 0;
  let pendingPath: string | undefined;
  let entries = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break; // end of archive
    if (!checksumOk(h)) throw new TarError('tar header checksum mismatch');
    if (++entries > MAX_TAR_ENTRIES) throw new TarError(`tar has more than ${MAX_TAR_ENTRIES} entries`);
    const size = octal(h, 124, 12, 'size');
    const type = String.fromCharCode(h[156]!);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new TarError('tar entry is truncated');
    const data = tar.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'g') continue; // pax global header (git writes the commit id here)
    if (type === 'x') {
      pendingPath = paxPath(data);
      continue;
    }
    const prefix = field(h, 345, 155);
    const name = pendingPath ?? (prefix !== '' ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    pendingPath = undefined;
    const rel = cleanRel(name);
    if (type === '5') {
      if (rel !== undefined) {
        mkdirSafe(resolveInRoot(root, rel));
        out.dirs++;
      }
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') {
      out.skipped++;
      continue;
    }
    if (rel === undefined) throw new TarError('tar file entry has no name');
    const dir = path.posix.dirname(rel);
    if (dir !== '.') mkdirSafe(resolveInRoot(root, dir));
    createExclusive(resolveInRoot(root, rel), data);
    out.files++;
  }
  return out;
}
