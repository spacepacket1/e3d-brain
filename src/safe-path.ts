// The only module that touches the filesystem for non-constant paths (I1).
//
// Every path derived from external input is resolved here against an
// explicitly named root (vault, state dir, or a caller-named external root),
// realpath-checked, and returned as a branded `SafePath`. The filesystem
// wrappers below accept only `SafePath`, so the type system keeps unresolved
// strings away from `node:fs`.
//
// Threat model (docs/SECURITY.md): the vault and state dir belong to a trusted
// local owner and are not concurrently modified by an adversary. The residual
// symlink-swap race between check and use is accepted; every write revalidates
// the parent directory's realpath immediately before publishing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

declare const safePathBrand: unique symbol;
export type SafePath = string & { readonly [safePathBrand]: true };

export type SafePathErrorCode =
  | 'invalid'
  | 'escape'
  | 'protected'
  | 'symlink'
  | 'exists'
  | 'not-file'
  | 'too-large'
  | 'changed';

export class SafePathError extends Error {
  readonly code: SafePathErrorCode;
  /** Underlying errno code (for example ENOENT), when one caused the rejection. */
  readonly errno: string | undefined;
  constructor(code: SafePathErrorCode, message: string, errno?: string) {
    super(message);
    this.name = 'SafePathError';
    this.code = code;
    this.errno = errno;
  }
}

/** Default mode for files the tool creates (I8). */
export const FILE_MODE = 0o600;
/** Default mode for directories the tool creates (I8). */
export const DIR_MODE = 0o700;

const MAX_SEGMENT_BYTES = 255;
const MAX_REL_PATH_CHARS = 4096;

// Vault names that external input may never address, compared after NFKC
// normalization and case folding. Any dot-prefixed segment is also refused
// (dot-files are tool temp files or tool/editor metadata; the scanner skips
// them), which already covers these; the list documents intent.
const PROTECTED_VAULT_NAMES = new Set(['.obsidian', '.git', '.trash']);

function fail(code: SafePathErrorCode, message: string, errno?: string): never {
  throw new SafePathError(code, message, errno);
}

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function brand(p: string): SafePath {
  return p as SafePath;
}

/**
 * NFKC, drop zero-width joiners, lowercase: how a name compares on the most
 * permissive filesystem (case-insensitive, normalization-insensitive, and
 * HFS+-style ignorable code points).
 */
function foldName(segment: string): string {
  return segment.normalize('NFKC').replace(/[\u200C\u200D]/g, '').toLowerCase();
}

/**
 * Split a relative path into validated segments. Rejects absolute paths, NUL
 * and other control/format characters, backslashes, percent-encoded octets,
 * drive prefixes, empty segments, and `.`/`..` (also after NFKC, so fullwidth
 * dots cannot smuggle a traversal past a later normalization step).
 */
function splitRelative(relPath: string, vaultRules: boolean): string[] {
  if (typeof relPath !== 'string') fail('invalid', 'path must be a string');
  if (relPath === '') return [];
  if (relPath.length > MAX_REL_PATH_CHARS) fail('invalid', 'path too long');
  if (relPath.includes('\0')) fail('invalid', 'path contains NUL byte');
  // Format characters are refused except ZWNJ/ZWJ, which occur in ordinary
  // scripts and emoji sequences (and are folded away by foldName).
  if (/[\p{Cc}]|(?![\u200C\u200D])\p{Cf}/u.test(relPath)) fail('invalid', 'path contains control or format characters');
  if (relPath.includes('\\')) fail('invalid', 'path contains a backslash');
  if (/%[0-9a-fA-F]{2}/.test(relPath)) fail('invalid', 'path contains percent-encoded octets');
  if (/^[A-Za-z]:/.test(relPath)) fail('invalid', 'path has a drive prefix');
  if (path.isAbsolute(relPath) || relPath.startsWith('/')) fail('invalid', 'path must be relative');

  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '') fail('invalid', 'path contains an empty segment');
    const folded = foldName(segment);
    if (segment === '.' || segment === '..' || folded === '.' || folded === '..') {
      fail('invalid', 'path contains a dot segment');
    }
    if (folded.includes('/') || folded.includes('\\')) {
      fail('invalid', 'path segment normalizes to a separator');
    }
    if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) fail('invalid', 'path segment too long');
    if (vaultRules && (folded.startsWith('.') || PROTECTED_VAULT_NAMES.has(folded))) {
      fail('protected', 'path addresses a protected or hidden name');
    }
  }
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function realRoot(root: string): string {
  if (typeof root !== 'string' || root === '' || root.includes('\0')) fail('invalid', 'root must be a non-empty path');
  if (!path.isAbsolute(root)) fail('invalid', 'root must be absolute');
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    const code = errCode(err);
    fail('invalid', `root cannot be resolved (${code ?? 'error'})`, code);
  }
  if (!fs.statSync(real).isDirectory()) fail('invalid', 'root is not a directory');
  return real;
}

/**
 * Walk `segments` below the realpath'd root. Every existing component that is
 * a symlink is realpath'd and must stay inside the root; a symlink loop or a
 * dangling symlink is rejected. Returns the realpath of the deepest existing
 * ancestor joined with the not-yet-existing remainder.
 */
function walkInside(rootReal: string, segments: string[]): string {
  let current = rootReal;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]!);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') return path.join(current, ...segments.slice(i));
      if (code === 'ENOTDIR') fail('invalid', 'a path component is not a directory');
      fail('invalid', `cannot inspect path (${code ?? 'error'})`);
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(next);
      } catch (err) {
        const code = errCode(err);
        if (code === 'ELOOP') fail('symlink', 'symlink loop');
        fail('symlink', `dangling or unreadable symlink (${code ?? 'error'})`);
      }
      if (!isInside(rootReal, target)) fail('escape', 'symlink escapes the root');
      current = target;
    } else {
      current = next;
    }
  }
  return current;
}

function resolveUnder(root: string, relPath: string, vaultRules: boolean): SafePath {
  const rootReal = realRoot(root);
  const segments = splitRelative(relPath, vaultRules);
  const resolved = walkInside(rootReal, segments);
  if (!isInside(rootReal, resolved)) fail('escape', 'path escapes the root');
  return brand(resolved);
}

/** Resolve an external relative path inside the vault (I1). Hidden and protected names are refused. */
export function resolveInVault(root: string, relPath: string): SafePath {
  return resolveUnder(root, relPath, true);
}

/**
 * Join one directory-entry name (as returned by `readDirSafe`) onto an
 * already-resolved vault directory, applying the vault name rules (hidden and
 * protected names, separators, control characters are refused). Unlike
 * `resolveInVault` this does not realpath: it is for the scanner, which lstats
 * every entry and never follows symlinks (it skips them), and reads files with
 * O_NOFOLLOW.
 */
export function vaultChild(parent: SafePath, name: string): SafePath {
  const segments = splitRelative(name, true);
  if (segments.length !== 1) fail('invalid', 'entry name must be a single path segment');
  return brand(path.join(parent, name));
}

/** Resolve a relative path inside the state directory (I1). */
export function resolveInState(stateDir: string, relPath: string): SafePath {
  return resolveUnder(stateDir, relPath, false);
}

/** Resolve a relative path inside a caller-named external root (Claude projects dir, import source). */
export function resolveInRoot(root: string, relPath: string): SafePath {
  return resolveUnder(root, relPath, false);
}

/**
 * Assert that an absolute path resolves (realpath of the deepest existing
 * ancestor, symlinks checked) inside `root`. Returns the resolved path.
 */
export function assertInside(root: string, absPath: string): SafePath {
  if (typeof absPath !== 'string' || absPath.includes('\0')) fail('invalid', 'path must be a string without NUL');
  if (!path.isAbsolute(absPath)) fail('invalid', 'path must be absolute');
  const rootReal = realRoot(root);
  const normalized = path.resolve(absPath);
  const rootLexical = path.resolve(root);
  let rel: string;
  if (isInside(rootReal, normalized)) rel = path.relative(rootReal, normalized);
  else if (isInside(rootLexical, normalized)) rel = path.relative(rootLexical, normalized);
  else fail('escape', 'path is outside the root');
  const segments = rel === '' ? [] : rel.split(path.sep);
  const resolved = walkInside(rootReal, segments);
  if (!isInside(rootReal, resolved)) fail('escape', 'path escapes the root');
  return brand(resolved);
}

/** A read-only handle to a validated regular file outside the vault and state dir. */
export interface ExternalFile {
  readonly path: SafePath;
  readonly stat: fs.Stats;
  readBuffer(): Buffer;
  readText(): string;
  close(): void;
}

/**
 * Open an absolute path that must resolve inside one of `allowedRoots`
 * (named explicitly by the caller). The file is realpath'd, opened without
 * following a final symlink, and must be a regular file.
 */
export function openExternalFile(absPath: string, allowedRoots: readonly string[]): ExternalFile {
  if (allowedRoots.length === 0) fail('invalid', 'no allowed roots given');
  let resolved: SafePath | undefined;
  let lastError: unknown;
  for (const root of allowedRoots) {
    try {
      resolved = assertInside(root, absPath);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (resolved === undefined) throw lastError;
  let fd: number;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (errCode(err) === 'ELOOP') fail('symlink', 'file changed to a symlink');
    throw err;
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    fail('not-file', 'not a regular file');
  }
  let open = true;
  const handle: ExternalFile = {
    path: resolved,
    stat,
    readBuffer: () => {
      if (!open) fail('invalid', 'file is closed');
      return fs.readFileSync(fd);
    },
    readText: () => handle.readBuffer().toString('utf8'),
    close: () => {
      if (open) {
        open = false;
        fs.closeSync(fd);
      }
    },
  };
  return handle;
}

/** Open, read fully, and close an external file. */
export function readExternalFile(absPath: string, allowedRoots: readonly string[]): { path: SafePath; stat: fs.Stats; data: Buffer } {
  const file = openExternalFile(absPath, allowedRoots);
  try {
    return { path: file.path, stat: file.stat, data: file.readBuffer() };
  } finally {
    file.close();
  }
}

// ---------------------------------------------------------------------------
// Filesystem wrappers. All take a SafePath produced by a resolver above.
// ---------------------------------------------------------------------------

/** Throw unless the parent directory still realpaths to itself (no symlink swapped in). */
function revalidateParent(p: SafePath): string {
  const dir = path.dirname(p);
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch (err) {
    fail('changed', `parent directory unavailable (${errCode(err) ?? 'error'})`);
  }
  if (real !== dir) fail('changed', 'parent directory changed since it was resolved');
  return dir;
}

function tempSibling(p: SafePath): SafePath {
  const base = path.basename(p).slice(0, 64);
  return brand(path.join(path.dirname(p), `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`));
}

function toBuffer(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

function writeFd(fd: number, data: Uint8Array, mode: number): void {
  fs.fchmodSync(fd, mode);
  let offset = 0;
  while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
  fs.fsyncSync(fd);
}

/** Write a new dot-prefixed temp file next to `p` with an explicit mode. */
function writeTemp(p: SafePath, data: Uint8Array, mode: number): SafePath {
  revalidateParent(p);
  const tmp = tempSibling(p);
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFd(fd, data, mode);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  return tmp;
}

export function readFileSafe(p: SafePath): Buffer;
export function readFileSafe(p: SafePath, encoding: 'utf8'): string;
export function readFileSafe(p: SafePath, encoding?: 'utf8'): Buffer | string {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (errCode(err) === 'ELOOP') fail('symlink', 'file changed to a symlink');
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) fail('not-file', 'not a regular file');
    const buf = fs.readFileSync(fd);
    return encoding === 'utf8' ? buf.toString('utf8') : buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a regular file without following a final symlink, returning the
 * nanosecond-precision fstat taken on the same descriptor *before* reading
 * (so a concurrent edit makes the stat older than the content, never newer).
 * `maxBytes` refuses larger files with SafePathError('not-file') unread.
 */
export function readFileWithStatSafe(p: SafePath, opts: { maxBytes?: number } = {}): { data: Buffer; stat: fs.BigIntStats } {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (errCode(err) === 'ELOOP') fail('symlink', 'file changed to a symlink');
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) fail('not-file', 'not a regular file');
    if (opts.maxBytes !== undefined && stat.size > BigInt(opts.maxBytes)) fail('too-large', 'file exceeds the size limit');
    return { data: fs.readFileSync(fd), stat };
  } finally {
    fs.closeSync(fd);
  }
}

/** lstat with nanosecond (bigint) fields; undefined if the path does not exist. */
export function statBigSafe(p: SafePath): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
}

export function readDirSafe(p: SafePath): fs.Dirent[] {
  return fs.readdirSync(p, { withFileTypes: true });
}

/** lstat; returns undefined if the path does not exist. */
export function statSafe(p: SafePath): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

export interface WriteOptions {
  mode?: number;
}

export interface CreateExclusiveOptions extends WriteOptions {
  /** `link` (default) publishes tmp via link(2); `excl` opens the target with O_EXCL. */
  strategy?: 'link' | 'excl';
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

function createWithExcl(p: SafePath, data: Uint8Array, mode: number): void {
  revalidateParent(p);
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  } catch (err) {
    if (errCode(err) === 'EEXIST') fail('exists', 'target already exists');
    throw err;
  }
  try {
    writeFd(fd, data, mode);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(p, { force: true });
    throw err;
  }
  fs.closeSync(fd);
}

/**
 * Publish a new file without ever overwriting: write a same-directory temp
 * file, then link(tmp, final) (EEXIST means collision). Falls back to O_EXCL
 * where hard links are unavailable. Throws SafePathError('exists') on collision.
 */
export function createExclusive(p: SafePath, data: string | Uint8Array, opts: CreateExclusiveOptions = {}): void {
  const mode = opts.mode ?? FILE_MODE;
  const buf = toBuffer(data);
  if (opts.strategy === 'excl') return createWithExcl(p, buf, mode);
  const tmp = writeTemp(p, buf, mode);
  try {
    revalidateParent(p);
    fs.linkSync(tmp, p);
  } catch (err) {
    const code = errCode(err);
    if (code === 'EEXIST') fail('exists', 'target already exists');
    if (code !== undefined && LINK_UNSUPPORTED.has(code)) return createWithExcl(p, buf, mode);
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Replace (or create) a file atomically: same-directory temp file, fsync, rename. */
export function writeAtomic(p: SafePath, data: string | Uint8Array, opts: WriteOptions = {}): void {
  const mode = opts.mode ?? FILE_MODE;
  const existing = statSafe(p);
  if (existing !== undefined && !existing.isFile()) fail('not-file', 'target exists and is not a regular file');
  const tmp = writeTemp(p, toBuffer(data), mode);
  try {
    revalidateParent(p);
    fs.renameSync(tmp, p);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export interface RenameOptions {
  /** Replace an existing target. Default false: collision throws SafePathError('exists'). */
  overwrite?: boolean;
}

/**
 * Rename within resolved roots. Without `overwrite`, files are moved with
 * link + unlink so an existing target is never replaced; directories (and
 * filesystems without hard links) fall back to check-then-rename.
 */
export function renameSafe(from: SafePath, to: SafePath, opts: RenameOptions = {}): void {
  revalidateParent(from);
  revalidateParent(to);
  const src = statSafe(from);
  if (src === undefined) fail('invalid', 'source does not exist');
  if (src.isSymbolicLink()) fail('symlink', 'source is a symlink');
  if (opts.overwrite) {
    fs.renameSync(from, to);
    return;
  }
  if (src.isFile()) {
    try {
      fs.linkSync(from, to);
      fs.unlinkSync(from);
      return;
    } catch (err) {
      const code = errCode(err);
      if (code === 'EEXIST') fail('exists', 'target already exists');
      if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw err;
    }
  }
  if (statSafe(to) !== undefined) fail('exists', 'target already exists');
  fs.renameSync(from, to);
}

/** Remove a file (never a directory). Missing files are ignored. */
export function unlinkSafe(p: SafePath): void {
  revalidateParent(p);
  const st = statSafe(p);
  if (st === undefined) return;
  if (st.isDirectory()) fail('not-file', 'refusing to unlink a directory');
  fs.unlinkSync(p);
}

/** Create a directory (and missing parents) below an existing resolved ancestor, each with an explicit mode. */
export function mkdirSafe(p: SafePath, opts: WriteOptions = {}): void {
  const mode = opts.mode ?? DIR_MODE;
  const missing: string[] = [];
  let cursor: string = p;
  for (;;) {
    const st = statSafe(brand(cursor));
    if (st !== undefined) {
      if (!st.isDirectory()) fail('invalid', 'a path component is not a directory');
      break;
    }
    missing.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('invalid', 'no existing ancestor');
    cursor = parent;
  }
  for (const dir of missing) {
    revalidateParent(brand(dir));
    try {
      fs.mkdirSync(dir, { mode });
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
      if (!fs.lstatSync(dir).isDirectory()) fail('invalid', 'a path component is not a directory');
      continue;
    }
    fs.chmodSync(dir, mode);
  }
}

/**
 * Create (or tighten) the private state directory from an owner-configured
 * absolute path: missing components are created 0700, and the directory
 * itself is chmod'ed 0700. It must be a real directory owned by this user.
 */
export function ensurePrivateDir(absPath: string): SafePath {
  if (typeof absPath !== 'string' || absPath.includes('\0') || !path.isAbsolute(absPath)) {
    fail('invalid', 'state directory must be an absolute path');
  }
  const target = path.resolve(absPath);
  const missing: string[] = [];
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    missing.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('invalid', 'no existing ancestor');
    cursor = parent;
  }
  for (const dir of missing) {
    fs.mkdirSync(dir, { mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
  }
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('invalid', 'state directory must be a real directory, not a symlink');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    fail('invalid', 'state directory is not owned by the current user');
  }
  if ((st.mode & 0o777) !== DIR_MODE) fs.chmodSync(target, DIR_MODE);
  return brand(fs.realpathSync(target));
}
