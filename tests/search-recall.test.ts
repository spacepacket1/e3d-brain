// Search recall: natural-language queries must find notes. Plain queries drop filler words and match word stems
// ("accept proposal" finds "accepts proposals"); when no visible note has every word the search retries with any word
// matching and says so (match_mode: any_term). Existing indexes (older schema, no stemmer) rebuild by themselves.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openIndexDb } from '../src/index/db.js';
import { ftsQuery, ftsQueryAny, searchTerms } from '../src/index/query.js';
import { resolveInState } from '../src/safe-path.js';
import { realTmpDir, repoRoot, rmrf } from './helpers.js';
import { header, McpProcess, results, type ToolResponse } from './mcp-client.js';

const cli = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');

describe('search terms (unit)', () => {
  it('drops stopwords and duplicates, keeps case and order', () => {
    assert.deepEqual(searchTerms('Who accepts the Proposals? proposals!'), ['accepts', 'Proposals']);
    assert.equal(ftsQuery('Who accepts the Proposals?'), '"accepts" "Proposals"');
  });
  it('keeps stopwords when nothing else is left, and is undefined for no words', () => {
    assert.deepEqual(searchTerms('who is the'), ['who', 'is', 'the']);
    assert.equal(ftsQuery('?!'), undefined);
  });
  it('the looser form needs at least two words and ORs them', () => {
    assert.equal(ftsQueryAny('memory banana'), '"memory" OR "banana"');
    assert.equal(ftsQueryAny('memory'), undefined);
    assert.equal(ftsQueryAny('who memory'), undefined, 'one content word is not a looser query');
  });
  it('FTS syntax in text stays inert', () => {
    // every word is a quoted term, so NEAR/OR/* cannot act as operators ("OR" is a filler word and is dropped)
    assert.equal(ftsQuery('a OR "b" NEAR c*'), '"b" "NEAR" "c"');
  });
});

describe('search recall (integration)', () => {
  let base: string;
  let config: string;
  let stateDir: string;
  let m: McpProcess;

  before(async () => {
    base = realTmpDir('ebrain-recall-');
    const vault = path.join(base, 'vault');
    fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(vault, '_inbox'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'notes', 'Accepting.md'),
      '# Reviewing proposals\n\nA person reads proposals, then accepts or rejects them. Nothing becomes memory until a human says yes.\n');
    fs.writeFileSync(path.join(vault, 'notes', 'Advisory.md'),
      '# Advisory memory\n\nMemory is advisory and never approves spending or signing.\n');
    fs.writeFileSync(path.join(vault, 'notes', 'Pasta.md'), '# Dinner\n\nBoil water, add salt, cook the pasta.\n');
    stateDir = path.join(base, 'state');
    config = path.join(base, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ vaultPath: vault, stateDir, principal: { id: 'tester', type: 'human' }, mode: 'inbox' }), { mode: 0o600 });
    fs.chmodSync(config, 0o600);
    m = new McpProcess(config);
    await m.initialize();
  });
  after(async () => {
    await m.close();
    rmrf(base);
  });

  const paths = (r: ToolResponse) => results(r).map((x) => x['path']);
  const mode = (r: ToolResponse) => header(r)['match_mode'];

  it('matches word stems: "accept proposal" finds "accepts proposals"', async () => {
    const r = await m.call('search', { query: 'accept proposal' });
    assert.ok(paths(r).includes('notes/Accepting.md'));
    assert.equal(mode(r), undefined, 'a strict match carries no match_mode');
  });

  it('ignores filler words: "who accepts proposals" and "what is this memory for"', async () => {
    const a = await m.call('search', { query: 'who accepts proposals' });
    assert.deepEqual(paths(a)[0], 'notes/Accepting.md');
    assert.equal(mode(a), undefined);
    const b = await m.call('search', { query: 'what is advisory memory about' });
    assert.ok(paths(b).includes('notes/Advisory.md'));
  });

  it('falls back to any-word matching and says so', async () => {
    const r = await m.call('search', { query: 'advisory banana' });
    assert.ok(paths(r).includes('notes/Advisory.md'), 'one matching word is enough once nothing matches all of them');
    assert.equal(mode(r), 'any_term');
  });

  it('a strict match is preferred: the fallback does not run when something matches every word', async () => {
    const r = await m.call('search', { query: 'pasta salt' });
    assert.deepEqual(paths(r), ['notes/Pasta.md']);
    assert.equal(mode(r), undefined);
  });

  it('no match at all stays empty and sets no match_mode', async () => {
    const r = await m.call('search', { query: 'zzzzqq xxxxww' });
    assert.deepEqual(paths(r), []);
    assert.equal(mode(r), undefined);
  });

  it('a query of only stopwords does not error', async () => {
    const r = await m.call('search', { query: 'who is the' });
    assert.ok(!r.isError);
  });

  it('advanced: true is untouched: raw FTS5, no fallback', async () => {
    const r = await m.call('search', { query: 'advisory OR banana', advanced: true });
    assert.deepEqual(paths(r), ['notes/Advisory.md']);
    const none = await m.call('search', { query: 'advisory banana', advanced: true });
    assert.deepEqual(paths(none), [], 'advanced AND semantics: no fallback');
    assert.equal(mode(none), undefined);
  });

  it('ordering is deterministic across repeated calls', async () => {
    const a = paths(await m.call('search', { query: 'memory proposals human' }));
    const b = paths(await m.call('search', { query: 'memory proposals human' }));
    assert.deepEqual(a, b);
  });

  it('an index built with the old tokenizer rebuilds itself and then stems', async () => {
    await m.close();
    const sdir = resolveInState(stateDir, '');
    const db = openIndexDb(sdir, { mustExist: true });
    db.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
    db.exec('DROP TABLE chunks_fts');
    db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')");
    db.close();
    const re = spawnSync(process.execPath, [cli(), 'reindex'], { env: { PATH: process.env.PATH ?? '', HOME: base, EBRAIN_CONFIG: config }, encoding: 'utf8' });
    assert.equal(re.status, 0, re.stderr);
    const check = openIndexDb(sdir, { mustExist: true });
    const sql = (check.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get() as { sql: string }).sql;
    check.close();
    assert.match(sql, /porter/);
    m = new McpProcess(config);
    await m.initialize();
    assert.ok(paths(await m.call('search', { query: 'accept proposal' })).includes('notes/Accepting.md'));
  });
});
