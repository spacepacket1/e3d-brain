// Phase 11 fixtures: a small public-domain EPUB (excerpts of Lewis Carroll,
// "Alice's Adventures in Wonderland", 1865), Markdown and text books, and
// hostile EPUBs (zip-slip, a huge entry, XHTML pointing at external URLs).
// Built at test time with the Phase 10 zip writer, so no binary is committed.
// As a CLI (`node dist/tests/ref-fixtures.js <dir> [<port>]`) it writes the
// files and prints a JSON manifest for tests/phase11.sh.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fake } from './scrub-fixtures.js';
import { buildZip, type ZipEntrySpec } from './zip-writer.js';

export const ALICE_TITLE = "Alice's Adventures in Wonderland";
export const ALICE_AUTHOR = 'Lewis Carroll';

/** Phrases and the chapter (1-based, in spine order) and heading each must be cited under. */
export const ALICE_PHRASES = [
  { phrase: 'without pictures or conversations', chapter: 1, heading: 'Down the Rabbit-Hole' },
  { phrase: 'Curiouser and curiouser', chapter: 2, heading: 'The Pool of Tears' },
  { phrase: 'Caucus-race', chapter: 3, heading: 'A Caucus-Race and a Long Tale' },
];

/** Text that must never be indexed: script and style contents, and the head. */
export const DROPPED_MARKERS = ['scriptmarkerzz', 'stylemarkerzz', 'headmarkerzz'];

const CH1 = [
  'Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, “and what is the use of a book,” thought Alice “without pictures or conversations?”',
  'So she was considering in her own mind (as well as she could, for the hot day made her feel very sleepy and stupid), whether the pleasure of making a daisy-chain would be worth the trouble of getting up and picking the daisies, when suddenly a White Rabbit with pink eyes ran close by her.',
  'There was nothing so very remarkable in that; nor did Alice think it so very much out of the way to hear the Rabbit say to itself, “Oh dear! Oh dear! I shall be late!” (when she thought it over afterwards, it occurred to her that she ought to have wondered at this, but at the time it all seemed quite natural); but when the Rabbit actually took a watch out of its waistcoat-pocket, and looked at it, and then hurried on, Alice started to her feet.',
  'In another moment down went Alice after it, never once considering how in the world she was to get out again.',
  'The rabbit-hole went straight on like a tunnel for some way, and then dipped suddenly down, so suddenly that Alice had not a moment to think about stopping herself before she found herself falling down a very deep well.',
  'Either the well was very deep, or she fell very slowly, for she had plenty of time as she went down to look about her and to wonder what was going to happen next. First, she tried to look down and make out what she was coming to, but it was too dark to see anything; then she looked at the sides of the well, and noticed that they were filled with cupboards and book-shelves.',
];
const CH2 = [
  '“Curiouser and curiouser!” cried Alice (she was so much surprised, that for the moment she quite forgot how to speak good English); “now I’m opening out like the largest telescope that ever was! Good-bye, feet!”',
  'For when she looked down at her feet, they seemed to be almost out of sight, they were getting so far off.',
];
const CH3 = [
  'They were indeed a queer-looking party that assembled on the bank—the birds with draggled feathers, the animals with their fur clinging close to them, and all dripping wet, cross, and uncomfortable.',
  '“What I was going to say,” said the Dodo in an offended tone, “was, that the best thing to get us dry would be a Caucus-race.”',
];

function xhtml(title: string, paras: readonly string[], opts: { externalBase?: string; secret?: string } = {}): string {
  const ext = opts.externalBase;
  const head = [
    `<title>${title} headmarkerzz</title>`,
    '<style>p { color: red } /* stylemarkerzz */</style>',
    ext === undefined ? '' : `<link rel="stylesheet" href="${ext}/style.css"/>`,
    ext === undefined ? '' : `<script src="${ext}/x.js"></script>`,
  ].join('\n');
  const body = paras.map((p) => `<p>${p.replace(/&/g, '&amp;')}</p>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
${head}
</head>
<body>
<script>var a = "scriptmarkerzz";</script>
<h2>${title}</h2>
${ext === undefined ? '' : `<img src="${ext}/pic.png" alt="an illustration"/><iframe src="${ext}/frame.html"></iframe>`}
${body}
${opts.secret === undefined ? '' : `<p>The rabbit muttered a key: ${opts.secret}</p>`}
</body>
</html>`;
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opf(title: string, author: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:alice-fixture</dc:identifier>
    <dc:title>${title.replace(/'/g, '&apos;')}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/chapter%203.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="nav" linear="no"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`;
}

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="text/ch1.xhtml">Down the Rabbit-Hole</a></li>
  <li><a href="text/ch2.xhtml#start">The Pool of Tears</a></li>
  <li><a href="text/chapter%203.xhtml">A Caucus-Race and a Long Tale</a></li>
</ol></nav></body></html>`;

export interface EpubOptions {
  /** Base URL (for example a loopback test server) that the XHTML references for stylesheets, scripts, images, and frames. */
  externalBase?: string;
  /** A fake secret planted in chapter 1 (must be redacted before storage). */
  secret?: string;
  /** Extra entries (hostile names, huge entries). */
  extra?: ZipEntrySpec[];
}

/** The Alice EPUB: cover (no text), three chapters in spine order (files listed out of order in the manifest). */
export function aliceEpub(opts: EpubOptions = {}): Buffer {
  const x = (t: string, p: readonly string[], secret?: string) => {
    const o: { externalBase?: string; secret?: string } = {};
    if (opts.externalBase !== undefined) o.externalBase = opts.externalBase;
    if (secret !== undefined) o.secret = secret;
    return xhtml(t, p, o);
  };
  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip', method: 0 },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf(ALICE_TITLE, ALICE_AUTHOR) },
    { name: 'OEBPS/nav.xhtml', data: NAV },
    { name: 'OEBPS/text/cover.xhtml', data: '<html><head><title>Cover</title></head><body><img src="cover.png"/></body></html>' },
    { name: 'OEBPS/text/ch1.xhtml', data: x('Chapter I', CH1, opts.secret) },
    { name: 'OEBPS/text/ch2.xhtml', data: x('Chapter II', CH2) },
    { name: 'OEBPS/text/chapter 3.xhtml', data: x('Chapter III', CH3) },
    { name: 'OEBPS/style.css', data: 'p { margin: 0 }' },
    ...(opts.extra ?? []),
  ]);
}

export const MD_BOOK = `---
title: The Markdown Manual
---
# The Markdown Manual

Front matter text before the first chapter.

## Getting Started

The quokkamarker paragraph explains how to begin.

### A detail

More about starting.

## Going Further

The wombatmarker paragraph explains advanced use.
`;

export const TXT_BOOK = `THE TEXT BOOK

A preface paragraph.

CHAPTER I. The Beginning

The platypusmarker appears in the first chapter.

CHAPTER II. The End

The echidnamarker appears in the second chapter.
`;

export interface RefFixtureManifest {
  epub: string;
  epubCopy: string;
  md: string;
  txt: string;
  pdf: string;
  secrets: string[];
  hostile: { zipSlip: string; huge: string; external: string };
}

/** Write every fixture into `dir`. With `externalBase`, the external-URL EPUB points at it. */
export function writeRefFixtures(dir: string, externalBase = 'http://127.0.0.1:9'): RefFixtureManifest {
  fs.mkdirSync(path.join(dir, 'hostile'), { recursive: true });
  const secret = fake.github();
  const write = (rel: string, data: Buffer | string) => {
    const p = path.join(dir, rel);
    fs.writeFileSync(p, data);
    return p;
  };
  const epub = aliceEpub({ secret });
  return {
    epub: write('alice.epub', epub),
    epubCopy: write('alice-copy.epub', epub),
    md: write('manual.md', MD_BOOK),
    txt: write('textbook.txt', TXT_BOOK),
    pdf: write('scan.pdf', '%PDF-1.4\n% not a real pdf; the test supplies a fake pdftotext\n'),
    secrets: [secret],
    hostile: {
      zipSlip: write('hostile/zip-slip.epub', aliceEpub({ extra: [{ name: '../../evil.xhtml', data: '<p>evil</p>' }] })),
      huge: write('hostile/huge.epub', aliceEpub({ extra: [{ name: 'OEBPS/text/huge.xhtml', data: '<p>x</p>', declaredSize: 600 * 1024 * 1024 }] })),
      external: write('hostile/external.epub', aliceEpub({ externalBase })),
    },
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, port] = process.argv.slice(2);
  if (dir === undefined) {
    process.stderr.write('usage: ref-fixtures.js <dir> [<port>]\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(writeRefFixtures(dir, port === undefined ? undefined : `http://127.0.0.1:${port}`))}\n`);
}
