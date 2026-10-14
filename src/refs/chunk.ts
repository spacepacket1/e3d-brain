// Chunking of book chapters (Phase 11). Paragraphs are packed into chunks of
// at most REF_CHUNK_CHARS; a heading inside a chapter starts a new chunk, so
// every chunk carries the heading it falls under (for citation labels); an
// over-long paragraph is cut at sentence ends, then whitespace. Deterministic.

import type { TextBlock } from './xml.js';

export const REF_CHUNK_CHARS = 1200;

export interface RefChunk {
  ordinal: number;
  /** The nearest heading at or before the chunk start (chapter heading if none inside). */
  heading?: string;
  text: string;
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

/** Pieces of at most `max` characters, preferring sentence ends, then whitespace. */
export function splitParagraph(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, safeCut(rest, max));
    let cut = -1;
    const sentence = /[.!?。！？]["')\]’”]*\s+/g;
    let m: RegExpExecArray | null;
    while ((m = sentence.exec(window)) !== null) if (m.index + m[0].length > max / 2) cut = m.index + m[0].length;
    if (cut < 0) {
      const ws = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
      cut = ws > max / 2 ? ws + 1 : window.length;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim() !== '') out.push(rest.trim());
  return out.filter((s) => s !== '');
}

export function chunkChapter(blocks: readonly TextBlock[], chapterHeading: string | undefined, max: number = REF_CHUNK_CHARS): RefChunk[] {
  const out: RefChunk[] = [];
  let cur = '';
  let curHeading = chapterHeading;
  let started = false;
  const emit = () => {
    if (cur.trim() !== '') {
      const c: RefChunk = { ordinal: out.length, text: cur };
      if (curHeading !== undefined) c.heading = curHeading;
      out.push(c);
    }
    cur = '';
  };
  for (const b of blocks) {
    if (b.kind === 'heading') {
      // A heading closes the running chunk; the next chunk starts with it. A
      // leading heading is the chapter's own (the chapter heading wins).
      emit();
      if (started) curHeading = b.text;
      else curHeading ??= b.text;
    }
    const pieces = b.text.length > max ? splitParagraph(b.text, max) : [b.text];
    for (const p of pieces) {
      if (cur !== '' && cur.length + 2 + p.length > max) emit();
      cur = cur === '' ? p : `${cur}\n\n${p}`;
    }
    started = true;
  }
  emit();
  return out;
}
