// Line-level Markdown structure: fenced code blocks, ATX headings, inline
// `#tags`, and `[[wikilinks]]`. Deliberately small: only what the index needs,
// with fenced code and inline code spans excluded from tag/link extraction.

export interface MdLine {
  text: string;
  /** 1-based line number in the whole file (frontmatter included). */
  line: number;
  /** Inside a fenced code block, including the opening and closing fence lines. */
  fence: boolean;
  fenceOpen: boolean;
  fenceClose: boolean;
  heading?: { level: number; text: string };
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** Classify body lines. `firstLine` is the file line number of the first body line. */
export function scanLines(body: string, firstLine = 1): MdLine[] {
  const out: MdLine[] = [];
  const lines = body.split('\n');
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const line = firstLine + i;
    if (fenceLen > 0) {
      const close = new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*$`).test(text);
      if (close) fenceLen = 0;
      out.push({ text, line, fence: true, fenceOpen: false, fenceClose: close });
      continue;
    }
    const open = FENCE_OPEN_RE.exec(text);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fenceChar = open[1]![0]!;
      fenceLen = open[1]!.length;
      out.push({ text, line, fence: true, fenceOpen: true, fenceClose: false });
      continue;
    }
    const h = HEADING_RE.exec(text);
    if (h) {
      const headingText = (h[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim();
      out.push({ text, line, fence: false, fenceOpen: false, fenceClose: false, heading: { level: h[1]!.length, text: headingText } });
      continue;
    }
    out.push({ text, line, fence: false, fenceOpen: false, fenceClose: false });
  }
  return out;
}

/** Blank out inline code spans (a backtick run closed by a run of equal length). */
export function maskInlineCode(text: string): string {
  return text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => ' '.repeat(m.length));
}

export interface WikiLink {
  /** Link target as written, without anchor or alias (may be empty for `[[#heading]]`). */
  target: string;
  anchor: string | null;
  alias: string | null;
  embed: boolean;
  line: number;
}

const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

export function extractWikiLinks(text: string, line: number): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    // Inside tables Obsidian writes the alias separator as `\|`.
    const inner = m[2]!.replace(/\\\|/g, '|');
    const bar = inner.indexOf('|');
    const targetPart = bar >= 0 ? inner.slice(0, bar) : inner;
    const alias = bar >= 0 ? inner.slice(bar + 1).trim() : null;
    const hash = targetPart.indexOf('#');
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const anchor = hash >= 0 ? targetPart.slice(hash + 1).trim() : null;
    if (target === '' && (anchor === null || anchor === '')) continue;
    out.push({ target, anchor: anchor === '' ? null : anchor, alias: alias === '' ? null : alias, embed: m[1] === '!', line });
  }
  return out;
}

// Obsidian tag characters: letters, numbers, `_`, `-`, `/`; at least one
// non-digit; preceded by start of line or whitespace (so URL fragments and
// headings are not tags).
const TAG_RE = /(?<=^|[\s(,;])#([\p{L}\p{N}\p{M}_\-/]+)/gu;

export function extractInlineTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1]!.replace(/\/+$/, '');
    if (tag !== '' && !/^[\p{N}_\-/]+$/u.test(tag)) out.push(tag);
  }
  return out;
}
