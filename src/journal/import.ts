// `ebrain import agent-workspace <dir> --principal <id>` (Phase 9, owner
// CLI): copy an existing agent workspace into
// `journal/<principal-id>/imported/` as journal entries.
//
//   MEMORY.md            -> kind observation
//   memory/YYYY-MM-DD.md -> kind log (occurred: that date)
//   GOALS.md             -> kind todo
//   SOUL.md, TOOLS.md    -> kind reference (optional)
//
// The source directory is read only through `openExternalFile` with the
// directory as the one allowed root (realpath and symlink rules; it is never
// written). Every file is scrubbed under strict agent rules: a file that
// trips a credential detector is skipped whole and listed. Imports are
// idempotent by content hash: the target name carries the source's sha256
// prefix and is created exclusively, so a re-run (or an unchanged file)
// creates nothing, and a changed file is imported as a new entry beside the
// old one (nothing is overwritten). Imported entries have no `expires`.

import { createHash } from 'node:crypto';
import { cleanTitle, isoSeconds } from '../inbox/note.js';
import { withLock } from '../lock.js';
import { ulid } from '../mcp/ulid.js';
import {
  createExclusive, openExternalFile, readDirSafe, resolveInRoot, resolveInVault, SafePathError, statSafe, type SafePath,
} from '../safe-path.js';
import { scrub, scrubVersion } from '../scrub/index.js';
import { decodeNote } from '../vault/parse.js';
import { IMPORTED_DIR, isPrincipalId, renderEntry } from './entry.js';
import { principalRel, realVaultDir } from './store.js';

/** Largest source file imported. */
export const MAX_IMPORT_BYTES = 1024 * 1024;
const DAILY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

export interface ImportOptions {
  vaultPath: string;
  stateDir: SafePath;
  principalId: string;
  extraPatterns?: readonly string[];
  now?: Date;
}

export interface ImportSummary {
  imported: { source: string; path: string }[];
  /** Already imported with the same content hash. */
  unchanged: { source: string; path: string }[];
  skipped: { source: string; reason: string }[];
}

interface Candidate {
  /** Path relative to the workspace (`/`-separated). */
  source: string;
  stem: string;
  kind: string;
  title: string;
  occurred?: string;
}

function candidates(root: SafePath): Candidate[] {
  const out: Candidate[] = [];
  const top: [string, string, string][] = [
    ['MEMORY.md', 'memory', 'observation'],
    ['GOALS.md', 'goals', 'todo'],
    ['SOUL.md', 'soul', 'reference'],
    ['TOOLS.md', 'tools', 'reference'],
  ];
  // A name that cannot be resolved (for example a symlink escaping the
  // workspace) is still listed, so the open below refuses it and reports it.
  const present = (name: string): boolean => {
    try {
      return statSafe(resolveInRoot(root, name)) !== undefined;
    } catch {
      return true;
    }
  };
  for (const [name, stem, kind] of top) {
    if (present(name)) out.push({ source: name, stem, kind, title: `${name} (imported)` });
  }
  let memDir: SafePath | undefined;
  try {
    memDir = resolveInRoot(root, 'memory');
  } catch {
    memDir = undefined;
  }
  const st = memDir === undefined ? undefined : statSafe(memDir);
  if (memDir !== undefined && st !== undefined && st.isDirectory()) {
    const names = readDirSafe(memDir).map((e) => e.name).filter((n) => DAILY_RE.test(n));
    // Directory order is filesystem-dependent; daily names are fixed-width dates.
    for (const name of [...names].sort()) {
      const date = DAILY_RE.exec(name)![1]!;
      out.push({ source: `memory/${name}`, stem: `daily-${date}`, kind: 'log', title: `Daily notes ${date} (imported)`, occurred: date });
    }
  }
  return out;
}

/** Import the workspace at `sourceDir` (absolute) into `journal/<principal-id>/imported/`. */
export function importAgentWorkspace(sourceDir: string, opts: ImportOptions): ImportSummary {
  if (!isPrincipalId(opts.principalId)) throw new SafePathError('invalid', 'import needs a valid principal id');
  const root = resolveInRoot(sourceDir, '');
  const st = statSafe(root);
  if (st === undefined || !st.isDirectory()) throw new SafePathError('invalid', 'workspace is not a directory');
  const now = opts.now ?? new Date();
  const summary: ImportSummary = { imported: [], unchanged: [], skipped: [] };
  const destRel = `${principalRel(opts.principalId)}/${IMPORTED_DIR}`;

  for (const c of candidates(root)) {
    let data: Buffer;
    try {
      const file = openExternalFile(resolveInRoot(root, c.source), [root]);
      try {
        if (file.stat.size > MAX_IMPORT_BYTES) {
          summary.skipped.push({ source: c.source, reason: `larger than ${MAX_IMPORT_BYTES} bytes` });
          continue;
        }
        data = file.readBuffer();
      } finally {
        file.close();
      }
    } catch (err) {
      const why = err instanceof SafePathError ? err.code : 'unreadable';
      summary.skipped.push({ source: c.source, reason: `not imported (${why})` });
      continue;
    }
    const decoded = decodeNote(data);
    if (decoded.invalidUtf8) {
      summary.skipped.push({ source: c.source, reason: 'not valid UTF-8' });
      continue;
    }
    const scrubbed = scrub(decoded.text, { strict: true, extraPatterns: opts.extraPatterns ?? [] });
    if (!scrubbed.ok) {
      summary.skipped.push({ source: c.source, reason: `strict scrub (${scrubbed.rejection.detectors.join(', ')})` });
      continue;
    }
    const hash = createHash('sha256').update(data).digest('hex');
    const name = `${c.stem}-${hash.slice(0, 12)}.md`;
    const relPath = `${destRel}/${name}`;
    const extra: Record<string, unknown> = { imported_from: c.source, imported_sha256: hash };
    if (c.occurred !== undefined) extra['occurred'] = c.occurred;
    const text = renderEntry(
      {
        id: ulid(now.getTime()), title: cleanTitle(c.title), author: opts.principalId, origin: 'import', created: isoSeconds(now),
        kind: c.kind, sources: [], untrustedOrigin: false, scrubVersion, extra,
      },
      scrubbed.text,
    );
    const created = withLock(opts.stateDir, `journal-${opts.principalId}`, () => {
      realVaultDir(opts.vaultPath, destRel);
      try {
        createExclusive(resolveInVault(opts.vaultPath, relPath), text);
        return true;
      } catch (err) {
        if (err instanceof SafePathError && err.code === 'exists') return false;
        throw err;
      }
    });
    (created ? summary.imported : summary.unchanged).push({ source: c.source, path: relPath });
  }
  return summary;
}
