// The reference library (Phase 11): `ebrain refs add|list|remove|reindex`.
// Owner CLI only; MCP reads refs.db through `search` (scope refs/all) and
// `read_ref_chunk` and never writes it.
//
// - Source files are read through `openExternalFile`, with the file's own
//   directory as the named root (I1), and are never written.
// - `ref_id` is `ref_` + the first 32 hex characters of the source file's
//   SHA-256, so the same file always gets the same id and re-adding it is a
//   no-op.
// - Book text (title, author, headings, every paragraph) passes through the
//   scrubber with non-strict redaction before it is stored (I5); an
//   owner-run add is not exempt. It is stored only in `<stateDir>/refs.db`.
// - The vault gets one small owner note per book, `references/<slug>.md`
//   (title, author, source path and hash, a place for the owner's notes),
//   created once with `createExclusive` and never overwritten. It carries no
//   book text, and it lets `refs reindex` rebuild a deleted refs.db.

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import type { PrincipalType } from '../config.js';
import { pdfToText, type PdfOptions } from '../exec/pdftotext.js';
import { DEFAULT_ZIP_LIMITS, type ZipLimits } from '../import/zip.js';
import { cleanTitle, isoSeconds, toSlug } from '../inbox/note.js';
import { realVaultDir } from '../journal/store.js';
import { withLock } from '../lock.js';
import { ulid } from '../mcp/ulid.js';
import {
  createExclusive, openExternalFile, readDirSafe, readFileSafe, resolveInVault, SafePathError, statSafe, vaultChild,
  type ExternalFile, type SafePath,
} from '../safe-path.js';
import { DETECTOR_TYPES, scrubForWrite, scrubVersion, type DetectorType, type ScrubFinding } from '../scrub/index.js';
import { decodeNote, revOf, splitFrontmatter } from '../vault/parse.js';
import { chunkChapter } from './chunk.js';
import {
  allRefs, deleteRef, isRemoved, openRefsDb, REF_ID_RE, refRow, replaceRef, type RefContent, type RefRow, type RefsDb,
} from './db.js';
import {
  BookError, extractEpub, extractMarkdown, extractPdfText, extractTxt, formatOf, type Book, type RefFormat,
} from './extract.js';
import type { TextBlock } from './xml.js';

/** Vault folder of the owner's reference notes. */
export const REFERENCES_DIR = 'references';
/** Largest source file read. */
export const MAX_REF_SOURCE_BYTES = 512 * 1024 * 1024;
const LOCK = 'refs';

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

export interface LibraryOptions {
  vaultPath: string;
  stateDir: SafePath;
  principal: { id: string; type: PrincipalType };
  extraPatterns?: readonly string[];
  now?: Date;
  zipLimits?: ZipLimits;
  pdf?: PdfOptions;
  maxSourceBytes?: number;
}

/** The stable reference id of a source file's SHA-256 (hex). */
export function refIdOf(sha256Hex: string): string {
  return `ref_${sha256Hex.slice(0, 32)}`;
}

// ---- reading sources ----

interface Source {
  file: ExternalFile;
  sha256: string;
  size: number;
  data: Buffer;
}

function openSource(absPath: string, maxBytes: number): Source {
  const file = openExternalFile(absPath, [path.dirname(absPath)]);
  try {
    if (file.stat.size > maxBytes) throw new RefError(`source file is larger than ${maxBytes} bytes`);
    const data = file.readBuffer();
    return { file, data, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  } catch (err) {
    file.close();
    throw err;
  }
}

async function loadBook(src: Source, format: RefFormat, opts: LibraryOptions): Promise<Book> {
  switch (format) {
    case 'epub':
      return extractEpub(src.file, opts.zipLimits ?? DEFAULT_ZIP_LIMITS);
    case 'md':
      return extractMarkdown(src.data, path.basename(src.file.path));
    case 'txt':
      return extractTxt(src.data, path.basename(src.file.path));
    case 'pdf': {
      const r = pdfToText(src.file.path, opts.pdf);
      if (!r.ok) throw new BookError(r.message);
      const d = decodeNote(r.text);
      if (d.invalidUtf8) throw new BookError('pdftotext output is not valid UTF-8');
      return extractPdfText(d.text);
    }
  }
}

// ---- scrubbing and chunking ----

class Scrubber {
  private readonly counts = new Map<DetectorType, number>();
  constructor(private readonly extraPatterns: readonly string[]) {}

  /** Non-strict redaction (I5): no principal is passed, so credentials are redacted, never rejected. */
  text(s: string): string {
    const r = scrubForWrite(s, { extraPatterns: this.extraPatterns });
    for (const f of r.findings) this.counts.set(f.type, (this.counts.get(f.type) ?? 0) + f.count);
    return r.text;
  }

  optional(s: string | undefined): string | undefined {
    return s === undefined ? undefined : this.text(s);
  }

  findings(): ScrubFinding[] {
    return DETECTOR_TYPES.filter((t) => this.counts.has(t)).map((type) => ({ type, count: this.counts.get(type)! }));
  }
}

function prepareChapters(book: Book, scrubber: Scrubber): RefContent['chapters'] {
  const out: RefContent['chapters'] = [];
  for (const ch of book.chapters) {
    const heading = scrubber.optional(ch.heading);
    const blocks: TextBlock[] = ch.blocks.map((b) => ({ ...b, text: scrubber.text(b.text) }));
    const chunks = chunkChapter(blocks, heading).map((c) => {
      const out: { ordinal: number; heading?: string; text: string; chunkRev: string } = { ordinal: c.ordinal, text: c.text, chunkRev: revOf(c.text) };
      if (c.heading !== undefined) out.heading = c.heading;
      return out;
    });
    if (chunks.length === 0) continue;
    const chapter: RefContent['chapters'][number] = { chapter: out.length + 1, chunks };
    if (heading !== undefined) chapter.heading = heading;
    out.push(chapter);
  }
  return out;
}

// ---- the owner's vault note ----

interface NoteMeta {
  refId: string;
  title?: string;
  author?: string;
  sourcePath?: string;
  sourceSha256?: string;
  relPath: string;
}

function readNoteMeta(p: SafePath, relPath: string): NoteMeta | undefined {
  let fm: unknown;
  try {
    const { yaml } = splitFrontmatter(decodeNote(readFileSafe(p)).text);
    if (yaml === null) return undefined;
    fm = parseYaml(yaml, { schema: 'core', maxAliasCount: 0 });
  } catch {
    return undefined;
  }
  if (typeof fm !== 'object' || fm === null) return undefined;
  const f = fm as Record<string, unknown>;
  const str = (k: string) => (typeof f[k] === 'string' && f[k] !== '' ? (f[k] as string) : undefined);
  const refId = str('ref_id');
  if (refId === undefined || !REF_ID_RE.test(refId)) return undefined;
  const meta: NoteMeta = { refId, relPath };
  const title = str('title');
  const author = str('book_author');
  const sourcePath = str('source_path');
  const sha = str('source_sha256');
  if (title !== undefined) meta.title = title;
  if (author !== undefined) meta.author = author;
  if (sourcePath !== undefined && path.isAbsolute(sourcePath)) meta.sourcePath = sourcePath;
  if (sha !== undefined && /^[0-9a-f]{64}$/.test(sha)) meta.sourceSha256 = sha;
  return meta;
}

/** Reference notes directly under `references/` (symlinks, dot-files, and unreadable notes skipped). */
function referenceNotes(vaultPath: string): NoteMeta[] {
  const dir = realVaultDir(vaultPath, REFERENCES_DIR, false);
  if (dir === undefined) return [];
  const out: NoteMeta[] = [];
  for (const e of readDirSafe(dir)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    let p: SafePath;
    try {
      p = vaultChild(dir, e.name);
    } catch {
      continue;
    }
    const meta = readNoteMeta(p, `${REFERENCES_DIR}/${e.name}`);
    if (meta !== undefined) out.push(meta);
  }
  return out;
}

interface NoteFields {
  refId: string;
  title: string;
  author?: string;
  sourcePath: string;
  sourceSha256: string;
  format: RefFormat;
}

function renderNote(f: NoteFields, opts: LibraryOptions, now: Date): string {
  const fm: Record<string, unknown> = {
    schema: 1,
    id: ulid(now.getTime()),
    title: f.title,
    kind: 'reference',
    created: isoSeconds(now),
    origin: 'cli',
    author: opts.principal.id,
    ref_id: f.refId,
  };
  if (f.author !== undefined) fm['book_author'] = f.author;
  Object.assign(fm, { source_path: f.sourcePath, source_sha256: f.sourceSha256, format: f.format, scrubVersion });
  const lines = [
    `# ${f.title}`,
    '',
    'A reference book in the e3d-brain library. Its text is kept in the derived reference database (refs.db), not in this vault:',
    'search it with `search` (scope "refs") and cite passages as `ref:<ref_id>/<chapter>/<ordinal>`.',
    '',
    ...(f.author === undefined ? [] : [`- Author: ${f.author}`]),
    `- Source: ${f.sourcePath}`,
    `- Reference id: ${f.refId}`,
    '',
    '## My notes',
    '',
  ];
  return `---\n${stringify(fm, { lineWidth: 0 })}---\n${lines.join('\n')}`;
}

/**
 * Find or create the book's note: `references/<slug>.md`, or
 * `<slug>-<id8>.md` when another book's note holds the name. An existing note
 * for this ref is kept as it is (never overwritten). Returns the vault path
 * and whether it was created.
 */
function ensureNote(f: NoteFields, opts: LibraryOptions, now: Date): { relPath: string; created: boolean } {
  realVaultDir(opts.vaultPath, REFERENCES_DIR);
  const base = toSlug(f.title);
  const names = [base, `${base}-${f.refId.slice(4, 12)}`, `${base}-${f.refId.slice(4, 36)}`];
  for (const name of names) {
    const relPath = `${REFERENCES_DIR}/${name}.md`;
    const p = resolveInVault(opts.vaultPath, relPath);
    const st = statSafe(p);
    if (st !== undefined) {
      if (st.isFile() && readNoteMeta(p, relPath)?.refId === f.refId) return { relPath, created: false };
      continue;
    }
    try {
      createExclusive(p, renderNote(f, opts, now));
      return { relPath, created: true };
    } catch (err) {
      if (err instanceof SafePathError && err.code === 'exists') continue;
      throw err;
    }
  }
  throw new RefError(`no free name for the reference note under ${REFERENCES_DIR}/`);
}

// ---- commands ----

export interface AddOptions extends LibraryOptions {
  title?: string;
  author?: string;
}

export interface AddResult {
  action: 'added' | 'unchanged';
  refId: string;
  title: string;
  author?: string;
  chapters: number;
  chunks: number;
  notePath?: string;
  noteCreated: boolean;
  findings: ScrubFinding[];
}

function withRefsDb<T>(opts: LibraryOptions, fn: (db: RefsDb) => T): T {
  return withLock(opts.stateDir, LOCK, () => {
    const db = openRefsDb(opts.stateDir);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  });
}

async function build(src: Source, format: RefFormat, meta: { title?: string; author?: string; fallbackTitle: string }, opts: LibraryOptions) {
  const book = await loadBook(src, format, opts);
  const scrubber = new Scrubber(opts.extraPatterns ?? []);
  const chapters = prepareChapters(book, scrubber);
  if (chapters.length === 0) throw new BookError('no text found in the book');
  const title = cleanTitle(scrubber.text(meta.title ?? book.title ?? meta.fallbackTitle)) || cleanTitle(meta.fallbackTitle) || 'Untitled';
  const authorRaw = meta.author ?? book.author;
  const author = authorRaw === undefined ? undefined : cleanTitle(scrubber.text(authorRaw)) || undefined;
  return { chapters, title, author, findings: scrubber.findings() };
}

/** `ebrain refs add <file>`. */
export async function addRef(file: string, opts: AddOptions): Promise<AddResult> {
  const abs = path.resolve(file);
  const format = formatOf(abs);
  if (format === undefined) throw new RefError('unsupported file type (expected .epub, .md, .txt, or .pdf)');
  const src = openSource(abs, opts.maxSourceBytes ?? MAX_REF_SOURCE_BYTES);
  try {
    const refId = refIdOf(src.sha256);
    const existing = withRefsDb(opts, (db) => refRow(db, refId));
    if (existing !== undefined) {
      const r: AddResult = { action: 'unchanged', refId, title: existing.title, chapters: existing.chapters, chunks: existing.chunks, noteCreated: false, findings: [] };
      if (existing.author !== null) r.author = existing.author;
      if (existing.note_path !== null) r.notePath = existing.note_path;
      return r;
    }
    // Extraction (and pdftotext) runs before the lock is taken; writes happen under it.
    const meta: { title?: string; author?: string; fallbackTitle: string } = { fallbackTitle: path.basename(abs, path.extname(abs)) };
    if (opts.title !== undefined) meta.title = opts.title;
    if (opts.author !== undefined) meta.author = opts.author;
    const built = await build(src, format, meta, opts);
    const now = opts.now ?? new Date();
    return withRefsDb(opts, (db) => {
      const again = refRow(db, refId);
      if (again !== undefined) {
        return { action: 'unchanged', refId, title: again.title, chapters: again.chapters, chunks: again.chunks, noteCreated: false, findings: [] };
      }
      const noteFields: NoteFields = { refId, title: built.title, sourcePath: src.file.path, sourceSha256: src.sha256, format };
      if (built.author !== undefined) noteFields.author = built.author;
      // The note first: a crash after it leaves a note that `refs reindex` can rebuild from.
      const note = ensureNote(noteFields, opts, now);
      const counts = replaceRef(db, {
        ref: {
          ref_id: refId, title: built.title, author: built.author ?? null, format, source_path: src.file.path,
          source_sha256: src.sha256, source_size: src.size, note_path: note.relPath, added: isoSeconds(now),
          scrub_version: scrubVersion, findings: JSON.stringify(built.findings),
        },
        chapters: built.chapters,
      });
      const r: AddResult = {
        action: 'added', refId, title: built.title, ...counts, notePath: note.relPath, noteCreated: note.created, findings: built.findings,
      };
      if (built.author !== undefined) r.author = built.author;
      return r;
    });
  } finally {
    src.file.close();
  }
}

/** `ebrain refs list`. */
export function listRefs(opts: LibraryOptions): RefRow[] {
  return withRefsDb(opts, (db) => allRefs(db));
}

/** `ebrain refs remove <ref_id>`: index rows only; the owner's vault note stays. */
export function removeRef(refId: string, opts: LibraryOptions): RefRow {
  if (!REF_ID_RE.test(refId)) throw new RefError('not a reference id (expected ref_ followed by 32 hex characters)');
  return withRefsDb(opts, (db) => {
    const row = refRow(db, refId);
    if (row === undefined) throw new RefError(`no reference ${refId} in the library`);
    deleteRef(db, refId, isoSeconds(opts.now ?? new Date()));
    return row;
  });
}

export interface ReindexResult {
  rebuilt: { refId: string; title: string; chapters: number; chunks: number }[];
  /** Source file no longer at its recorded path (moved or deleted). */
  missing: { refId: string; sourcePath: string }[];
  /** Source file present but with different content (a different book version). */
  changed: { refId: string; sourcePath: string }[];
  failed: { refId: string; reason: string }[];
  /** Vault notes of refs removed with `refs remove` (not brought back). */
  removed: number;
}

interface Candidate {
  refId: string;
  row?: RefRow;
  note?: NoteMeta;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `ebrain refs reindex`: rebuild refs.db from the original source files. The
 * sources are those recorded in refs.db plus those named by the owner's
 * reference notes (so a deleted refs.db is restored), less refs removed with
 * `refs remove`. A source that moved is reported missing and a source whose
 * hash changed is reported changed; either way that ref's rows are kept.
 */
export async function reindexRefs(opts: LibraryOptions): Promise<ReindexResult> {
  const result: ReindexResult = { rebuilt: [], missing: [], changed: [], failed: [], removed: 0 };
  const candidates = new Map<string, Candidate>();
  withRefsDb(opts, (db) => {
    for (const row of allRefs(db)) candidates.set(row.ref_id, { refId: row.ref_id, row });
    for (const note of referenceNotes(opts.vaultPath)) {
      const c = candidates.get(note.refId);
      if (c !== undefined) c.note ??= note;
      else if (isRemoved(db, note.refId)) result.removed++;
      else candidates.set(note.refId, { refId: note.refId, note });
    }
  });
  const ordered = [...candidates.values()].sort((a, b) => (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));
  for (const c of ordered) {
    const sourcePath = c.row?.source_path ?? c.note?.sourcePath;
    const expected = c.row?.source_sha256 ?? c.note?.sourceSha256;
    if (sourcePath === undefined || expected === undefined || refIdOf(expected) !== c.refId) {
      result.failed.push({ refId: c.refId, reason: 'no usable source path and hash recorded' });
      continue;
    }
    const format = formatOf(sourcePath);
    if (format === undefined) {
      result.failed.push({ refId: c.refId, reason: 'unsupported source file type' });
      continue;
    }
    let src: Source;
    try {
      src = openSource(sourcePath, opts.maxSourceBytes ?? MAX_REF_SOURCE_BYTES);
    } catch (err) {
      const errno = err instanceof SafePathError ? err.errno ?? err.code : (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT' || errno === 'ENOTDIR' || errno === 'invalid' || errno === 'not-file') result.missing.push({ refId: c.refId, sourcePath });
      else result.failed.push({ refId: c.refId, reason: errMessage(err) });
      continue;
    }
    try {
      if (src.sha256 !== expected) {
        result.changed.push({ refId: c.refId, sourcePath });
        continue;
      }
      const meta: { title?: string; author?: string; fallbackTitle: string } = { fallbackTitle: path.basename(sourcePath, path.extname(sourcePath)) };
      const title = c.row?.title ?? c.note?.title;
      const author = c.row !== undefined ? (c.row.author ?? undefined) : c.note?.author;
      if (title !== undefined) meta.title = title;
      if (author !== undefined) meta.author = author;
      const built = await build(src, format, meta, opts);
      const now = opts.now ?? new Date();
      const counts = withRefsDb(opts, (db) =>
        replaceRef(db, {
          ref: {
            ref_id: c.refId, title: built.title, author: built.author ?? null, format, source_path: src.file.path,
            source_sha256: src.sha256, source_size: src.size, note_path: c.row?.note_path ?? c.note?.relPath ?? null,
            added: c.row?.added ?? isoSeconds(now), scrub_version: scrubVersion, findings: JSON.stringify(built.findings),
          },
          chapters: built.chapters,
        }),
      );
      result.rebuilt.push({ refId: c.refId, title: built.title, ...counts });
    } catch (err) {
      result.failed.push({ refId: c.refId, reason: errMessage(err) });
    } finally {
      src.file.close();
    }
  }
  return result;
}
