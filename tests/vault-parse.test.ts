import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBody } from '../src/vault/chunk.js';
import { extractInlineTags, extractWikiLinks, maskInlineCode, scanLines } from '../src/vault/markdown.js';
import { compareBytes, comparePaths, findCollisions, folderClass, foldKey } from '../src/vault/names.js';
import { canonicalJson, decodeNote, isIsoDate, parseNote } from '../src/vault/parse.js';
import { prng } from './helpers.js';

const enc = (s: string) => Buffer.from(s, 'utf8');

describe('names', () => {
  it('folds case and normalization identically', () => {
    assert.equal(foldKey('Caf\u00E9'), foldKey('CAFE\u0301'));
    assert.equal(foldKey('Stra\u00DFe'), foldKey('STRASSE'));
    assert.notEqual(foldKey('a'), foldKey('b'));
  });

  it('orders bytewise on UTF-8, not by UTF-16 code units or locale', () => {
    // U+FF5E (3 UTF-8 bytes, EF BD 9E) sorts before U+1F600 (4 bytes, F0 ...), the reverse of UTF-16 order.
    assert.ok('\u{1F600}' < '\uFF5E');
    assert.ok(compareBytes('\uFF5E', '\u{1F600}') < 0);
    assert.ok(compareBytes('B', 'a') < 0);
    // NFC and NFD of one name compare equal on NFC, then by raw bytes.
    assert.ok(comparePaths('e\u0301.md', '\u00E9.md') !== 0);
    // On raw bytes NFD 'e\u0301' would sort before 'f'; on NFC both forms sort after it.
    assert.ok(comparePaths('\u00E9.md', 'f.md') > 0 && comparePaths('e\u0301.md', 'f.md') > 0);
  });

  it('computes folder classes per the spec table', () => {
    const cases: [string, string, boolean][] = [
      ['note.md', 'curated', false],
      ['a/b/note.md', 'curated', false],
      ['_inbox/x.md', 'inbox', false],
      ['_Inbox/x.md', 'inbox', false],
      ['_inbox/_rejected/x.md', 'inbox', true],
      ['_inbox/_applied/x.md', 'inbox', true],
      ['journal/agent/x.md', 'journal', false],
      ['journal/_archive/agent/x.md', 'archive', true],
      ['_raw/x.md', 'raw', false],
      ['_archive/x.md', 'archive', true],
      ['references/x.md', 'reference', false],
      ['notes/_inbox/x.md', 'curated', false],
      ['_inbox.md', 'curated', false],
    ];
    for (const [p, cls, hidden] of cases) assert.deepEqual(folderClass(p), { folderClass: cls, hidden }, p);
  });

  it('finds case and normalization collisions', () => {
    assert.deepEqual(findCollisions(['A.md', 'b.md', 'a.md', 'caf\u00E9.md', 'cafe\u0301.md']), [
      ['A.md', 'a.md'],
      ['cafe\u0301.md', 'caf\u00E9.md'].sort(comparePaths),
    ]);
    assert.deepEqual(findCollisions(['x/a.md', 'y/a.md']), []);
  });
});

describe('markdown', () => {
  it('extracts wikilinks with anchors, aliases, and embeds', () => {
    const links = extractWikiLinks('see [[A]] [[b/C#Head|Alias]] ![[Img]] [[#Local]] [[T\\|alias]] [[]]', 3);
    assert.deepEqual(
      links.map((l) => [l.target, l.anchor, l.alias, l.embed, l.line]),
      [
        ['A', null, null, false, 3],
        ['b/C', 'Head', 'Alias', false, 3],
        ['Img', null, null, true, 3],
        ['', 'Local', null, false, 3],
        ['T', null, 'alias', false, 3],
      ],
    );
  });

  it('extracts inline tags but not numbers, URL fragments, or code', () => {
    assert.deepEqual(extractInlineTags('#one two #a/b/ x#no #123 (#paren) #\u00FCn\u00EF'), ['one', 'a/b', 'paren', '\u00FCn\u00EF']);
    assert.deepEqual(extractInlineTags(maskInlineCode('`#code` and ``#also `x` code`` #real')), ['real']);
  });

  it('tracks fences so headings inside code are not headings', () => {
    const lines = scanLines('# H\n```\n# not\n```\n~~~~\n```\n# still code\n~~~~\n## H2');
    assert.deepEqual(lines.filter((l) => l.heading).map((l) => l.heading!.text), ['H', 'H2']);
    assert.deepEqual(lines.map((l) => l.fence), [false, true, true, true, true, true, true, true, false]);
  });
});

describe('parseNote', () => {
  it('reads frontmatter, title, tags, aliases, and schema fields', () => {
    const n = parseNote('dir/file.md', enc([
      '---',
      'title: The Title',
      'tags: [One, "#two"]',
      'aliases: Other Name',
      'status: accepted',
      'pinned: false',
      'kind: lesson',
      'occurred: 2024-02-29',
      'expires: 2026-01-01T00:00:00+02:00',
      'sources: commit:abc1234',
      'untrusted_origin: true',
      'schema: 1',
      'mystery: {deep: [1, 2]}',
      '---',
      '# Heading #three',
      'Body with [[Link]].',
    ].join('\n')));
    assert.equal(n.frontmatter, 'ok');
    assert.equal(n.title, 'The Title');
    assert.deepEqual(n.tags, [
      { tag: 'one', source: 'frontmatter' },
      { tag: 'three', source: 'inline' },
      { tag: 'two', source: 'frontmatter' },
    ]);
    assert.deepEqual(n.aliases, ['Other Name']);
    assert.equal(n.fields.status, 'accepted');
    assert.equal(n.statusKnown, true);
    assert.equal(n.fields.pinned, false);
    assert.equal(n.fields.kind, 'lesson');
    assert.equal(n.fields.occurred, '2024-02-29');
    assert.equal(n.fields.expires, '2026-01-01T00:00:00+02:00');
    assert.deepEqual(n.fields.sources, ['commit:abc1234']);
    assert.equal(n.fields.untrusted_origin, true);
    assert.equal(n.fields.schema, 1);
    assert.deepEqual(n.extra, { mystery: { deep: [1, 2] } });
    assert.deepEqual(n.headings, [{ level: 1, text: 'Heading #three', line: 15 }]);
    assert.equal(n.links[0]!.target, 'Link');
    assert.equal(n.links[0]!.line, 16);
    assert.deepEqual(n.problems, []);
  });

  it('falls back to the first H1, then the file name, for the title', () => {
    assert.equal(parseNote('a/x.md', enc('## Two\n# One\n')).title, 'One');
    assert.equal(parseNote('a/x.md', enc('text only')).title, 'x');
    assert.equal(parseNote('a/x.md', enc('```\n# code\n```\n')).title, 'x');
  });

  it('skips malformed frontmatter, indexes the body, and records the problem', () => {
    for (const bad of ['title: [unclosed', 'a: 1\na: 2', '- just\n- a list', 'key: *undefinedAlias']) {
      const n = parseNote('x.md', enc(`---\n${bad}\n---\nbody word\n`));
      assert.equal(n.frontmatter, 'malformed', bad);
      assert.equal(n.problems[0]!.kind, 'malformed_frontmatter', bad);
      assert.deepEqual(n.chunks.map((c) => c.text), ['body word'], bad);
    }
    const unclosed = parseNote('x.md', enc('---\ntitle: x\nbody'));
    assert.equal(unclosed.frontmatter, 'malformed');
    assert.ok(unclosed.chunks[0]!.text.includes('body'));
  });

  it('counts invalid dates, unknown statuses, and wrongly typed fields without failing', () => {
    const n = parseNote('x.md', enc('---\nstatus: maybe\noccurred: 2023-02-29\nvalid_from: 2026-13-01\npinned: 1\nkind: [x]\nsources: {a: 1}\n---\nbody'));
    assert.equal(n.fields.status, 'maybe');
    assert.equal(n.statusKnown, false);
    assert.equal(n.fields.occurred, null);
    assert.deepEqual(n.problems.map((p) => `${p.kind}:${p.field}`).sort(), [
      'invalid_date:occurred', 'invalid_date:valid_from', 'invalid_field:kind', 'invalid_field:pinned',
      'invalid_field:sources', 'unknown_status:status',
    ]);
    // A non-string status is kept (stringified) and unknown, never treated as absent.
    const odd = parseNote('x.md', enc('---\nstatus: 5\n---\n'));
    assert.equal(odd.fields.status, '5');
    assert.equal(odd.statusKnown, false);
  });

  it('validates ISO dates', () => {
    for (const ok of ['2026-01-31', '2024-02-29', '2026-10-14T10:00Z', '2026-10-14T10:00:59.123+05:30', '2026-10-14 10:00:00']) {
      assert.ok(isIsoDate(ok), ok);
    }
    for (const bad of ['2026-02-29', '2026-00-10', '2026-1-1', '2026-10-14T24:00', 'tomorrow', '2026-10-14T10:00+25:00', '']) {
      assert.ok(!isIsoDate(bad), bad);
    }
  });

  it('normalizes BOM and CRLF, and counts invalid UTF-8', () => {
    const crlf = parseNote('x.md', Buffer.from('\uFEFF---\r\ntitle: T\r\n---\r\n# H\r\nbody\r\n'));
    assert.equal(crlf.title, 'T');
    assert.equal(crlf.frontmatter, 'ok');
    assert.deepEqual(decodeNote(Buffer.from([0x61, 0xff, 0x62])).invalidUtf8, true);
    assert.equal(parseNote('x.md', Buffer.from([0x61, 0xff])).problems[0]!.kind, 'invalid_utf8');
  });

  it('never executes YAML tags and bounds alias expansion', () => {
    const n = parseNote('x.md', enc('---\nfn: !!js/function "function(){}"\n---\n'));
    assert.notEqual(typeof n.extra.fn, 'function');
    const bomb = ['---', 'a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 0; i < 8; i++) bomb.push(`${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(', ')}]`);
    bomb.push('---', 'body');
    const b = parseNote('x.md', enc(bomb.join('\n')));
    assert.equal(b.frontmatter, 'malformed');
  });

  it('produces canonical JSON with sorted keys', () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: Infinity }] }), '{"a":[true,null,{"c":"Infinity","d":"x"}],"b":1}');
  });
});

describe('chunkBody', () => {
  const chunk = (s: string, max?: number) => chunkBody(scanLines(s), max);

  it('splits by heading and records heading paths and ordinals', () => {
    const c = chunk('intro\n# A\na text\n## B\nb text\n# C\nc text');
    assert.deepEqual(c.map((x) => [x.ordinal, x.headingPath, x.text]), [
      [0, [], 'intro'],
      [1, ['A'], '# A\n\na text'],
      [2, ['A', 'B'], '## B\n\nb text'],
      [3, ['C'], '# C\n\nc text'],
    ]);
  });

  it('keeps fenced code blocks intact even when longer than the maximum', () => {
    const code = '```\n' + Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n```';
    const c = chunk(`# H\n\npara one\n\n${code}\n\npara two`, 100);
    const withFence = c.filter((x) => x.text.includes('```'));
    assert.equal(withFence.length, 1);
    assert.equal(withFence[0]!.text, code);
  });

  it('splits long sections on sentence boundaries within the maximum', () => {
    const para = Array.from({ length: 50 }, (_, i) => `Sentence ${i} is here.`).join(' ');
    const c = chunk(para, 120);
    assert.ok(c.length > 1);
    for (const x of c) {
      assert.ok(x.text.length <= 120, x.text);
      assert.match(x.text, /\.$/);
    }
    assert.equal(c.map((x) => x.text).join(' '), para);
  });

  it('never loses or reorders words (property test)', () => {
    const rand = prng(42);
    const words = ['alpha', 'beta.', 'gamma!', 'delta?', '\u00FC', '\u65E5\u672C\u3002', 'x'.repeat(30), '\u{1F600}'];
    for (let round = 0; round < 200; round++) {
      const lines: string[] = [];
      const n = 1 + Math.floor(rand() * 30);
      for (let i = 0; i < n; i++) {
        const r = rand();
        if (r < 0.1) lines.push(`${'#'.repeat(1 + Math.floor(rand() * 3))} head${i}`);
        else if (r < 0.2) lines.push('');
        else lines.push(Array.from({ length: 1 + Math.floor(rand() * 40) }, () => words[Math.floor(rand() * words.length)]).join(' '));
      }
      const body = lines.join('\n');
      const max = 20 + Math.floor(rand() * 300);
      const chunks = chunk(body, max);
      // Over-long words are hard-split, so compare with whitespace removed.
      const norm = (s: string) => s.replace(/\s+/g, '');
      assert.equal(norm(chunks.map((c) => c.text).join(' ')), norm(body));
      for (const c of chunks) {
        assert.ok(c.text.length <= max, `chunk over max ${max}: ${c.text.length}`);
        assert.ok(!/[\uD800-\uDBFF]$/.test(c.text) && !/^[\uDC00-\uDFFF]/.test(c.text), 'split inside a surrogate pair');
      }
    }
  });
});
