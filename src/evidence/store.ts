// Evidence files and their derived index (cognition Phase 3).
//
// Sources are the files listed in `evidence.sources` (in config order) and
// every `*.jsonl` directly in `evidence.dir` (in name order). Nothing else is
// ever read (I1): each file is opened through `openExternalFile` with its own
// configured root (the listed file's directory, or `evidence.dir`), so a
// symlink that leaves that root, a non-regular file, or a dot-file is refused
// and reported, never followed. Files are read-only to us, size-limited
// (`evidence.maxFileMB`), and line-validated (`record.ts`).
//
// Records are indexed into `<stateDir>/evidence.db`, derived data like
// `index.db` and `refs.db`: it is rebuilt whenever the set of source files,
// any file's stat key, the limits, or the scrub settings change, and
// `ebrain evidence reindex` rebuilds it unconditionally. When two records
// share a kind and id, the later one (file order, then line order) wins and
// the earlier is counted as a duplicate. Nothing here opens a network
// connection (I3).

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { Config } from '../config.js';
import { BUSY_TIMEOUT_MS } from '../index/db.js';
import { loadSqlite, NATIVE_BUILD_HINT } from '../index/sqlite.js';
import { withLock } from '../lock.js';
import {
  assertInside, createExclusive, ensurePrivateDir, openExternalFile, readDirSafe, resolveInRoot, resolveInState, SafePathError,
  statSafe, writeAtomic, type ExternalFile, type SafePath,
} from '../safe-path.js';
import { scrubVersion, type ScrubOptions } from '../scrub/scrub.js';
import { emptyCounts, parseEvidenceBuffer, SKIP_REASONS, type EvidenceRecord, type LineCounts, type RecordLimits } from './record.js';
import { sinceKey, type EvidenceResolution, type EvidenceSource } from './source.js';

export const EVIDENCE_DB_FILE = 'evidence.db';
export const EVIDENCE_LOCK = 'evidence';
/** Bump when the table layout changes: an evidence.db with another version is dropped and rebuilt. */
export const EVIDENCE_SCHEMA_VERSION = 1;
/** Name an imported file may have in `evidence.dir`. */
export const EVIDENCE_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,122}\.jsonl$/;

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

export interface EvidenceEnv {
  config: Config;
  stateDir: SafePath;
}

type Db = BetterSqlite3.Database;

const TABLES = ['meta', 'evidence_files', 'evidence'];
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE evidence_files (
  ord INTEGER PRIMARY KEY,        -- load order: evidence.sources, then evidence.dir by name
  path TEXT NOT NULL,             -- as configured (sources) or dir/name
  origin TEXT NOT NULL,           -- source | dir
  refused TEXT,                   -- why the file was not read (nothing else is set then)
  size INTEGER,
  sha256 TEXT,
  lines INTEGER NOT NULL,
  records INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  malformed INTEGER NOT NULL,
  too_large INTEGER NOT NULL,
  too_deep INTEGER NOT NULL,
  scrub_rejected INTEGER NOT NULL,
  findings INTEGER NOT NULL
) STRICT;
CREATE TABLE evidence (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  occurred TEXT NOT NULL,         -- toISOString() form, so text order is time order
  summary TEXT NOT NULL,          -- scrubbed
  attributes TEXT NOT NULL,       -- scrubbed canonical JSON object
  file_ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) STRICT;
CREATE INDEX evidence_time ON evidence (kind, occurred, id);
`;

function database(): typeof BetterSqlite3 {
  const loaded = loadSqlite();
  if (!loaded.ok) throw new EvidenceError(`better-sqlite3 failed to load: ${loaded.error}; ${NATIVE_BUILD_HINT}`);
  return loaded.Database;
}

export function evidenceDbPath(stateDir: SafePath): SafePath {
  return resolveInState(stateDir, EVIDENCE_DB_FILE);
}

function current(db: Db): boolean {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() === undefined) return false;
  return getMeta(db, 'schema_version') === String(EVIDENCE_SCHEMA_VERSION);
}

function getMeta(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Open (creating 0600 if needed) the derived evidence index. Rollback-journal mode, like refs.db: only the owner CLI uses it. */
function openEvidenceDb(stateDir: SafePath): Db {
  const Database = database();
  const file = evidenceDbPath(stateDir);
  if (statSafe(file) === undefined) {
    try {
      createExclusive(file, '');
    } catch (err) {
      if (!(err instanceof SafePathError && err.code === 'exists')) throw err;
    }
  }
  let db: Db;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (err) {
    throw new EvidenceError(`cannot open ${file}: ${err instanceof Error ? err.message : String(err)}; ` +
      'it is derived data: delete it and run `ebrain evidence reindex`');
  }
  try {
    if (!current(db)) {
      db.transaction(() => {
        if (current(db)) return;
        for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
        db.exec(SCHEMA);
        setMeta(db, 'schema_version', String(EVIDENCE_SCHEMA_VERSION));
      }).immediate();
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// ---- discovery ----

export interface DiscoveredFile {
  path: string;
  origin: 'source' | 'dir';
  /** The only root this file may resolve inside. */
  root: string;
  /** Set when the file is not read. */
  refused?: string;
  /** Stat key (size, mtime, ctime, inode) when the file can be opened. */
  key?: string;
}

function refusal(err: unknown): string {
  if (err instanceof SafePathError) {
    if (err.errno === 'ENOENT') return 'missing';
    return err.code === 'escape' ? 'outside its evidence path' : err.code === 'symlink' ? 'symlink' : err.code === 'not-file' ? 'not a regular file' : err.message;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' ? 'missing' : `unreadable (${code ?? 'error'})`;
}

function maxBytes(config: Config): number {
  return Math.floor(config.evidence.maxFileMB * 1024 * 1024);
}

/** Open one discovered file inside its root, or say why not. The caller closes it. */
function openInRoot(f: Pick<DiscoveredFile, 'path' | 'root'>, limit: number): { file: ExternalFile } | { refused: string } {
  let file: ExternalFile;
  try {
    file = openExternalFile(f.path, [f.root]);
  } catch (err) {
    return { refused: refusal(err) };
  }
  if (file.stat.size > limit) {
    file.close();
    return { refused: 'larger than evidence.maxFileMB' };
  }
  return { file };
}

function statKey(s: ExternalFile['stat']): string {
  return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`;
}

/** The evidence directory's realpath, or undefined when it does not exist (nothing to load). */
function evidenceDirReal(config: Config): SafePath | undefined {
  try {
    return assertInside(config.evidence.dir, config.evidence.dir);
  } catch (err) {
    if (err instanceof SafePathError && err.errno === 'ENOENT') return undefined;
    throw new EvidenceError(`evidence.dir ${config.evidence.dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every evidence file, in load order. Opens files only to stat them; reads nothing. */
export function discoverEvidence(config: Config): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  const limit = maxBytes(config);
  const probe = (f: DiscoveredFile) => {
    if (f.refused === undefined) {
      const opened = openInRoot(f, limit);
      if ('refused' in opened) f.refused = opened.refused;
      else {
        f.key = statKey(opened.file.stat);
        opened.file.close();
      }
    }
    out.push(f);
  };
  for (const src of config.evidence.sources) probe({ path: src, origin: 'source', root: path.dirname(src) });
  const dir = evidenceDirReal(config);
  if (dir !== undefined) {
    const entries = readDirSafe(dir).filter((d) => d.name.endsWith('.jsonl') && !d.name.startsWith('.'));
    // Bytewise name order: deterministic across platforms and locales.
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const d of entries) {
      const f: DiscoveredFile = { path: path.join(dir, d.name), origin: 'dir', root: dir };
      // Symlinks in the evidence directory are never followed, even to a file inside it.
      if (d.isSymbolicLink()) f.refused = 'symlink';
      probe(f);
    }
  }
  return out;
}

function scrubOptions(config: Config): ScrubOptions {
  return { principal: { type: config.principal.type }, extraPatterns: config.scrub.extraPatterns };
}

function limitsOf(config: Config): RecordLimits {
  return { maxRecordBytes: config.evidence.maxRecordBytes, scrub: scrubOptions(config) };
}

/** Everything the index depends on: when this changes, the index is rebuilt. */
function fingerprint(config: Config, files: readonly DiscoveredFile[]): string {
  return createHash('sha256').update(JSON.stringify({
    files: files.map((f) => [f.path, f.origin, f.refused ?? null, f.key ?? null]),
    maxFileMB: config.evidence.maxFileMB,
    maxRecordBytes: config.evidence.maxRecordBytes,
    principalType: config.principal.type,
    extraPatterns: config.scrub.extraPatterns,
    scrubVersion,
  })).digest('hex');
}

// ---- indexing ----

export interface FileStats {
  path: string;
  origin: 'source' | 'dir';
  refused: string | null;
  size: number | null;
  sha256: string | null;
  lines: number;
  records: number;
  duplicates: number;
  skipped: LineCounts['skipped'];
  findings: number;
}

export interface RefreshResult {
  rebuilt: boolean;
  files: number;
  records: number;
}

function rebuild(db: Db, config: Config, files: readonly DiscoveredFile[], fp: string): number {
  const limits = limitsOf(config);
  const limit = maxBytes(config);
  const insFile = db.prepare(`INSERT INTO evidence_files (ord, path, origin, refused, size, sha256, lines, records, duplicates,
    malformed, too_large, too_deep, scrub_rejected, findings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const find = db.prepare('SELECT file_ord FROM evidence WHERE kind = ? AND id = ?');
  const upsert = db.prepare(`INSERT INTO evidence (kind, id, occurred, summary, attributes, file_ord, line) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (kind, id) DO UPDATE SET occurred = excluded.occurred, summary = excluded.summary, attributes = excluded.attributes,
    file_ord = excluded.file_ord, line = excluded.line`);
  const bumpDup = db.prepare('UPDATE evidence_files SET duplicates = duplicates + 1 WHERE ord = ?');
  let total = 0;
  db.transaction(() => {
    db.exec('DELETE FROM evidence; DELETE FROM evidence_files;');
    files.forEach((f, ord) => {
      let refused = f.refused;
      let counts = emptyCounts();
      let size: number | null = null;
      let sha: string | null = null;
      let duplicates = 0;
      const pending: (() => void)[] = [];
      if (refused === undefined) {
        const opened = openInRoot(f, limit);
        if ('refused' in opened) refused = opened.refused;
        else {
          try {
            const data = opened.file.readBuffer();
            // The fd was size-checked at open; re-check what was actually read (the file may have grown).
            if (data.length > limit) refused = 'larger than evidence.maxFileMB';
            else {
              size = data.length;
              sha = createHash('sha256').update(data).digest('hex');
              counts = parseEvidenceBuffer(data, limits, ({ record, line }) => {
                pending.push(() => {
                  const prev = find.get(record.kind, record.id) as { file_ord: number } | undefined;
                  if (prev !== undefined) {
                    if (prev.file_ord === ord) duplicates++;
                    else bumpDup.run(prev.file_ord);
                  }
                  upsert.run(record.kind, record.id, record.occurred, record.summary, JSON.stringify(record.attributes), ord, line);
                });
              });
            }
          } finally {
            opened.file.close();
          }
        }
      }
      if (refused !== undefined) counts = emptyCounts();
      insFile.run(ord, f.path, f.origin, refused ?? null, size, sha, counts.lines, counts.records, 0,
        counts.skipped.malformed, counts.skipped.too_large, counts.skipped.too_deep, counts.skipped.scrub_rejected, counts.findings);
      if (refused === undefined) for (const p of pending) p();
      if (duplicates > 0) db.prepare('UPDATE evidence_files SET duplicates = duplicates + ? WHERE ord = ?').run(duplicates, ord);
    });
    setMeta(db, 'fingerprint', fp);
    total = (db.prepare('SELECT count(*) AS n FROM evidence').get() as { n: number }).n;
  }).immediate();
  return total;
}

/** Bring evidence.db up to date with the source files (rebuilding if anything changed, or always with `force`). */
export function refreshEvidence(env: EvidenceEnv, opts: { force?: boolean } = {}): RefreshResult {
  return withLock(env.stateDir, EVIDENCE_LOCK, () => {
    const files = discoverEvidence(env.config);
    const fp = fingerprint(env.config, files);
    const db = openEvidenceDb(env.stateDir);
    try {
      if (!opts.force && getMeta(db, 'fingerprint') === fp) {
        return { rebuilt: false, files: files.length, records: (db.prepare('SELECT count(*) AS n FROM evidence').get() as { n: number }).n };
      }
      return { rebuilt: true, files: files.length, records: rebuild(db, env.config, files, fp) };
    } finally {
      db.close();
    }
  });
}

// ---- reading ----

interface EvidenceRow {
  kind: string;
  id: string;
  occurred: string;
  summary: string;
  attributes: string;
}

const toRecord = (r: EvidenceRow): EvidenceRecord => ({ kind: r.kind, id: r.id, occurred: r.occurred, summary: r.summary, attributes: JSON.parse(r.attributes) });

/** An `EvidenceSource` over evidence.db. `close()` when done. */
export interface OpenEvidence extends EvidenceSource {
  close(): void;
}

function sourceOver(db: Db): OpenEvidence {
  const byKey = db.prepare('SELECT kind, id, occurred, summary, attributes FROM evidence WHERE kind = ? AND id = ?');
  const kinds = db.prepare('SELECT DISTINCT kind FROM evidence ORDER BY kind');
  const listAll = db.prepare('SELECT kind, id, occurred, summary, attributes FROM evidence WHERE kind = ? ORDER BY occurred, id');
  const listSince = db.prepare('SELECT kind, id, occurred, summary, attributes FROM evidence WHERE kind = ? AND occurred >= ? ORDER BY occurred, id');
  return {
    kinds: () => (kinds.all() as { kind: string }[]).map((r) => r.kind),
    resolve: (kind, id): EvidenceResolution => {
      const r = byKey.get(kind, id) as EvidenceRow | undefined;
      if (r === undefined) return { found: false };
      const rec = toRecord(r);
      return { found: true, summary: rec.summary, occurred: rec.occurred, attributes: rec.attributes };
    },
    list: (kind, since) => {
      const key = sinceKey(since);
      return ((key === undefined ? listAll.all(kind) : listSince.all(kind, key)) as EvidenceRow[]).map(toRecord);
    },
    close: () => db.close(),
  };
}

/** Refresh the index, then open it as an evidence source (owner CLI: jobs and review). */
export function openEvidence(env: EvidenceEnv): OpenEvidence {
  refreshEvidence(env);
  const db = openEvidenceDb(env.stateDir);
  return sourceOver(db);
}

/** An evidence source that refreshes and opens evidence.db on first use only. */
export function lazyEvidence(env: EvidenceEnv): OpenEvidence {
  let open: OpenEvidence | undefined;
  const get = () => (open ??= openEvidence(env));
  return {
    kinds: () => get().kinds(),
    resolve: (kind, id) => get().resolve(kind, id),
    list: (kind, since) => get().list(kind, since),
    close: () => open?.close(),
  };
}

// ---- stats ----

export interface EvidenceStats {
  files: FileStats[];
  records: number;
  byKind: { kind: string; count: number }[];
  rebuilt: boolean;
}

export function evidenceStats(env: EvidenceEnv): EvidenceStats {
  const r = refreshEvidence(env);
  const db = openEvidenceDb(env.stateDir);
  try {
    const files = (db.prepare('SELECT * FROM evidence_files ORDER BY ord').all() as Record<string, unknown>[]).map((row): FileStats => ({
      path: row['path'] as string,
      origin: row['origin'] as 'source' | 'dir',
      refused: row['refused'] as string | null,
      size: row['size'] as number | null,
      sha256: row['sha256'] as string | null,
      lines: row['lines'] as number,
      records: row['records'] as number,
      duplicates: row['duplicates'] as number,
      skipped: Object.fromEntries(SKIP_REASONS.map((k) => [k, row[k] as number])) as LineCounts['skipped'],
      findings: row['findings'] as number,
    }));
    const byKind = db.prepare('SELECT kind, count(*) AS count FROM evidence GROUP BY kind ORDER BY kind').all() as { kind: string; count: number }[];
    return { files, records: byKind.reduce((n, k) => n + k.count, 0), byKind, rebuilt: r.rebuilt };
  } finally {
    db.close();
  }
}

// ---- import ----

export interface ImportResult {
  path: string;
  records: number;
  lines: number;
  skipped: LineCounts['skipped'];
  findings: number;
  replaced: boolean;
}

/**
 * Validate an export and write it into `evidence.dir` atomically (temp file,
 * fsync, rename; an existing file of the same name is replaced). Only the
 * validated, scrubbed records are written, one canonical JSON object per
 * line, so the evidence directory never holds a bad line or a secret. Refused
 * (nothing written) when the file has no valid record.
 */
export function importEvidence(env: EvidenceEnv, file: string, opts: { name?: string; cwd?: string } = {}): ImportResult {
  const abs = path.resolve(opts.cwd ?? process.cwd(), file);
  const name = opts.name ?? path.basename(abs);
  if (!EVIDENCE_FILE_NAME_RE.test(name)) {
    throw new EvidenceError(`evidence file name ${JSON.stringify(name)} must match ${EVIDENCE_FILE_NAME_RE.source} (use --name)`);
  }
  const limit = maxBytes(env.config);
  const opened = openInRoot({ path: abs, root: path.dirname(abs) }, limit);
  if ('refused' in opened) throw new EvidenceError(`cannot import ${abs}: ${opened.refused}`);
  let data: Buffer;
  try {
    data = opened.file.readBuffer();
  } finally {
    opened.file.close();
  }
  if (data.length > limit) throw new EvidenceError(`cannot import ${abs}: larger than evidence.maxFileMB`);
  const lines: string[] = [];
  const counts = parseEvidenceBuffer(data, limitsOf(env.config), ({ canonical }) => lines.push(canonical));
  if (counts.records === 0) throw new EvidenceError(`cannot import ${abs}: no valid evidence records (${counts.lines} lines checked); nothing was written`);
  return withLock(env.stateDir, EVIDENCE_LOCK, () => {
    const dir = ensurePrivateDir(env.config.evidence.dir);
    const dest = resolveInRoot(dir, name);
    const replaced = statSafe(dest) !== undefined;
    writeAtomic(dest, `${lines.join('\n')}\n`);
    return { path: dest, records: counts.records, lines: counts.lines, skipped: counts.skipped, findings: counts.findings, replaced };
  });
}
