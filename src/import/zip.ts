// Safe zip reading for the conversation importers (Phase 10; Phase 11 reuses
// it for EPUB). Nothing is extracted to disk: the archive is read through an
// `ExternalFile` handle from `openExternalFile` (positional reads on the
// already-validated descriptor; yauzl never opens a path itself) and only the
// entries the caller asks for are inflated, into memory, under byte caps.
//
// Defenses (I1):
//  - entry count: the central directory's count is checked before any entry
//    is read;
//  - entry names: every name in the archive is validated (yauzl with
//    `strictFileNames`, plus our own rule set: no absolute paths, drive
//    letters, backslashes, NUL or control characters, `.`/`..` segments, or
//    empty segments). One bad name rejects the whole archive (zip-slip,
//    path traversal), even if it is an entry we would not read;
//  - sizes (zip bombs): each entry's declared uncompressed size and the sum
//    over all entries are capped; inflated bytes are counted while streaming
//    and the read aborts past the cap; yauzl's `validateEntrySizes` rejects
//    an entry whose real size differs from the declared one.

import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { ExternalFile } from '../safe-path.js';

export interface ZipLimits {
  /** Entries in the central directory. */
  maxEntries: number;
  /** Declared and inflated bytes of any one entry. */
  maxEntryBytes: number;
  /** Declared uncompressed bytes summed over every entry. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = {
  maxEntries: 50_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
};

export type ZipRejectCode = 'entry-count' | 'entry-name' | 'entry-size' | 'total-size' | 'encrypted' | 'malformed';

export class ZipRejectedError extends Error {
  readonly code: ZipRejectCode;
  constructor(code: ZipRejectCode, message: string) {
    super(message);
    this.name = 'ZipRejectedError';
    this.code = code;
  }
}

/** Why an entry name is refused, or undefined when it is an ordinary relative path. */
export function entryNameProblem(name: string): string | undefined {
  if (name === '') return 'empty name';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control character in name';
  if (name.includes('\\')) return 'backslash in name';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute path';
  const segments = name.replace(/\/$/, '').split('/');
  if (segments.some((s) => s === '..')) return 'parent-directory segment';
  if (segments.some((s) => s === '.' || s === '')) return 'empty or dot segment';
  return undefined;
}

const READ_CHUNK = 64 * 1024;

/** yauzl reader over positional reads of an open, validated file. */
class ExternalFileReader extends yauzl.RandomAccessReader {
  constructor(private readonly file: ExternalFile) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const file = this.file;
    function* chunks(): Generator<Buffer> {
      for (let pos = start; pos < end; pos += READ_CHUNK) {
        const want = Math.min(READ_CHUNK, end - pos);
        const buf = file.readAt(pos, want);
        if (buf.length !== want) throw new Error('unexpected end of archive');
        yield buf;
      }
    }
    return Readable.from(chunks(), { objectMode: false });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Inflate one entry into memory, aborting once more than `cap` bytes arrive. */
async function inflate(zip: yauzl.ZipFile, entry: yauzl.Entry, cap: number): Promise<Buffer> {
  let stream: Readable;
  try {
    stream = await zip.openReadStreamPromise(entry);
  } catch (err) {
    throw new ZipRejectedError('malformed', `${entry.fileName}: ${message(err)}`);
  }
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > cap) {
        stream.destroy();
        throw new ZipRejectedError('entry-size', `${entry.fileName}: inflates past ${cap} bytes`);
      }
      parts.push(buf);
    }
  } catch (err) {
    if (err instanceof ZipRejectedError) throw err;
    // validateEntrySizes: the real size differs from the declared one (a lying header).
    const m = message(err);
    throw new ZipRejectedError(/too (?:many|few) bytes/.test(m) ? 'entry-size' : 'malformed', `${entry.fileName}: ${m}`);
  }
  return Buffer.concat(parts, total);
}

/**
 * Validate the whole archive, then inflate the entries `want` selects
 * (file entries only), keyed by entry name. Throws `ZipRejectedError` on any
 * violation; nothing is returned for a rejected archive.
 */
export async function readZipEntries(
  file: ExternalFile,
  want: (name: string) => boolean,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<Map<string, Buffer>> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromRandomAccessReaderPromise(new ExternalFileReader(file), file.stat.size, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (err) {
    throw new ZipRejectedError('malformed', `not a readable zip archive: ${message(err)}`);
  }
  try {
    if (zip.entryCount > limits.maxEntries) {
      throw new ZipRejectedError('entry-count', `archive has ${zip.entryCount} entries (limit ${limits.maxEntries})`);
    }
    const selected: yauzl.Entry[] = [];
    const names = new Set<string>();
    let declared = 0;
    let seen = 0;
    try {
      for await (const entry of zip.eachEntry()) {
        seen++;
        if (seen > limits.maxEntries) throw new ZipRejectedError('entry-count', `archive has more than ${limits.maxEntries} entries`);
        const problem = entryNameProblem(entry.fileName);
        if (problem !== undefined) throw new ZipRejectedError('entry-name', `refused entry name ${JSON.stringify(entry.fileName)}: ${problem}`);
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          throw new ZipRejectedError('entry-size', `${entry.fileName}: ${entry.uncompressedSize} bytes uncompressed (limit ${limits.maxEntryBytes})`);
        }
        declared += entry.uncompressedSize;
        if (declared > limits.maxTotalBytes) {
          throw new ZipRejectedError('total-size', `archive inflates past ${limits.maxTotalBytes} bytes in total`);
        }
        if (entry.fileName.endsWith('/') || !want(entry.fileName)) continue;
        if (names.has(entry.fileName)) throw new ZipRejectedError('entry-name', `duplicate entry ${JSON.stringify(entry.fileName)}`);
        if (entry.isEncrypted()) throw new ZipRejectedError('encrypted', `${entry.fileName} is encrypted`);
        names.add(entry.fileName);
        selected.push(entry);
      }
    } catch (err) {
      if (err instanceof ZipRejectedError) throw err;
      // yauzl's own name and structure checks (absolute paths, `..`, backslashes, bad headers).
      const m = message(err);
      throw new ZipRejectedError(/fileName|path/i.test(m) ? 'entry-name' : 'malformed', m);
    }
    const out = new Map<string, Buffer>();
    for (const entry of selected) out.set(entry.fileName, await inflate(zip, entry, limits.maxEntryBytes));
    return out;
  } finally {
    zip.close();
  }
}
