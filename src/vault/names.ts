// Name normalization, deterministic ordering (I11), and folder classes.
//
// Vault paths are stored as found on disk (the raw name is what opens the
// file) plus two derived keys: the NFC form, which every listing sorts on
// bytewise, and a case-folded NFC form for link resolution and collision
// detection. APFS and ext4 differ on case and normalization sensitivity, so
// matching never depends on the filesystem: results are identical on macOS
// and Linux.

/** Unicode NFC. */
export function nfc(s: string): string {
  return s.normalize('NFC');
}

/**
 * NFC plus locale-independent case folding. Upper-then-lower maps the
 * special cases plain lowercasing misses (for example `ß` and `SS` both fold
 * to `ss`); the result is re-normalized because case mapping can denormalize.
 */
export function foldKey(s: string): string {
  return nfc(nfc(s).toUpperCase().toLowerCase());
}

/** Bytewise comparison of the UTF-8 encodings (never locale-dependent). */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Listing order for vault paths: bytewise on NFC, then bytewise on the raw name. */
export function comparePaths(a: string, b: string): number {
  return compareBytes(nfc(a), nfc(b)) || compareBytes(a, b);
}

export type FolderClass = 'curated' | 'inbox' | 'journal' | 'raw' | 'archive' | 'reference';

export interface FolderInfo {
  folderClass: FolderClass;
  /** Hidden by default because of where the note lives (archives, rejected/applied proposals). */
  hidden: boolean;
}

/**
 * Folder class from a vault-relative path ("Folder and status semantics").
 * Folder names compare case-folded so that `_Inbox/` on a case-insensitive
 * filesystem can never be mistaken for curated memory.
 */
export function folderClass(relPath: string): FolderInfo {
  const parts = relPath.split('/').slice(0, -1).map(foldKey);
  const [top, second] = parts;
  switch (top) {
    case '_inbox':
      return { folderClass: 'inbox', hidden: second === '_rejected' || second === '_applied' };
    case 'journal':
      return second === '_archive' ? { folderClass: 'archive', hidden: true } : { folderClass: 'journal', hidden: false };
    case '_raw':
      return { folderClass: 'raw', hidden: false };
    case '_archive':
      return { folderClass: 'archive', hidden: true };
    case 'references':
      return { folderClass: 'reference', hidden: false };
    default:
      return { folderClass: 'curated', hidden: false };
  }
}

/** File name without directory and without the `.md` extension. */
export function noteBasename(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/**
 * Groups of paths that differ only by case or Unicode normalization (they
 * name one file on APFS but two on ext4). Each group and the group list are
 * in listing order.
 */
export function findCollisions(paths: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = foldKey(p);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort(comparePaths))
    .sort((a, b) => comparePaths(a[0]!, b[0]!));
}
