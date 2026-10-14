// The journal store (Phase 9, I2): the only code an MCP tool can use to put
// a file in a journal-mode vault. It builds every path itself from the
// configured principal id, a validated slug, and the clock, so it can only
// create `journal/<principal-id>/<yyyy>/<yyyymmdd-hhmmss>-<slug>.md`:
//
//   - create-only by the filesystem: `createExclusive` writes a dot-prefixed
//     temp file and publishes it with link(2) (EEXIST is a collision, never
//     an overwrite); a name collision is an error, not a retry, so two
//     concurrent appends to one target name give one file and one error;
//   - limits, dedup, and create run under one cross-process lock,
//     `<stateDir>/locks/journal-<principal-id>.lock`, and are computed from
//     the journal directory itself (file-name stamps and stat sizes; dedup
//     reads the last 24h of entry files), never from the index or the audit
//     log, so they hold with several MCP processes and a stale index.

import * as path from 'node:path';
import type { JournalConfig } from '../config.js';
import { isSlug, type Slug } from '../inbox/note.js';
import { LockError, withLock } from '../lock.js';
import {
  createExclusive, mkdirSafe, readDirSafe, readFileWithStatSafe, resolveInVault, SafePathError, statSafe, vaultChild, type SafePath,
} from '../safe-path.js';
import { decodeNote } from '../vault/parse.js';
import { bodyHash, entryBody, entryNameMs, ENTRY_NAME_RE, isPrincipalId, JOURNAL_DIR, YEAR_DIR_RE } from './entry.js';

export const HOUR_MS = 3_600_000;
export const DEDUP_WINDOW_MS = 24 * HOUR_MS;
const MB = 1024 * 1024;
/** Directory depth walked below `journal/<principal-id>/` when summing sizes. */
const MAX_WALK_DEPTH = 6;
/** Entry files larger than this are not read for dedup (they cannot have come from journal_append). */
const MAX_DEDUP_READ_BYTES = 4 * MB;

export type JournalRefusal = 'entry-size' | 'rate' | 'total-size' | 'duplicate' | 'exists' | 'busy';

/** A refused append. `code` is audited; `existing` (duplicates) is the vault-relative path of the earlier entry. */
export class JournalRefusedError extends Error {
  constructor(
    readonly code: JournalRefusal,
    message: string,
    readonly existing?: string,
  ) {
    super(message);
    this.name = 'JournalRefusedError';
  }
}

/** `journal/<principal-id>` as a vault-relative path, after validating the id. */
export function principalRel(principalId: string): string {
  if (!isPrincipalId(principalId)) throw new SafePathError('invalid', 'journal needs a valid principal id');
  return `${JOURNAL_DIR}/${principalId}`;
}

/**
 * Resolve (and create, 0700) a real directory `rel` that must sit exactly at
 * `<vault>/<rel>`: no component of it may be a symlink, so a write can never
 * be redirected elsewhere in the vault.
 */
export function realVaultDir(vaultPath: string, rel: string, create = true): SafePath | undefined {
  const root = resolveInVault(vaultPath, '');
  const parts = rel.split('/');
  let dir: SafePath = root;
  for (let i = 0; i < parts.length; i++) {
    const next = resolveInVault(vaultPath, parts.slice(0, i + 1).join('/'));
    if (path.dirname(next) !== dir || path.basename(next) !== parts[i]) {
      throw new SafePathError('escape', `${parts.slice(0, i + 1).join('/')}/ does not resolve to itself inside the vault`);
    }
    const st = statSafe(next);
    if (st === undefined) {
      if (!create) return undefined;
      mkdirSafe(next);
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new SafePathError('invalid', `${parts.slice(0, i + 1).join('/')}/ must be a real directory`);
    }
    dir = next;
  }
  return dir;
}

export interface JournalFile {
  /** Vault-relative path. */
  relPath: string;
  /** Bytes (`stat`). */
  size: number;
  /** File-name stamp (UTC ms) for entry files; undefined for other files (imports). */
  ms: number | undefined;
}

export interface JournalScan {
  totalBytes: number;
  files: JournalFile[];
}

/**
 * Every regular file below `journal/<principal-id>/` (dot-files, which are
 * in-flight temp files, and symlinks are skipped), with sizes from lstat.
 */
export function scanJournal(vaultPath: string, principalId: string): JournalScan {
  const rel = principalRel(principalId);
  const out: JournalScan = { totalBytes: 0, files: [] };
  const top = realVaultDir(vaultPath, rel, false);
  if (top === undefined) return out;
  const walk = (dir: SafePath, dirRel: string, depth: number, inYear: boolean) => {
    for (const ent of readDirSafe(dir)) {
      if (ent.name.startsWith('.')) continue;
      let child: SafePath;
      try {
        child = vaultChild(dir, ent.name);
      } catch {
        continue;
      }
      const st = statSafe(child);
      if (st === undefined || st.isSymbolicLink()) continue;
      const childRel = `${dirRel}/${ent.name}`;
      if (st.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) walk(child, childRel, depth + 1, depth === 0 && YEAR_DIR_RE.test(ent.name));
      } else if (st.isFile()) {
        out.totalBytes += st.size;
        out.files.push({ relPath: childRel, size: st.size, ms: inYear ? entryNameMs(ent.name) : undefined });
      }
    }
  };
  walk(top, rel, 0, false);
  return out;
}

/** The earlier entry (created in the last 24h) whose normalized body hashes to `hash`, if any. */
function findDuplicate(vaultPath: string, scan: JournalScan, hash: string, nowMs: number): string | undefined {
  for (const f of scan.files) {
    if (f.ms === undefined || f.ms < nowMs - DEDUP_WINDOW_MS || f.size > MAX_DEDUP_READ_BYTES) continue;
    let text: string;
    try {
      text = decodeNote(readFileWithStatSafe(resolveInVault(vaultPath, f.relPath), { maxBytes: MAX_DEDUP_READ_BYTES }).data).text;
    } catch {
      continue;
    }
    if (bodyHash(entryBody(text)) === hash) return f.relPath;
  }
  return undefined;
}

export interface AppendRequest {
  principalId: string;
  slug: Slug;
  /** Creation time; sets the file name stamp and the year folder. */
  when: Date;
  /** The full note text (rendered and scrubbed). */
  text: string;
  /** The entry body as stored (scrubbed), for dedup. */
  body: string;
  /** Characters the caller submitted in the body (the size limit is on what was sent; never truncated). */
  submittedChars: number;
}

export interface JournalStoreEnv {
  vaultPath: string;
  stateDir: SafePath;
  limits: JournalConfig;
  /** Lock wait (default: the lock helper's 10 s). */
  lockWaitMs?: number;
}

export interface AppendResult {
  relPath: string;
  name: string;
}

/** `yyyymmdd-hhmmss` in UTC. */
function stampOf(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '').replace(/-|:/g, '').replace('T', '-');
}

/**
 * Check every limit and create the entry, all under the principal's journal
 * lock. Throws JournalRefusedError on a limit, a duplicate, a name
 * collision, or a lock timeout; nothing is written in any of those cases.
 */
export function appendEntry(env: JournalStoreEnv, req: AppendRequest): AppendResult {
  const rel = principalRel(req.principalId);
  if (!isSlug(req.slug)) throw new SafePathError('invalid', 'journal store needs a sanitized slug');
  const stamp = stampOf(req.when);
  const name = `${stamp}-${req.slug}.md`;
  if (!ENTRY_NAME_RE.test(name)) throw new SafePathError('invalid', 'journal file name is not well-formed');
  const year = stamp.slice(0, 4);
  const nowMs = req.when.getTime();
  const lockOpts = env.lockWaitMs === undefined ? {} : { waitMs: env.lockWaitMs };
  try {
    return withLock(env.stateDir, `journal-${req.principalId}`, () => {
      const { limits } = env;
      if (req.submittedChars > limits.maxEntryChars) {
        throw new JournalRefusedError('entry-size', `entry body exceeds journal.maxEntryChars (${limits.maxEntryChars} characters); nothing was stored`);
      }
      const scan = scanJournal(env.vaultPath, req.principalId);
      if (scan.totalBytes + Buffer.byteLength(req.text, 'utf8') > limits.maxTotalMB * MB) {
        throw new JournalRefusedError('total-size', `the journal would exceed journal.maxTotalMB (${limits.maxTotalMB} MB); nothing was stored`);
      }
      const lastHour = scan.files.filter((f) => f.ms !== undefined && f.ms > nowMs - HOUR_MS).length;
      if (lastHour >= limits.maxEntriesPerHour) {
        throw new JournalRefusedError('rate', `journal.maxEntriesPerHour (${limits.maxEntriesPerHour}) reached; nothing was stored`);
      }
      const dup = findDuplicate(env.vaultPath, scan, bodyHash(req.body), nowMs);
      if (dup !== undefined) {
        throw new JournalRefusedError('duplicate', `duplicate of an entry created in the last 24 hours (${dup}); nothing was stored`, dup);
      }
      const dir = realVaultDir(env.vaultPath, `${rel}/${year}`)!;
      const relPath = `${rel}/${year}/${name}`;
      const target = resolveInVault(env.vaultPath, relPath);
      if (path.dirname(target) !== dir) throw new SafePathError('escape', 'journal file resolves outside journal/<principal-id>/');
      try {
        createExclusive(target, req.text);
      } catch (err) {
        if (err instanceof SafePathError && err.code === 'exists') {
          throw new JournalRefusedError('exists', `an entry named ${relPath} already exists; nothing was written (entries are never overwritten)`);
        }
        throw err;
      }
      return { relPath, name };
    }, lockOpts);
  } catch (err) {
    if (err instanceof LockError && err.code === 'timeout') throw new JournalRefusedError('busy', 'the journal is busy; try again');
    throw err;
  }
}
