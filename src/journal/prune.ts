// `ebrain journal prune` (Phase 9, owner CLI; not an MCP tool): move journal
// entries whose `expires` has passed into
// `journal/_archive/<principal-id>/<same subpath>` (so `<yyyy>/` is kept,
// principals never mix, and names never collide). It never deletes: a file
// is published at the archive path with link(2) (never over an existing
// name) and only then unlinked from the journal. `expires` is read from each
// file's frontmatter, not from the index.

import { isoToMs } from '../mcp/tools.js';
import { readDirSafe, readFileWithStatSafe, renameSafe, resolveInVault, SafePathError, statSafe, vaultChild } from '../safe-path.js';
import { parseNote } from '../vault/parse.js';
import { isPrincipalId, JOURNAL_ARCHIVE_DIR, JOURNAL_DIR } from './entry.js';
import { realVaultDir, scanJournal } from './store.js';

const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface PruneItem {
  /** Vault-relative journal path. */
  from: string;
  /** Vault-relative archive path. */
  to: string;
  expires: string;
}

export interface PruneResult {
  /** Moved (or, with dryRun, would be moved). */
  archived: PruneItem[];
  skipped: { path: string; reason: string }[];
}

/** Principal directories directly under `journal/` (never `_archive/`). */
function principalDirs(vaultPath: string): string[] {
  const journal = realVaultDir(vaultPath, JOURNAL_DIR, false);
  if (journal === undefined) return [];
  const out: string[] = [];
  for (const ent of readDirSafe(journal)) {
    if (ent.name === JOURNAL_ARCHIVE_DIR || !isPrincipalId(ent.name)) continue;
    let st;
    try {
      st = statSafe(vaultChild(journal, ent.name));
    } catch {
      continue;
    }
    if (st !== undefined && st.isDirectory() && !st.isSymbolicLink()) out.push(ent.name);
  }
  return out;
}

/** Archive every expired entry of every principal in the vault (`dryRun`: list only). */
export function pruneJournal(vaultPath: string, opts: { now?: Date; dryRun?: boolean } = {}): PruneResult {
  const now = (opts.now ?? new Date()).getTime();
  const result: PruneResult = { archived: [], skipped: [] };
  for (const pid of principalDirs(vaultPath)) {
    const prefix = `${JOURNAL_DIR}/${pid}/`;
    for (const f of scanJournal(vaultPath, pid).files) {
      if (!f.relPath.endsWith('.md')) continue;
      let expires: string | null;
      try {
        const { data } = readFileWithStatSafe(resolveInVault(vaultPath, f.relPath), { maxBytes: MAX_READ_BYTES });
        expires = parseNote(f.relPath, data).fields.expires;
      } catch {
        result.skipped.push({ path: f.relPath, reason: 'unreadable' });
        continue;
      }
      const ms = expires === null ? undefined : isoToMs(expires, 'end');
      if (ms === undefined || ms >= now) continue;
      const sub = f.relPath.slice(prefix.length);
      const to = `${JOURNAL_DIR}/${JOURNAL_ARCHIVE_DIR}/${pid}/${sub}`;
      const item = { from: f.relPath, to, expires: expires! };
      if (opts.dryRun === true) {
        result.archived.push(item);
        continue;
      }
      try {
        const subDir = sub.includes('/') ? `/${sub.slice(0, sub.lastIndexOf('/'))}` : '';
        realVaultDir(vaultPath, `${JOURNAL_DIR}/${JOURNAL_ARCHIVE_DIR}/${pid}${subDir}`);
        renameSafe(resolveInVault(vaultPath, f.relPath), resolveInVault(vaultPath, to));
        result.archived.push(item);
      } catch (err) {
        const reason = err instanceof SafePathError && err.code === 'exists' ? 'archive target already exists' : 'could not be moved';
        result.skipped.push({ path: f.relPath, reason });
      }
    }
  }
  return result;
}
