// Phase 11: the reference library. The XHTML tokenizer (entities, scripts
// and styles dropped, no DTD expansion, no URLs), EPUB href resolution and
// chapter splitting, chunking, `refs add` (EPUB/Markdown/text, PDF via a fake
// pdftotext; scrubbed; no book text in the vault; re-add is a no-op),
// `search` scopes and output limits, `read_ref_chunk` (cap, fence, range
// checks), hostile EPUBs (zip-slip, huge entry, external URLs: no writes
// outside the state dir, no network requests), `refs remove|list|reindex`, and
// refs.db surviving `reindex --full`.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseCitation } from '../src/cite/citation.js';
import { runReindex } from '../src/cli/index-commands.js';
import { runRefs } from '../src/cli/refs-commands.js';
import { parseConfig } from '../src/config.js';
import { closeIndex, openIndex } from '../src/index/indexer.js';
import { dispatch, listTools, ToolRegistry, type DispatchContext, type ToolCallResponse } from '../src/mcp/dispatch.js';
import { FENCE_LABEL } from '../src/mcp/fence.js';
import { registerRefTools } from '../src/mcp/ref-tools.js';
import { REFS_NOTICE, registerReadTools, type RefsEnv } from '../src/mcp/tools.js';
import { chunkChapter, REF_CHUNK_CHARS, splitParagraph } from '../src/refs/chunk.js';
import { openRefsDbReadOnly, REF_ID_RE } from '../src/refs/db.js';
import { extractMarkdown, extractText, resolveHref } from '../src/refs/extract.js';
import { refIdOf } from '../src/refs/library.js';
import { decodeEntities, tokenize, xhtmlToBlocks } from '../src/refs/xml.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import { header, results } from './mcp-client.js';
import { ALICE_AUTHOR, ALICE_PHRASES, ALICE_TITLE, aliceEpub, DROPPED_MARKERS, writeRefFixtures, type RefFixtureManifest } from './ref-fixtures.js';
import { realTmpDir, rmrf, treeChecksum } from './helpers.js';

const bases: string[] = [];
after(() => {
  for (const b of bases) rmrf(b);
});

let fx: RefFixtureManifest;
before(() => {
  const dir = realTmpDir('ebrain-p11-fx-');
  bases.push(dir);
  fx = writeRefFixtures(dir);
});

interface Env {
  base: string;
  vault: string;
  stateDir: SafePath;
  env: NodeJS.ProcessEnv;
  configPath: string;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  const base = realTmpDir('ebrain-p11-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const configPath = path.join(base, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox', ...extra }), { mode: 0o600 });
  return { base, vault, stateDir, configPath, env: { EBRAIN_CONFIG: configPath, HOME: base } };
}

async function refs(e: Env, ...args: string[]) {
  return runRefs(args, { env: e.env, homeDir: e.base });
}

async function addOk(e: Env, file: string, ...flags: string[]): Promise<string> {
  const r = await refs(e, 'add', file, ...flags);
  assert.equal(r.code, 0, r.stderr);
  return /ref_[0-9a-f]{32}/.exec(r.stdout)![0];
}

function refsEnv(e: Env, over: Partial<RefsEnv> = {}): RefsEnv {
  return { stateDir: e.stateDir, excerptChars: 400, maxHits: 5, ...over };
}

function tools(e: Env, over: Partial<RefsEnv> = {}) {
  const index = openIndex({ vaultPath: e.vault, stateDir: e.stateDir });
  const registry = new ToolRegistry();
  const env = refsEnv(e, over);
  registerReadTools({ vaultPath: e.vault, index, refs: env }, registry);
  registerRefTools(env, registry);
  const ctx: DispatchContext = { mode: 'read-only', principal: { id: 't', type: 'human' }, maxCharsPerCall: 10000, registry };
  return {
    call: (name: string, args: Record<string, unknown>): Promise<ToolCallResponse> => dispatch(ctx, name, args),
    close: () => closeIndex(index),
  };
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function allChunkTexts(e: Env): string[] {
  const db = openRefsDbReadOnly(e.stateDir)!;
  try {
    return (db.prepare('SELECT text FROM refs_chunks').all() as { text: string }[]).map((r) => r.text);
  } finally {
    db.close();
  }
}

function fileSum(p: string): string {
  return fs.readFileSync(p).toString('base64');
}

describe('XHTML tokenizer (in-repo, no dependency)', () => {
  it('decodes entities and refuses invalid code points', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &mdash; &bogus; &#0; &#xD800;'), 'a & b <c> AB — &bogus; � �');
  });

  it('drops scripts, styles, head, and embedded media; keeps headings and paragraphs; never emits URLs', () => {
    const blocks = xhtmlToBlocks(`<?xml version="1.0"?><!DOCTYPE html [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <html><head><title>T headmark</title><style>body{}/* stylemark */</style><link href="http://evil.example/x.css"/></head>
      <body><script>alert("scriptmark")</script><SCRIPT type="x">more scriptmark</SCRIPT>
      <h1>Title &amp; More</h1><p>First <b>bold</b>
      line<br/>second line</p><img src="http://evil.example/i.png" alt="alt text"/>
      <svg><text>svgmark</text></svg><p>&xxe; <a href="https://evil.example/">link text</a><![CDATA[ cdata ]]></p>
      <pre>  keep
    spacing</pre></body></html>`);
    assert.deepEqual(blocks, [
      { kind: 'heading', level: 1, text: 'Title & More' },
      { kind: 'para', text: 'First bold line\nsecond line' },
      { kind: 'para', text: 'alt text' },
      { kind: 'para', text: '&xxe; link text cdata' },
      { kind: 'para', text: '  keep\n    spacing' },
    ]);
    const all = JSON.stringify(blocks);
    for (const m of ['headmark', 'stylemark', 'scriptmark', 'svgmark', 'http', 'passwd']) assert.ok(!all.includes(m), m);
  });

  it('tolerates malformed markup without throwing', () => {
    for (const s of ['<', '<p', '<p a="unterminated', '</>', '<<<>>>', '<!-- open', '<![CDATA[ open', '<script>never closed']) {
      assert.doesNotThrow(() => xhtmlToBlocks(s), s);
      assert.doesNotThrow(() => tokenize(s), s);
    }
  });

  it('resolves hrefs only to archive entries (no URLs, absolute paths, or escapes)', () => {
    assert.equal(resolveHref('OEBPS/content.opf', 'text/ch%201.xhtml#frag'), 'OEBPS/text/ch 1.xhtml');
    assert.equal(resolveHref('OEBPS/text/a.xhtml', '../b.xhtml'), 'OEBPS/b.xhtml');
    for (const bad of ['http://x/y.xhtml', 'https://x', 'file:///etc/passwd', '/abs.xhtml', '//host/x', '../../x.xhtml', 'a\\b', '%E0%A4%A']) {
      assert.equal(resolveHref('OEBPS/content.opf', bad), undefined, bad);
    }
  });
});

describe('chapters and chunks', () => {
  it('Markdown splits at the shallowest repeated heading level; text at CHAPTER lines', () => {
    const md = extractMarkdown(Buffer.from('---\ntitle: T\n---\n# T\n\nintro\n\n## A\n\none\n\n### sub\n\ntwo\n\n## B\n\nthree\n'));
    assert.equal(md.title, 'T');
    assert.deepEqual(md.chapters.map((c) => c.heading), [undefined, 'A', 'B']);
    const txt = extractText('Preface.\n\nCHAPTER I. One\n\nalpha\n\nChapter 2\n\nbeta\n');
    assert.deepEqual(txt.chapters.map((c) => c.heading), [undefined, 'CHAPTER I. One', 'Chapter 2']);
  });

  it('chunks stay within the size, keep every word, and carry the heading they fall under', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    for (const p of splitParagraph(long, 200)) assert.ok(p.length <= 200);
    assert.equal(splitParagraph(long, 200).join(' '), long);
    const chunks = chunkChapter(
      [{ kind: 'heading', level: 2, text: 'Chapter heading' }, { kind: 'para', text: long }, { kind: 'heading', level: 3, text: 'Sub' }, { kind: 'para', text: 'tail' }],
      'Nav title',
    );
    for (const c of chunks) assert.ok(c.text.length <= REF_CHUNK_CHARS);
    assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
    assert.equal(chunks[0]!.heading, 'Nav title');
    assert.equal(chunks[chunks.length - 1]!.heading, 'Sub');
    assert.ok(chunks[chunks.length - 1]!.text.startsWith('Sub'));
  });
});

describe('refs add (EPUB) and search scope refs', () => {
  let e: Env;
  let refId: string;
  before(async () => {
    e = makeEnv();
    fs.writeFileSync(path.join(e.vault, 'notes', 'rabbit.md'), '# Rabbit\n\nMy own note about the rabbit-hole and a Caucus-race.\n');
    refId = await addOk(e, fx.epub);
  });

  it('ref_id is a stable function of the file SHA-256; the note is created once, with metadata only', async () => {
    const { createHash } = await import('node:crypto');
    assert.equal(refId, refIdOf(createHash('sha256').update(fs.readFileSync(fx.epub)).digest('hex')));
    assert.match(refId, REF_ID_RE);
    const note = fs.readFileSync(path.join(e.vault, 'references', 'alice-s-adventures-in-wonderland.md'), 'utf8');
    const fm = parseYaml(note.split('\n---\n')[0]!.slice(4)) as Record<string, unknown>;
    assert.equal(fm['ref_id'], refId);
    assert.equal(fm['title'], ALICE_TITLE);
    assert.equal(fm['book_author'], ALICE_AUTHOR);
    assert.equal(fm['source_path'], fx.epub);
    assert.equal(fm['kind'], 'reference');
    assert.equal(fm['author'], 'tester');
    assert.match(note, /## My notes/);
    assert.equal(fs.statSync(path.join(e.stateDir, 'refs.db')).mode & 0o777, 0o600);
  });

  it('no book text appears anywhere under the vault (scan)', () => {
    const vaultText = walkFiles(e.vault).map((p) => fs.readFileSync(p, 'utf8')).join('\n');
    for (const { phrase } of ALICE_PHRASES.filter((p) => p.phrase !== 'Caucus-race')) assert.ok(!vaultText.includes(phrase), phrase);
    // Every sentence-sized piece of every stored chunk is absent from the vault.
    for (const text of allChunkTexts(e)) {
      for (const piece of text.split(/(?<=[.!?”])\s+|\n+/).filter((s) => s.length >= 40)) assert.ok(!vaultText.includes(piece), piece.slice(0, 40));
    }
  });

  it('scrubs book text before storing it; scripts, styles, and head never reach refs.db', () => {
    const stored = allChunkTexts(e).join('\n');
    for (const s of fx.secrets) assert.ok(!stored.includes(s));
    assert.match(stored, /\[REDACTED:github-token\]/);
    for (const m of DROPPED_MARKERS) assert.ok(!stored.includes(m), m);
  });

  it('a known phrase returns the right chapter citation and label', async () => {
    const t = tools(e);
    try {
      for (const { phrase, chapter, heading } of ALICE_PHRASES) {
        const r = await t.call('search', { query: phrase, scope: 'refs' });
        assert.ok(!r.isError, r.content[0]!.text);
        const rows = results(r);
        assert.ok(rows.length >= 1, phrase);
        const top = rows[0]!;
        assert.equal(top['source'], 'ref');
        assert.equal(top['chapter'], chapter, phrase);
        assert.equal(top['label'], `${ALICE_TITLE}, Chapter ${chapter} (${heading})`);
        assert.match(String(top['citation']), new RegExp(`^ref:${refId}/${chapter}/\\d+$`));
        const parsed = parseCitation(top['citation']);
        assert.ok(parsed.ok && parsed.citation.kind === 'ref');
        assert.equal(top['book_author'], ALICE_AUTHOR);
        assert.ok(String(header(r)['notice']).includes(REFS_NOTICE));
      }
    } finally {
      t.close();
    }
  });

  it('scopes: notes excludes books, refs excludes notes, all lists notes first then books, raw only raw', async () => {
    const t = tools(e);
    try {
      const notes = results(await t.call('search', { query: 'Caucus-race' }));
      assert.deepEqual(notes.map((x) => x['source'] ?? 'note'), ['note']);
      const refsOnly = results(await t.call('search', { query: 'Caucus-race', scope: 'refs' }));
      assert.ok(refsOnly.length >= 1 && refsOnly.every((x) => x['source'] === 'ref'));
      const all = results(await t.call('search', { query: 'Caucus-race', scope: 'all' }));
      assert.deepEqual(all.map((x) => x['source'] ?? 'note'), ['note', ...refsOnly.map(() => 'ref')]);
      assert.equal(results(await t.call('search', { query: 'Caucus-race', scope: 'raw' })).length, 0);
      assert.equal((await t.call('search', { query: 'x', scope: 'books' })).isError, true);
    } finally {
      t.close();
    }
  });

  it('never returns more than the configured excerpt and hit limits', async () => {
    const t = tools(e);
    try {
      for (const scope of ['refs', 'all']) {
        for (const format of ['full', 'compact']) {
          const rows = results(await t.call('search', { query: 'Alice', scope, format, limit: 50 })).filter((x) => x['source'] === 'ref');
          assert.ok(rows.length >= 1 && rows.length <= 5, `${scope}/${format}: ${rows.length}`);
          for (const x of rows) assert.ok(String(x['excerpt']).length <= (format === 'compact' ? 200 : 400));
        }
      }
      assert.equal(results(await t.call('search', { query: 'Alice', scope: 'refs', limit: 1 })).length, 1);
    } finally {
      t.close();
    }
    const tight = tools(e, { excerptChars: 30, maxHits: 2 });
    try {
      const rows = results(await tight.call('search', { query: 'Alice', scope: 'refs' }));
      assert.equal(rows.length, 2);
      for (const x of rows) assert.ok(String(x['excerpt']).length <= 30);
    } finally {
      tight.close();
    }
  });

  it('read_ref_chunk returns one fenced chunk, honors the size cap, navigates, and rejects out-of-range ids', async () => {
    const t = tools(e);
    try {
      const r = await t.call('read_ref_chunk', { ref_id: refId, chapter: 1, ordinal: 0 });
      assert.ok(!r.isError);
      const text = r.content[0]!.text;
      assert.ok(text.includes(FENCE_LABEL));
      assert.ok(text.includes('without pictures or conversations'));
      assert.ok(!text.includes('Curiouser'), 'only one chunk');
      const meta = JSON.parse(text.split('\n').find((l) => l.startsWith('{"source"'))!) as Record<string, unknown>;
      assert.equal(meta['citation'], `ref:${refId}/1/0`);
      assert.equal(meta['prev'], null);
      assert.equal(meta['next'], `ref:${refId}/1/1`);
      const last = await t.call('read_ref_chunk', { ref_id: refId, chapter: 3, ordinal: 0 });
      assert.match(last.content[0]!.text, /"next":null/);
      const capped = await t.call('read_ref_chunk', { ref_id: refId, chapter: 1, ordinal: 0, max_chars: 300 });
      assert.ok(!capped.isError);
      assert.ok(capped.content.reduce((n, c) => n + c.text.length, 0) <= 300);
      for (const bad of [
        { ref_id: refId, chapter: 99, ordinal: 0 }, { ref_id: refId, chapter: 1, ordinal: 99 }, { ref_id: refIdOf('0'.repeat(64)), chapter: 1, ordinal: 0 },
        { ref_id: refId, chapter: 0, ordinal: 0 }, { ref_id: refId, chapter: 1, ordinal: -1 }, { ref_id: 'ref_xyz', chapter: 1, ordinal: 0 },
        { ref_id: refId, chapter: '1', ordinal: 0 }, { ref_id: refId, chapter: 1 },
      ]) {
        const res = await t.call('read_ref_chunk', bad as Record<string, unknown>);
        assert.equal(res.isError, true, JSON.stringify(bad));
      }
    } finally {
      t.close();
    }
  });

  it('read_ref_chunk is registered in every mode', () => {
    const registry = new ToolRegistry();
    registerRefTools(refsEnv(e), registry);
    for (const mode of ['inbox', 'journal', 'read-only'] as const) assert.deepEqual(listTools(mode, registry).map((x) => x.name), ['read_ref_chunk']);
  });

  it('re-adding the same file (or a copy with the same hash) is a no-op', async () => {
    const dbBefore = fileSum(path.join(e.stateDir, 'refs.db'));
    const vaultBefore = treeChecksum(e.vault);
    for (const f of [fx.epub, fx.epubCopy]) {
      const r = await refs(e, 'add', f, '--title', 'Another Title');
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /already in the library/);
    }
    assert.equal(fileSum(path.join(e.stateDir, 'refs.db')), dbBefore);
    assert.equal(treeChecksum(e.vault), vaultBefore);
  });

  it('reindex --full after deleting index.db leaves refs.db intact', async () => {
    const before = fileSum(path.join(e.stateDir, 'refs.db'));
    fs.rmSync(path.join(e.stateDir, 'index.db'), { force: true });
    for (const f of ['index.db-wal', 'index.db-shm']) fs.rmSync(path.join(e.stateDir, f), { force: true });
    const r = await runReindex(['--full'], { env: e.env, homeDir: e.base });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fileSum(path.join(e.stateDir, 'refs.db')), before);
  });
});

describe('refs list, remove, and reindex', () => {
  it('deleting refs.db and running refs reindex restores it (from the vault notes)', async () => {
    const e = makeEnv();
    const id = await addOk(e, fx.epub);
    await addOk(e, fx.md);
    const t = tools(e);
    const before = results(await t.call('search', { query: 'Curiouser', scope: 'refs' }));
    fs.rmSync(path.join(e.stateDir, 'refs.db'));
    assert.equal(results(await t.call('search', { query: 'Curiouser', scope: 'refs' })).length, 0);
    const r = await refs(e, 'reindex');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /refs reindex: 2 rebuilt, 0 missing, 0 changed, 0 failed/);
    const after = results(await t.call('search', { query: 'Curiouser', scope: 'refs' }));
    assert.deepEqual(after.map((x) => x['citation']), before.map((x) => x['citation']));
    assert.equal(after[0]!['citation'], `ref:${id}/2/0`);
    t.close();
    const list = await refs(e, 'list');
    assert.match(list.stdout, new RegExp(`${id}  "${ALICE_TITLE}" by "${ALICE_AUTHOR}"`));
    assert.match(list.stdout, /2 references/);
  });

  it('moved sources are reported missing; their rows are kept', async () => {
    const e = makeEnv();
    const dir = realTmpDir('ebrain-p11-src-');
    bases.push(dir);
    const src = path.join(dir, 'book.txt');
    fs.copyFileSync(fx.txt, src);
    const id = await addOk(e, src);
    fs.renameSync(src, path.join(dir, 'moved.txt'));
    const r = await refs(e, 'reindex');
    assert.equal(r.code, 1);
    assert.match(r.stdout, new RegExp(`missing ${id}: source not found at ${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.stdout, /0 rebuilt, 1 missing/);
    assert.equal(allChunkTexts(e).length > 0, true);
    fs.writeFileSync(src, 'different content\n');
    const changed = await refs(e, 'reindex');
    assert.match(changed.stdout, /changed ref_/);
  });

  it('refs remove deletes the index rows, keeps the vault note, and reindex does not bring it back', async () => {
    const e = makeEnv();
    const id = await addOk(e, fx.txt);
    const note = path.join(e.vault, 'references', 'textbook.md');
    const noteBefore = fileSum(note);
    const r = await refs(e, 'remove', id);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /your note references\/textbook\.md was left in place/);
    assert.equal(fileSum(note), noteBefore);
    assert.equal(allChunkTexts(e).length, 0);
    const re = await refs(e, 'reindex');
    assert.match(re.stdout, /0 rebuilt.*1 removed \(not restored\)/);
    assert.equal(allChunkTexts(e).length, 0);
    assert.equal((await refs(e, 'remove', id)).code, 1);
    assert.equal((await refs(e, 'remove', 'not-an-id')).code, 1);
    // Adding it again brings it back (same id) and keeps the owner's note as is.
    assert.equal(await addOk(e, fx.txt), id);
    assert.equal(fileSum(note), noteBefore);
  });

  it('the owner note is never overwritten; a different book with the same title gets its own note', async () => {
    const e = makeEnv();
    const id = await addOk(e, fx.md);
    const note = path.join(e.vault, 'references', 'the-markdown-manual.md');
    fs.appendFileSync(note, '\nMy own thoughts.\n');
    const owned = fileSum(note);
    fs.rmSync(path.join(e.stateDir, 'refs.db'));
    assert.equal(await addOk(e, fx.md), id);
    assert.equal(fileSum(note), owned);
    const other = path.join(e.base, 'other.md');
    fs.writeFileSync(other, '# The Markdown Manual\n\nA different edition.\n');
    const id2 = await addOk(e, other);
    assert.notEqual(id2, id);
    assert.ok(fs.existsSync(path.join(e.vault, 'references', `the-markdown-manual-${id2.slice(4, 12)}.md`)));
  });
});

describe('formats', () => {
  it('Markdown and text books ingest with chapter headings; --title/--author override', async () => {
    const e = makeEnv();
    const md = await addOk(e, fx.md);
    const txt = await addOk(e, fx.txt, '--title', 'Text Book', '--author', 'A. Writer');
    const t = tools(e);
    try {
      const a = results(await t.call('search', { query: 'wombatmarker', scope: 'refs' }))[0]!;
      assert.equal(a['label'], 'The Markdown Manual, Chapter 3 (Going Further)');
      assert.equal(a['citation'], `ref:${md}/3/0`);
      const b = results(await t.call('search', { query: 'echidnamarker', scope: 'refs' }))[0]!;
      assert.equal(b['label'], 'Text Book, Chapter 3 (CHAPTER II. The End)');
      assert.equal(b['book_author'], 'A. Writer');
      assert.equal(b['citation'], `ref:${txt}/3/0`);
    } finally {
      t.close();
    }
  });

  it('refuses unsupported types and missing files', async () => {
    const e = makeEnv();
    const doc = path.join(e.base, 'book.docx');
    fs.writeFileSync(doc, 'x');
    const r = await refs(e, 'add', doc);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unsupported file type/);
    assert.equal((await refs(e, 'add', path.join(e.base, 'nope.epub'))).code, 1);
    assert.equal((await refs(e, 'add')).code, 2);
    assert.equal((await refs(e, 'add', fx.md, '--bogus')).code, 2);
  });

  it('PDF: rejected with a clear message when pdftotext is absent; converted through it (argument array, timeout, size cap) when present', async () => {
    const e = makeEnv();
    const empty = realTmpDir('ebrain-p11-nobin-');
    bases.push(empty);
    const absent = await runRefs(['add', fx.pdf], { env: e.env, homeDir: e.base, pdf: { env: { PATH: empty } } });
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /pdftotext.*not found/);

    const bin = realTmpDir('ebrain-p11-bin-');
    bases.push(bin);
    const argsLog = path.join(bin, 'args.log');
    fs.writeFileSync(path.join(bin, 'pdftotext'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argsLog}'; done\n` +
      "printf 'CHAPTER 1 Start\\n\\nThe narwhalmarker swims.\\f\\nCHAPTER 2 Next\\n\\nThe belugamarker sings.\\n'\n", { mode: 0o755 });
    const ok = await runRefs(['add', fx.pdf], { env: e.env, homeDir: e.base, pdf: { env: { PATH: bin } } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(fs.readFileSync(argsLog, 'utf8').trim().split('\n'), ['-enc', 'UTF-8', '-q', fx.pdf, '-']);
    const t = tools(e);
    const hit = results(await t.call('search', { query: 'belugamarker', scope: 'refs' }))[0]!;
    assert.equal(hit['label'], 'scan, Chapter 2 (CHAPTER 2 Next)');
    t.close();

    fs.writeFileSync(path.join(bin, 'pdftotext'), '#!/bin/sh\n/bin/sleep 5\n', { mode: 0o755 });
    const other = path.join(e.base, 'slow.pdf');
    fs.writeFileSync(other, '%PDF slow');
    const slow = await runRefs(['add', other], { env: e.env, homeDir: e.base, pdf: { env: { PATH: bin }, timeoutMs: 200 } });
    assert.equal(slow.code, 1);
    assert.match(slow.stderr, /did not finish/);
    fs.writeFileSync(path.join(bin, 'pdftotext'), "#!/bin/sh\n/usr/bin/head -c 100000 /dev/zero | /usr/bin/tr '\\0' 'a'\n", { mode: 0o755 });
    const big = await runRefs(['add', other], { env: e.env, homeDir: e.base, pdf: { env: { PATH: bin }, maxBytes: 1000 } });
    assert.equal(big.code, 1);
    assert.match(big.stderr, /exceeds 1000 bytes/);
  });
});

describe('hostile EPUBs', () => {
  it('zip-slip and huge entries are rejected; nothing is written to the vault, the state dir, or next to the source', async () => {
    const e = makeEnv();
    await addOk(e, fx.md);
    const vaultBefore = treeChecksum(e.vault);
    const stateBefore = fileSum(path.join(e.stateDir, 'refs.db'));
    const fxDir = path.dirname(fx.epub);
    const fxBefore = treeChecksum(fxDir);
    for (const [file, code] of [[fx.hostile.zipSlip, 'entry-name'], [fx.hostile.huge, 'entry-size']] as const) {
      const r = await refs(e, 'add', file);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`archive rejected \\(${code}\\)`));
    }
    const small = path.join(e.base, 'big-real.epub');
    fs.writeFileSync(small, aliceEpub({ extra: [{ name: 'OEBPS/text/big.xhtml', data: Buffer.alloc(20000, 0x61) }] }));
    const limited = await runRefs(['add', small], { env: e.env, homeDir: e.base, zipLimits: { maxEntries: 100, maxEntryBytes: 10000, maxTotalBytes: 1e6 } });
    assert.match(limited.stderr, /archive rejected \(entry-size\)/);
    assert.equal(treeChecksum(e.vault), vaultBefore);
    assert.equal(fileSum(path.join(e.stateDir, 'refs.db')), stateBefore);
    assert.equal(treeChecksum(fxDir), fxBefore);
    assert.ok(!fs.existsSync(path.join(path.dirname(fxDir), 'evil.xhtml')));
    assert.ok(!fs.existsSync(path.join(e.base, 'evil.xhtml')));
  });

  it('XHTML referencing external URLs ingests without any network request', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const e = makeEnv();
      const file = path.join(e.base, 'external.epub');
      fs.writeFileSync(file, aliceEpub({ externalBase: `http://127.0.0.1:${port}` }));
      const id = await addOk(e, file);
      const stored = allChunkTexts(e).join('\n');
      assert.ok(!stored.includes('127.0.0.1') && !stored.includes('http'));
      assert.match(stored, /an illustration/);
      const t = tools(e);
      await t.call('search', { query: 'illustration', scope: 'refs' });
      await t.call('read_ref_chunk', { ref_id: id, chapter: 1, ordinal: 0 });
      t.close();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(requests, 0);
    } finally {
      server.close();
    }
  });
});

describe('config: refs limits', () => {
  it('defaults to 400 characters and 5 hits; validates bounds', () => {
    const base = { vaultPath: '/v', stateDir: '/s', principal: { id: 'a', type: 'human' }, mode: 'inbox' };
    assert.deepEqual(parseConfig(base).refs, { excerptChars: 400, maxHits: 5 });
    assert.deepEqual(parseConfig({ ...base, refs: { excerptChars: 100, maxHits: 2 } }).refs, { excerptChars: 100, maxHits: 2 });
    for (const bad of [{ excerptChars: 0 }, { maxHits: 21 }, { excerptChars: 1.5 }, { other: 1 }]) {
      assert.throws(() => parseConfig({ ...base, refs: bad }), JSON.stringify(bad));
    }
  });
});
