// Book text extraction (Phase 11): EPUB, Markdown, plain text, and (through
// the optional external `pdftotext`) PDF, into chapters of text blocks.
//
// EPUB is read in memory through the Phase 10 safe zip reader (same limits:
// entry count, entry names, per-entry and total sizes; nothing extracted to
// disk). The OPF is found through META-INF/container.xml, chapters follow the
// spine order, titles come from the navigation document (EPUB 3 nav or EPUB 2
// NCX) or the document's own headings, and XHTML becomes text through the
// in-repo tokenizer (`./xml.ts`): scripts and styles are dropped and no URL
// is ever fetched. Hrefs are resolved only to archive entry names.

import * as path from 'node:path';
import type { ExternalFile } from '../safe-path.js';
import { DEFAULT_ZIP_LIMITS, readZipEntries, type ZipLimits } from '../import/zip.js';
import { decodeNote, splitFrontmatter } from '../vault/parse.js';
import { scanLines } from '../vault/markdown.js';
import { collapse, findAll, findFirst, parseXml, textOf, xhtmlToBlocks, type TextBlock, type XmlElement } from './xml.js';

export const REF_FORMATS = ['epub', 'md', 'txt', 'pdf'] as const;
export type RefFormat = (typeof REF_FORMATS)[number];

/** Largest total extracted text per book (UTF-16 code units). */
export const MAX_BOOK_TEXT_CHARS = 64 * 1024 * 1024;
/** Longest chapter heading kept. */
export const MAX_HEADING_CHARS = 200;

export interface Chapter {
  heading?: string;
  blocks: TextBlock[];
}

export interface Book {
  title?: string;
  author?: string;
  chapters: Chapter[];
}

export class BookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookError';
  }
}

/** The format for a file name, by extension; undefined when unsupported. */
export function formatOf(fileName: string): RefFormat | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.txt') return 'txt';
  if (ext === '.pdf') return 'pdf';
  return undefined;
}

function decode(data: Uint8Array, label: string): string {
  const d = decodeNote(data);
  if (d.invalidUtf8) throw new BookError(`${label} is not valid UTF-8`);
  return d.text;
}

function heading(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const h = collapse(text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' '));
  if (h === '') return undefined;
  return h.length > MAX_HEADING_CHARS ? `${h.slice(0, MAX_HEADING_CHARS - 1).trimEnd()}…` : h;
}

function nonEmpty(chapters: Chapter[]): Chapter[] {
  return chapters.filter((c) => c.blocks.some((b) => b.text.trim() !== ''));
}

function checkSize(chapters: Chapter[]): Chapter[] {
  let total = 0;
  for (const c of chapters) for (const b of c.blocks) total += b.text.length;
  if (total > MAX_BOOK_TEXT_CHARS) throw new BookError(`book text exceeds ${MAX_BOOK_TEXT_CHARS} characters`);
  return chapters;
}

/** Paragraphs of plain text (blank-line separated, inner whitespace kept as single lines). */
function paragraphs(text: string): TextBlock[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n'))
    .filter((p) => p !== '')
    .map((p) => ({ kind: 'para' as const, text: p }));
}

/**
 * Split blocks into chapters at the shallowest heading level that occurs at
 * least twice (one heading of that level is a title, not a chapter break);
 * blocks before the first break form a leading chapter without a heading.
 */
function splitByHeadings(blocks: TextBlock[], fallbackHeading?: string): Chapter[] {
  const counts = new Map<number, number>();
  for (const b of blocks) if (b.kind === 'heading') counts.set(b.level, (counts.get(b.level) ?? 0) + 1);
  let level: number | undefined;
  for (let l = 1; l <= 6; l++) {
    if ((counts.get(l) ?? 0) >= 2) {
      level = l;
      break;
    }
  }
  if (level === undefined) {
    const first = blocks.find((b) => b.kind === 'heading');
    return [{ heading: heading(fallbackHeading ?? first?.text), blocks }];
  }
  const out: Chapter[] = [];
  let cur: Chapter = { heading: heading(fallbackHeading), blocks: [] };
  for (const b of blocks) {
    if (b.kind === 'heading' && b.level === level) {
      out.push(cur);
      cur = { heading: heading(b.text), blocks: [b] };
    } else cur.blocks.push(b);
  }
  out.push(cur);
  return out;
}

// ---- Markdown and plain text ----

export function extractMarkdown(data: Uint8Array, label = 'file'): Book {
  const { yaml, body } = splitFrontmatter(decode(data, label));
  const blocks: TextBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    blocks.push(...paragraphs(para.join('\n')));
    para = [];
  };
  for (const l of scanLines(body)) {
    if (l.heading !== undefined && !l.fence) {
      flush();
      if (l.heading.text.trim() !== '') blocks.push({ kind: 'heading', level: l.heading.level, text: l.heading.text.trim() });
    } else para.push(l.text);
  }
  flush();
  const book: Book = { chapters: checkSize(nonEmpty(splitByHeadings(blocks))) };
  const fmTitle = yaml === null ? undefined : /^title:\s*["']?(.+?)["']?\s*$/m.exec(yaml)?.[1];
  const h1 = blocks.filter((b) => b.kind === 'heading' && b.level === 1);
  const title = heading(fmTitle ?? (h1.length === 1 ? h1[0]!.text : undefined));
  if (title !== undefined) book.title = title;
  return book;
}

const TXT_CHAPTER_RE = /^(?:chapter|book|part)\s+(?:[0-9]{1,4}|[ivxlcdm]{1,10}|[a-z-]{3,20})\b[^\n]{0,150}$/i;

/** Plain text: chapters start at lines like `CHAPTER IV.`, `Chapter 12: ...`, `BOOK II`. */
export function extractText(text: string): Book {
  const blocks: TextBlock[] = [];
  for (const p of paragraphs(text)) {
    const lines = p.text.split('\n');
    if (TXT_CHAPTER_RE.test(lines[0]!)) {
      blocks.push({ kind: 'heading', level: 1, text: lines[0]! });
      if (lines.length > 1) blocks.push({ kind: 'para', text: lines.slice(1).join('\n') });
    } else blocks.push(p);
  }
  return { chapters: checkSize(nonEmpty(splitByHeadings(blocks))) };
}

export function extractTxt(data: Uint8Array, label = 'file'): Book {
  return extractText(decode(data, label));
}

/** `pdftotext` output: form feeds separate pages; chapters are found like plain text. */
export function extractPdfText(text: string): Book {
  return extractText(text.replace(/\f/g, '\n\n'));
}

// ---- EPUB ----

const EPUB_TEXT_ENTRY = /\.(?:xml|opf|ncx|xhtml|html|htm)$/i;
const XHTML_TYPES = new Set(['application/xhtml+xml', 'text/html']);

/** Resolve an OPF/nav href against the directory of `base`, to an archive entry name; undefined if it leaves the archive or is a URL. */
export function resolveHref(base: string, href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('//')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split('#')[0]!.split('?')[0]!);
  } catch {
    return undefined;
  }
  if (decoded === '' || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(base), decoded));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return undefined;
  return joined;
}

interface Manifest {
  byId: Map<string, { href: string; type: string; properties: string }>;
}

/** Navigation titles by entry name (first title wins), from an EPUB 3 nav document or an EPUB 2 NCX. */
function navTitles(entries: Map<string, Buffer>, opfPath: string, manifest: Manifest, tocId: string | undefined): Map<string, string> {
  const titles = new Map<string, string>();
  const add = (base: string, href: string | undefined, title: string) => {
    if (href === undefined || title === '') return;
    const name = resolveHref(base, href);
    if (name !== undefined && !titles.has(name)) titles.set(name, title);
  };
  for (const item of manifest.byId.values()) {
    if (!item.properties.split(/\s+/).includes('nav')) continue;
    const name = resolveHref(opfPath, item.href);
    const data = name === undefined ? undefined : entries.get(name);
    if (data === undefined) continue;
    const doc = parseXml(decodeNote(data).text);
    const navs = findAll(doc, 'nav');
    const toc = navs.find((n) => (n.attrs.get('epub:type') ?? '').split(/\s+/).includes('toc')) ?? navs[0];
    if (toc === undefined) continue;
    for (const a of findAll(toc, 'a')) add(name!, a.attrs.get('href'), textOf(a));
  }
  const ncxItem = tocId !== undefined ? manifest.byId.get(tocId) : [...manifest.byId.values()].find((i) => i.type === 'application/x-dtbncx+xml');
  if (ncxItem !== undefined) {
    const name = resolveHref(opfPath, ncxItem.href);
    const data = name === undefined ? undefined : entries.get(name);
    if (data !== undefined) {
      const doc = parseXml(decodeNote(data).text);
      for (const np of findAll(doc, 'navpoint')) {
        const label = findFirst(np, 'navlabel');
        const content = findFirst(np, 'content');
        add(name!, content?.attrs.get('src'), label === undefined ? '' : textOf(label));
      }
    }
  }
  return titles;
}

function firstText(doc: XmlElement, name: string): string | undefined {
  const el = findFirst(doc, name);
  const t = el === undefined ? '' : textOf(el);
  return t === '' ? undefined : t;
}

/** Extract an EPUB read through `file` (an `openExternalFile` handle). */
export async function extractEpub(file: ExternalFile, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<Book> {
  const entries = await readZipEntries(file, (name) => EPUB_TEXT_ENTRY.test(name), limits);
  const container = entries.get('META-INF/container.xml');
  if (container === undefined) throw new BookError('not an EPUB: META-INF/container.xml is missing');
  const rootfile = findFirst(parseXml(decodeNote(container).text), 'rootfile')?.attrs.get('full-path');
  const opfPath = rootfile === undefined ? undefined : resolveHref('', rootfile);
  const opfData = opfPath === undefined ? undefined : entries.get(opfPath);
  if (opfPath === undefined || opfData === undefined) throw new BookError('EPUB package document (OPF) not found');
  const opf = parseXml(decodeNote(opfData).text);

  const manifest: Manifest = { byId: new Map() };
  for (const item of findAll(opf, 'item')) {
    const id = item.attrs.get('id');
    const href = item.attrs.get('href');
    if (id !== undefined && href !== undefined && !manifest.byId.has(id)) {
      manifest.byId.set(id, { href, type: (item.attrs.get('media-type') ?? '').toLowerCase(), properties: item.attrs.get('properties') ?? '' });
    }
  }
  const spine = findFirst(opf, 'spine');
  if (spine === undefined) throw new BookError('EPUB has no spine');
  const titles = navTitles(entries, opfPath, manifest, spine.attrs.get('toc'));

  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  for (const ref of findAll(spine, 'itemref')) {
    if (ref.attrs.get('linear') === 'no') continue;
    const item = manifest.byId.get(ref.attrs.get('idref') ?? '');
    if (item === undefined || !XHTML_TYPES.has(item.type) || item.properties.split(/\s+/).includes('nav')) continue;
    const name = resolveHref(opfPath, item.href);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const data = entries.get(name);
    if (data === undefined) continue;
    const blocks = xhtmlToBlocks(decodeNote(data).text);
    const parts = splitByHeadings(blocks, undefined);
    // One document, one chapter: the navigation title names it.
    if (parts.length === 1) parts[0]!.heading = heading(titles.get(name)) ?? parts[0]!.heading;
    chapters.push(...parts);
  }
  const book: Book = { chapters: checkSize(nonEmpty(chapters)) };
  const title = heading(firstText(opf, 'title'));
  const author = heading(firstText(opf, 'creator'));
  if (title !== undefined) book.title = title;
  if (author !== undefined) book.author = author;
  return book;
}
