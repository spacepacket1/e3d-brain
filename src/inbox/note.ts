// Inbox proposals (Phase 8): slugs, file names, and the note text of a new
// proposal. Pure: no I/O. The writer (`./writer.ts`) is the only code that
// turns these into files, and only under `_inbox/`.

import { stringify } from 'yaml';
import { nfc } from '../vault/names.js';

/** Kinds `capture` accepts. */
export const CAPTURE_KINDS = ['fact', 'decision', 'preference', 'idea', 'lesson', 'reference'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];
/** Kind of a capture that names none. */
export const DEFAULT_CAPTURE_KIND: CaptureKind = 'idea';

/** Longest slug, in characters (all ASCII). */
export const MAX_SLUG_CHARS = 60;
/** Slug of a title with no usable characters. */
export const FALLBACK_SLUG = 'note';
/** Longest title kept in frontmatter and in the heading. */
export const MAX_TITLE_CHARS = 300;

declare const slugBrand: unique symbol;
/** A sanitized slug: `[a-z0-9]+(-[a-z0-9]+)*`, at most MAX_SLUG_CHARS. Only `toSlug` makes one. */
export type Slug = string & { readonly [slugBrand]: true };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSlug(s: unknown): s is Slug {
  return typeof s === 'string' && s.length <= MAX_SLUG_CHARS && SLUG_RE.test(s);
}

/**
 * Sanitize free text into a slug: NFKD, drop combining marks, lowercase,
 * every run of other characters (separators, dots, punctuation, non-Latin
 * letters) becomes one `-`, trimmed, cut to MAX_SLUG_CHARS on a word boundary
 * where possible. Path syntax cannot survive: `../../x` becomes `x`.
 */
export function toSlug(text: string): Slug {
  let s = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > MAX_SLUG_CHARS) {
    s = s.slice(0, MAX_SLUG_CHARS);
    const cut = s.lastIndexOf('-');
    s = (cut >= MAX_SLUG_CHARS / 2 ? s.slice(0, cut) : s).replace(/-+$/, '');
  }
  return (s === '' ? FALLBACK_SLUG : s) as Slug;
}

/** `<slug>` for attempt 0, then `<slug>-2`, `<slug>-3`, ... (the base is cut so the result stays a valid slug). */
export function suffixedSlug(slug: Slug, attempt: number): Slug {
  if (attempt === 0) return slug;
  const suffix = `-${attempt + 1}`;
  const base = slug.slice(0, MAX_SLUG_CHARS - suffix.length).replace(/-+$/, '');
  return `${base === '' ? FALLBACK_SLUG : base}${suffix}` as Slug;
}

/** `yyyymmdd-hhmmss` in UTC. */
export function fileStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '').replace(/-|:/g, '').replace('T', '-');
}

/** ISO 8601 UTC with second precision (`created`, `accepted`, `rejected`). */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** One line of display text: control and format characters become spaces, NFC, trimmed, length-limited. */
export function cleanTitle(title: string): string {
  const s = nfc(title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim());
  return s.length > MAX_TITLE_CHARS ? `${s.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : s;
}

export interface ProposalFields {
  id: string;
  title: string;
  kind: string;
  created: string;
  origin: 'mcp' | 'hook' | 'import' | 'cli';
  author: string;
  sources: readonly string[];
  scrubVersion: number;
  untrustedOrigin?: boolean;
}

/** The note text of a new proposal: frontmatter (`schema: 1`, `status: proposed`, provenance), a heading, the body. */
export function renderProposal(f: ProposalFields, body: string): string {
  const fm: Record<string, unknown> = {
    schema: 1,
    id: f.id,
    title: f.title,
    status: 'proposed',
    kind: f.kind,
    created: f.created,
    origin: f.origin,
    author: f.author,
    sources: [...f.sources],
    scrubVersion: f.scrubVersion,
  };
  if (f.untrustedOrigin === true) fm['untrusted_origin'] = true;
  const yaml = stringify(fm, { lineWidth: 0 });
  const text = body.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\n${yaml}---\n# ${f.title}\n${text === '' ? '' : `\n${text}\n`}`;
}
