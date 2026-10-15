// Chunking: split a note body by heading, keep fenced code blocks intact, and
// split sections longer than the target size on paragraph and then sentence
// boundaries. Deterministic and locale-independent (no Intl.Segmenter, whose
// rules depend on the ICU build).

import type { MdLine } from './markdown.js';

export const DEFAULT_MAX_CHUNK_CHARS = 1500;

export interface Chunk {
  ordinal: number;
  /** Heading texts from the outermost section to this chunk's section. */
  headingPath: string[];
  text: string;
}

interface Section {
  headingPath: string[];
  lines: MdLine[];
}

function sections(lines: MdLine[]): Section[] {
  const out: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: Section = { headingPath: [], lines: [] };
  for (const l of lines) {
    if (l.heading) {
      out.push(current);
      while (stack.length > 0 && stack[stack.length - 1]!.level >= l.heading.level) stack.pop();
      stack.push(l.heading);
      current = { headingPath: stack.map((h) => h.text), lines: [] };
    }
    current.lines.push(l);
  }
  out.push(current);
  return out;
}

interface Block {
  text: string;
  code: boolean;
}

/** Paragraphs (blank-line separated), heading lines, and whole fenced code blocks. */
function blocks(lines: MdLine[]): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let code: string[] | undefined;
  const flushPara = () => {
    if (para.length > 0) out.push({ text: para.join('\n'), code: false });
    para = [];
  };
  for (const l of lines) {
    if (code !== undefined) {
      code.push(l.text);
      if (l.fenceClose) {
        out.push({ text: code.join('\n'), code: true });
        code = undefined;
      }
      continue;
    }
    if (l.fenceOpen) {
      flushPara();
      code = [l.text];
      continue;
    }
    if (l.heading) {
      flushPara();
      out.push({ text: l.text.trim(), code: false });
      continue;
    }
    if (l.text.trim() === '') flushPara();
    else para.push(l.text);
  }
  flushPara();
  if (code !== undefined) out.push({ text: code.join('\n').replace(/\s+$/, ''), code: true });
  return out;
}

/** Cut position at most `max` UTF-16 units in, never inside a surrogate pair. */
function safeCut(text: string, max: number): number {
  let cut = Math.min(max, text.length);
  if (cut < text.length && cut > 0) {
    const c = text.charCodeAt(cut);
    if (c >= 0xdc00 && c <= 0xdfff) cut--;
  }
  return Math.max(cut, 1);
}

/** Split an over-long paragraph into pieces of at most `max` characters, preferring sentence ends. */
function splitLong(text: string, max: number): string[] {
  // Sentence pieces keep their trailing whitespace so concatenation restores the text.
  // The lazy prefix always matches from the current position, so no text is skipped.
  const sentences = text.match(/[\s\S]*?(?:[.!?]+["')\]\u2019\u201D]*(?:\s+|$)|[\u3002\uFF01\uFF1F]+\s*|$)/gu)?.filter((s) => s !== '') ?? [text];
  const pieces: string[] = [];
  for (let s of sentences) {
    while (s.length > max) {
      let cut = safeCut(s, max);
      const space = s.lastIndexOf(' ', cut);
      const nl = s.lastIndexOf('\n', cut);
      const ws = Math.max(space, nl);
      if (ws > max / 2) cut = ws + 1;
      pieces.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if (s !== '') pieces.push(s);
  }
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur !== '' && cur.length + p.length > max) {
      out.push(cur);
      cur = '';
    }
    cur += p;
  }
  if (cur !== '') out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

export function chunkBody(lines: MdLine[], maxChars: number = DEFAULT_MAX_CHUNK_CHARS): Chunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be a positive integer');
  const out: Chunk[] = [];
  const emit = (headingPath: string[], text: string) => {
    if (text.trim() !== '') out.push({ ordinal: out.length, headingPath, text });
  };
  for (const section of sections(lines)) {
    const parts: Block[] = [];
    for (const b of blocks(section.lines)) {
      if (!b.code && b.text.length > maxChars) {
        for (const piece of splitLong(b.text, maxChars)) parts.push({ text: piece, code: false });
      } else parts.push(b);
    }
    let cur = '';
    for (const b of parts) {
      if (cur !== '' && cur.length + 2 + b.text.length > maxChars) {
        emit(section.headingPath, cur);
        cur = '';
      }
      // An oversized code block stays whole, alone in its chunk.
      cur = cur === '' ? b.text : `${cur}\n\n${b.text}`;
    }
    emit(section.headingPath, cur);
  }
  return out;
}
