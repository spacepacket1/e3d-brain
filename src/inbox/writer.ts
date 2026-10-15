// The inbox writer (Phase 8, I2): the only code an MCP tool can use to put a
// file in the vault. It takes a validated `Slug` (never a path), builds the
// file name itself (`<yyyymmdd-hhmmss>-<slug>[-n].md`), and publishes it with
// `createExclusive` directly inside `<vault>/_inbox/`, so it is structurally
// unable to write anywhere else or to overwrite an existing file: on a name
// collision the slug gets a numeric suffix.
//
// Owner-run CLI jobs may use it in any mode; MCP tools reach it only in
// `inbox` mode (the tools are registered for that mode alone).

import * as path from 'node:path';
import { createExclusive, mkdirSafe, resolveInVault, SafePathError, statSafe, type SafePath } from '../safe-path.js';
import { fileStamp, isSlug, suffixedSlug, type Slug } from './note.js';

/** The inbox folder, relative to the vault root. */
export const INBOX_DIR = '_inbox';
/** Name collisions tried before giving up. */
export const MAX_NAME_ATTEMPTS = 1000;

const INBOX_NAME_RE = /^\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** Resolve `<vault>/_inbox/`, creating it (0700) if missing. It must be a real directory directly under the vault root. */
export function inboxDir(vaultPath: string): SafePath {
  const root = resolveInVault(vaultPath, '');
  const dir = resolveInVault(vaultPath, INBOX_DIR);
  const st = statSafe(dir);
  if (st === undefined) mkdirSafe(dir);
  else if (st.isSymbolicLink() || !st.isDirectory()) throw new SafePathError('invalid', `${INBOX_DIR}/ must be a real directory`);
  if (path.dirname(dir) !== root || path.basename(dir) !== INBOX_DIR) throw new SafePathError('escape', `${INBOX_DIR}/ does not resolve inside the vault root`);
  return dir;
}

export interface InboxWrite {
  /** Vault-relative path of the new file. */
  relPath: string;
  name: string;
}

/**
 * Create a new inbox file for `slug` holding `text` (mode 0600, temp file
 * then link: never a rename over an existing name).
 */
export function writeInboxFile(vaultPath: string, slug: Slug, when: Date, text: string): InboxWrite {
  if (!isSlug(slug)) throw new SafePathError('invalid', 'inbox writer needs a sanitized slug');
  const dir = inboxDir(vaultPath);
  const stamp = fileStamp(when);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const name = `${stamp}-${suffixedSlug(slug, attempt)}.md`;
    if (!INBOX_NAME_RE.test(name)) throw new SafePathError('invalid', 'inbox file name is not well-formed');
    const target = resolveInVault(vaultPath, `${INBOX_DIR}/${name}`);
    if (path.dirname(target) !== dir) throw new SafePathError('escape', 'inbox file resolves outside _inbox/');
    const relPath = `${INBOX_DIR}/${name}`;
    try {
      createExclusive(target, text);
      return { relPath, name };
    } catch (err) {
      if (err instanceof SafePathError && err.code === 'exists') continue;
      throw err;
    }
  }
  throw new SafePathError('exists', 'too many inbox files with this name');
}
