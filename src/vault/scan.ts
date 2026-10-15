// Vault scanner. Walks the vault through safe-path, collecting `*.md` files
// with their stat key. Read-only: it never writes to the vault.
//
// Skipped: every dot-directory and dot-file (`.obsidian/`, `.git/`, `.trash/`,
// and the writers' temporary files), every symlink (never followed, never
// read, whether it points inside or outside the vault), names the vault path
// rules refuse, and anything that is not a regular file or directory.

import { comparePaths } from './names.js';
import { readDirSafe, resolveInVault, SafePathError, statBigSafe, vaultChild, type SafePath } from '../safe-path.js';

/** Per-file stat key; decimal strings because inode numbers can exceed int64. */
export interface StatKey {
  size: string;
  mtimeNs: string;
  ino: string;
  ctimeNs: string;
}

export interface ScannedFile {
  /** Vault-relative path with `/` separators, exactly as named on disk. */
  relPath: string;
  abs: SafePath;
  stat: StatKey;
}

export interface ScanSkips {
  symlinks: number;
  hidden: number;
  unsafeNames: number;
  other: number;
}

export interface ScanResult {
  root: SafePath;
  /** Sorted by `comparePaths` (I11). */
  files: ScannedFile[];
  skipped: ScanSkips;
  /** Relative paths of skipped symlinks and unsafe names, sorted, for reporting. */
  skippedPaths: string[];
}

export function statKeyOf(st: { size: bigint; mtimeNs: bigint; ino: bigint; ctimeNs: bigint }): StatKey {
  return { size: st.size.toString(), mtimeNs: st.mtimeNs.toString(), ino: st.ino.toString(), ctimeNs: st.ctimeNs.toString() };
}

export function sameStatKey(a: StatKey, b: StatKey): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.ctimeNs === b.ctimeNs;
}

export function scanVault(vaultPath: string): ScanResult {
  const root = resolveInVault(vaultPath, '');
  const files: ScannedFile[] = [];
  const skipped: ScanSkips = { symlinks: 0, hidden: 0, unsafeNames: 0, other: 0 };
  const skippedPaths: string[] = [];

  const walk = (dir: SafePath, relDir: string): void => {
    let entries: ReturnType<typeof readDirSafe>;
    try {
      entries = readDirSafe(dir);
    } catch (err) {
      // The root must be readable; an unreadable or vanished subdirectory is skipped and counted (I10).
      const code = (err as NodeJS.ErrnoException).code;
      if (relDir === '' || (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT' && code !== 'ENOTDIR')) throw err;
      skipped.other++;
      skippedPaths.push(relDir);
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (name.startsWith('.')) {
        skipped.hidden++;
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.symlinks++;
        skippedPaths.push(rel);
        continue;
      }
      let abs: SafePath;
      try {
        abs = vaultChild(dir, name);
      } catch (err) {
        if (!(err instanceof SafePathError)) throw err;
        if (err.code === 'protected') skipped.hidden++;
        else {
          skipped.unsafeNames++;
          skippedPaths.push(rel);
        }
        continue;
      }
      if (entry.isDirectory()) {
        // Re-lstat just before descending to narrow the swap-for-symlink window.
        const st = statBigSafe(abs);
        if (st === undefined) continue;
        if (!st.isDirectory()) {
          if (st.isSymbolicLink()) {
            skipped.symlinks++;
            skippedPaths.push(rel);
          } else skipped.other++;
          continue;
        }
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (!name.endsWith('.md')) continue;
        // lstat again: the entry may have changed since readdir. A vanished
        // file is simply not part of this scan.
        const st = statBigSafe(abs);
        if (st === undefined) continue;
        if (!st.isFile()) {
          if (st.isSymbolicLink()) {
            skipped.symlinks++;
            skippedPaths.push(rel);
          } else skipped.other++;
          continue;
        }
        files.push({ relPath: rel, abs, stat: statKeyOf(st) });
      } else {
        skipped.other++;
      }
    }
  };

  walk(root, '');
  files.sort((a, b) => comparePaths(a.relPath, b.relPath));
  skippedPaths.sort(comparePaths);
  return { root, files, skipped, skippedPaths };
}
