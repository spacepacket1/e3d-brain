// A minimal, in-repo XML/XHTML tokenizer for EPUB ingestion (Phase 11; see
// docs/DEPENDENCIES.md for why there is no parser dependency). Pure string
// processing: no I/O, no network, no DTDs. `<!DOCTYPE>` and processing
// instructions are skipped, so there is no external entity resolution (XXE)
// and no entity expansion beyond the fixed table below. URLs in attributes
// (`src`, `href`) are only ever read as strings for in-archive lookups; they
// are never fetched.
//
// It is deliberately forgiving (EPUB XHTML in the wild is often HTML):
// unclosed tags are tolerated, `<script>`/`<style>` content is raw text up to
// the matching end tag, and malformed markup degrades to text.

export interface OpenToken {
  type: 'open';
  /** Lowercased local name (namespace prefix dropped). */
  name: string;
  /** Lowercased qualified attribute name to decoded value. */
  attrs: Map<string, string>;
  selfClosing: boolean;
}
export type Token = OpenToken | { type: 'close'; name: string } | { type: 'text'; text: string };

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', ensp: ' ', emsp: ' ',
  thinsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“',
  rdquo: '”', bdquo: '„', hellip: '…', middot: '·', bull: '•', copy: '©', reg: '®',
  trade: '™', deg: '°', sect: '§', para: '¶', laquo: '«', raquo: '»', times: '×',
  divide: '÷', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ', aelig: 'æ', oelig: 'œ', dagger: '†',
};

/** Decode character references. Unknown named references are kept verbatim; invalid code points become U+FFFD. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      const bad = !Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff);
      return bad ? '�' : String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

function localName(qname: string): string {
  const lower = qname.toLowerCase();
  const colon = lower.indexOf(':');
  return colon >= 0 ? lower.slice(colon + 1) : lower;
}

const RAW_TEXT = new Set(['script', 'style']);
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(src: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src)) !== null) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

/** Tokenize markup. Comments, CDATA markers, doctypes, and processing instructions produce no tokens (CDATA content is text). */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const pushText = (raw: string) => {
    if (raw !== '') out.push({ type: 'text', text: decodeEntities(raw) });
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(src.slice(i));
      break;
    }
    pushText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const text = src.slice(lt + 9, end < 0 ? src.length : end);
      if (text !== '') out.push({ type: 'text', text });
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      // A doctype's internal subset (`[ ... ]`) may contain `>`: skip it whole (its declarations are never used).
      let from = lt + 2;
      const bracket = src.indexOf('[', from);
      const gt = src.indexOf('>', from);
      if (bracket >= 0 && (gt < 0 || bracket < gt)) {
        const close = src.indexOf(']', bracket);
        from = close < 0 ? src.length : close;
      }
      const end = src.indexOf('>', from);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:._-]*)/.exec(src.slice(lt, lt + 256));
    if (m === null) {
      // A lone `<` is text.
      pushText('<');
      i = lt + 1;
      continue;
    }
    // Find the end of the tag, skipping `>` inside quoted attribute values.
    let j = lt + m[0].length;
    let quote = '';
    for (; j < src.length; j++) {
      const c = src[j]!;
      if (quote !== '') {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const inner = src.slice(lt + m[0].length, j);
    i = j + 1;
    const name = localName(m[2]!);
    if (m[1] === '/') {
      out.push({ type: 'close', name });
      continue;
    }
    const selfClosing = inner.trimEnd().endsWith('/');
    out.push({ type: 'open', name, attrs: parseAttrs(selfClosing ? inner.trimEnd().slice(0, -1) : inner), selfClosing });
    if (RAW_TEXT.has(name) && !selfClosing) {
      // Raw text up to the matching end tag; it is skipped by the text extractor.
      const close = new RegExp(`</(?:[A-Za-z0-9._-]+:)?${name}\\s*>`, 'i');
      const rest = src.slice(i);
      const cm = close.exec(rest);
      const end = cm === null ? src.length : i + cm.index;
      if (end > i) out.push({ type: 'text', text: src.slice(i, end) });
      out.push({ type: 'close', name });
      i = cm === null ? src.length : end + cm[0].length;
    }
  }
  return out;
}

// ---- a small element tree (container.xml, OPF, NCX, nav) ----

export interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

/** Build a tolerant element tree: a close tag pops to its matching open element; unmatched closes are ignored. */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: new Map(), children: [] };
  const stack: XmlElement[] = [root];
  for (const t of tokenize(src)) {
    const top = stack[stack.length - 1]!;
    if (t.type === 'text') top.children.push(t.text);
    else if (t.type === 'open') {
      const el: XmlElement = { name: t.name, attrs: t.attrs, children: [] };
      top.children.push(el);
      if (!t.selfClosing) stack.push(el);
    } else {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === t.name) {
          stack.length = k;
          break;
        }
      }
    }
  }
  return root;
}

/** Every descendant element named `name` (local name), in document order. */
export function findAll(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function findFirst(el: XmlElement, name: string): XmlElement | undefined {
  return findAll(el, name)[0];
}

/** Concatenated text content with whitespace collapsed. */
export function textOf(el: XmlElement): string {
  const parts: string[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (typeof c === 'string') parts.push(c);
      else walk(c);
    }
  };
  walk(el);
  return collapse(parts.join(''));
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---- XHTML to text ----

/** A paragraph of text, or a heading (level 1-6). */
export type TextBlock = { kind: 'para'; text: string } | { kind: 'heading'; level: number; text: string };

/** Elements whose content is never text: scripts, styles, metadata, embedded graphics, forms. */
const SKIP = new Set(['head', 'script', 'style', 'noscript', 'template', 'svg', 'math', 'object', 'iframe', 'audio', 'video', 'canvas', 'select', 'button']);
const BLOCK = new Set([
  'html', 'body', 'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'blockquote', 'li', 'ul', 'ol',
  'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'figure', 'figcaption', 'hr', 'address',
  'center', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * Text blocks of an XHTML document: scripts, styles, `<head>`, and embedded
 * media are dropped; block elements end paragraphs; `<br>` is a line break;
 * whitespace is collapsed outside `<pre>`. Images and links contribute only
 * their text (never their URLs).
 */
export function xhtmlToBlocks(src: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let skip = 0;
  let pre = 0;
  let heading: number | undefined;
  let buf = '';
  const flush = () => {
    const text = pre > 0 ? buf.replace(/^\n+|\s+$/g, '') : buf.split('\n').map(collapse).filter((l) => l !== '').join('\n');
    buf = '';
    if (text === '') return;
    if (heading !== undefined) blocks.push({ kind: 'heading', level: heading, text: collapse(text) });
    else blocks.push({ kind: 'para', text });
  };
  for (const t of tokenize(src)) {
    if (t.type === 'text') {
      if (skip === 0) buf += pre > 0 ? t.text : t.text.replace(/\s+/g, ' ');
      continue;
    }
    if (SKIP.has(t.name)) {
      if (t.type === 'open' && !t.selfClosing) skip++;
      else if (t.type === 'close' && skip > 0) skip--;
      continue;
    }
    if (skip > 0) continue;
    if (t.type === 'open' && t.name === 'br') {
      buf += '\n';
      continue;
    }
    if (t.type === 'open' && t.name === 'img') {
      const alt = t.attrs.get('alt');
      if (alt !== undefined && alt.trim() !== '') buf += ` ${alt} `;
      continue;
    }
    if (!BLOCK.has(t.name)) continue;
    const level = /^h([1-6])$/.exec(t.name);
    if (t.type === 'open' && !t.selfClosing) {
      flush();
      if (level !== null) heading = Number(level[1]);
      if (t.name === 'pre') pre++;
    } else if (t.type === 'close') {
      flush();
      if (level !== null) heading = undefined;
      if (t.name === 'pre' && pre > 0) pre--;
    } else flush();
  }
  heading = undefined;
  flush();
  return blocks;
}
