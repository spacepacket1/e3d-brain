// Journal entries (Phase 9): kinds, file names, body normalization for
// dedup, and the note text of a new entry. Pure: no I/O. The store
// (`./store.ts`) is the only code that turns these into files, and only
// under `journal/<principal-id>/`.

import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { PRINCIPAL_ID_RE } from '../config.js';
import { splitFrontmatter } from '../vault/parse.js';

/** Kinds `journal_append` accepts. */
export const JOURNAL_KINDS = ['log', 'observation', 'lesson', 'decision', 'todo'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
/** Kind of an entry that names none. */
export const DEFAULT_JOURNAL_KIND: JournalKind = 'log';

/** The journal root, relative to the vault. */
export const JOURNAL_DIR = 'journal';
/** Archive root for pruned entries: `journal/_archive/<principal-id>/<yyyy>/...`. */
export const JOURNAL_ARCHIVE_DIR = '_archive';
/** Workspace imports land in `journal/<principal-id>/imported/`. */
export const IMPORTED_DIR = 'imported';

/** `<yyyymmdd-hhmmss>-<slug>.md` (the slug is `[a-z0-9]+(-[a-z0-9]+)*`). */
export const ENTRY_NAME_RE = /^(\d{8})-(\d{6})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
export const YEAR_DIR_RE = /^\d{4}$/;

/** A principal id usable as one path segment (the config rule, re-checked by every writer). */
export function isPrincipalId(id: unknown): id is string {
  return typeof id === 'string' && PRINCIPAL_ID_RE.test(id);
}

/** UTC milliseconds of an entry file name's stamp, or undefined for any other name. */
export function entryNameMs(name: string): number | undefined {
  const m = ENTRY_NAME_RE.exec(name);
  if (m === null) return undefined;
  const [d, t] = [m[1]!, m[2]!];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  const ms = Date.parse(iso);
  // Reject names like 20261399-...: Date.parse would not round-trip them.
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== iso.slice(0, 19) ? undefined : ms;
}

/**
 * Body text as compared for dedup: NFC, LF line ends, trailing whitespace
 * dropped per line, runs of blank lines collapsed, trimmed.
 */
export function normalizeBody(body: string): string {
  return body
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** sha256 (hex) of the normalized body. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(normalizeBody(body), 'utf8').digest('hex');
}

/**
 * The body of an entry file as `renderEntry` wrote it: the text after the
 * frontmatter and the `# title` heading line.
 */
export function entryBody(text: string): string {
  const { body } = splitFrontmatter(text.replace(/\r\n?/g, '\n'));
  return body.replace(/^\n*# [^\n]*(?:\n|$)/, '');
}

export interface EntryFields {
  id: string;
  title: string;
  author: string;
  origin: 'mcp' | 'import' | 'cli' | 'hook';
  created: string;
  kind: string;
  sources: readonly string[];
  untrustedOrigin: boolean;
  /** Absent for entries that do not expire (workspace imports). */
  expires?: string;
  scrubVersion: number;
  /** Extra keys (unknown to the parser, preserved verbatim), e.g. import provenance. */
  extra?: Readonly<Record<string, unknown>>;
}

/** The note text of a new entry: frontmatter (`schema: 1`, `status: journal`, provenance), a heading, the body. */
export function renderEntry(f: EntryFields, body: string): string {
  const fm: Record<string, unknown> = {
    id: f.id,
    schema: 1,
    title: f.title,
    author: f.author,
    origin: f.origin,
    created: f.created,
    kind: f.kind,
    sources: [...f.sources],
    untrusted_origin: f.untrustedOrigin,
    status: 'journal',
  };
  if (f.expires !== undefined) fm['expires'] = f.expires;
  fm['scrubVersion'] = f.scrubVersion;
  for (const [k, v] of Object.entries(f.extra ?? {})) if (!(k in fm)) fm[k] = v;
  const yaml = stringify(fm, { lineWidth: 0 });
  const text = body.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\n${yaml}---\n# ${f.title}\n${text === '' ? '' : `\n${text}\n`}`;
}

/** `created` plus `days`, ISO 8601 UTC with second precision. */
export function expiresAt(created: Date, days: number): string {
  return new Date(created.getTime() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
