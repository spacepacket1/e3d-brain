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
  if (!text.includes('`')) return text;
  // Linear in the line length: split into maximal backtick runs, then pair each run with the next run of the same
  // length. (The former regex backtracked cubically on a long line of backticks: ~10 s at 5,000 of them.)
  const starts: number[] = [];
  const lens: number[] = [];
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text.charCodeAt(j) === 96) j++;
    starts.push(i);
    lens.push(j - i);
    i = j;
  }
  const next: number[] = new Array<number>(starts.length).fill(-1);
  const seen = new Map<number, number>();
  for (let r = starts.length - 1; r >= 0; r--) {
    next[r] = seen.get(lens[r]!) ?? -1;
    seen.set(lens[r]!, r);
  }
  const chars = text.split('');
  for (let r = 0; r < starts.length; ) {
    const c = next[r]!;
    if (c < 0) {
      r++;
      continue;
    }
    const from = starts[r]!;
    const to = starts[c]! + lens[c]!;
    for (let k = from; k < to; k++) chars[k] = ' ';
    r = c + 1;
  }
  return chars.join('');
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
