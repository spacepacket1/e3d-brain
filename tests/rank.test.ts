// Phase 4: the one ranking function (I13). effectiveTier over synthetic index
// rows, the exact tier table order, quantized ties, deterministic
// tie-breaks, and a scan that no other module orders results.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { effectiveTier, quantize, rank, TIER_TABLE, tierOf, type RankItem } from '../src/index/rank.js';
import { folderClass, type FolderClass } from '../src/vault/names.js';
import { STATUSES } from '../src/vault/parse.js';
import { prng, repoRoot } from './helpers.js';

const CITED = ['commit:abc1234'];

describe('tier table', () => {
  it('has the exact documented order', () => {
    assert.deepEqual(
      TIER_TABLE.map((t) => [t.tier, t.name, t.registered]),
      [
        [1, 'curated', 4],
        [2, 'inbox', 8],
        [3, 'cited journal lesson', 9],
        [4, 'uncited journal lesson', 9],
        [5, 'other journal', 9],
        [6, 'raw', 10],
        [7, 'stale', 4],
        [8, 'unknown', 4],
      ],
    );
  });

  it('docs/RANKING.md documents the same table', () => {
    const doc = fs.readFileSync(path.join(repoRoot(), 'docs', 'RANKING.md'), 'utf8');
    const rows = [...doc.matchAll(/^\| T(\d) ([^|]+?) \|/gm)].map((m) => [Number(m[1]), m[2]!.trim()]);
    assert.deepEqual(rows, TIER_TABLE.map((t) => [t.tier, t.name]));
  });
});

describe('effectiveTier', () => {
  const classes: FolderClass[] = ['curated', 'reference', 'inbox', 'journal', 'raw', 'archive'];

  it('is total over folder class x status (known, unknown, absent)', () => {
    for (const fc of classes) {
      for (const st of [...STATUSES, 'someday', '', 'Accepted', null, undefined]) {
        const t = effectiveTier(fc, st);
        assert.ok(t === 'hidden' || (Number.isInteger(t) && t >= 1 && t <= 8), `${fc}/${String(st)} -> ${String(t)}`);
      }
    }
  });

  it('step 1: hidden statuses and archive folders are hidden', () => {
    for (const fc of classes) for (const st of ['rejected', 'superseded', 'archived']) assert.equal(effectiveTier(fc, st), 'hidden');
    for (const st of [...STATUSES, 'someday', undefined]) assert.equal(effectiveTier('archive', st), 'hidden');
    for (const p of ['_inbox/_rejected/a.md', '_inbox/_applied/a.md', '_archive/a.md', 'journal/_archive/bot/a.md']) {
      const info = folderClass(p);
      assert.equal(effectiveTier(info.folderClass, 'proposed', { folderHidden: info.hidden }), 'hidden', p);
    }
  });

  it('step 2: unknown status is T8 in every visible folder class', () => {
    for (const fc of classes.filter((c) => c !== 'archive')) {
      assert.equal(effectiveTier(fc, 'someday'), 8);
      assert.equal(effectiveTier(fc, 'Accepted'), 8);
      assert.equal(effectiveTier(fc, ''), 8);
      // The index's status_known=0 wins even when the stringified text looks known.
      assert.equal(effectiveTier(fc, 'accepted', { statusKnown: false }), 8);
    }
  });

  it('step 3: stale is T7 in every visible folder class', () => {
    for (const fc of classes.filter((c) => c !== 'archive')) assert.equal(effectiveTier(fc, 'stale'), 7);
  });

  it('step 4: by folder class', () => {
    assert.equal(effectiveTier('curated', undefined), 1);
    assert.equal(effectiveTier('curated', 'accepted'), 1);
    assert.equal(effectiveTier('reference', null), 1);
    // Moved out of _inbox/ by hand: curated whatever the status says.
    assert.equal(effectiveTier('curated', 'proposed'), 1);
    assert.equal(effectiveTier('curated', 'journal'), 1);
    assert.equal(effectiveTier('curated', 'accepted', { kind: 'lesson' }), 1);
    assert.equal(effectiveTier('inbox', 'proposed'), 2);
    // An inbox note claiming accepted is still inbox tier.
    assert.equal(effectiveTier('inbox', 'accepted'), 2);
    assert.equal(effectiveTier('journal', 'journal', { kind: 'lesson', sources: CITED }), 3);
    assert.equal(effectiveTier('journal', 'journal', { kind: 'lesson', sources: ['not a citation', 'commit:abc'] }), 4);
    assert.equal(effectiveTier('journal', 'journal', { kind: 'lesson', sources: [] }), 4);
    assert.equal(effectiveTier('journal', 'journal', { kind: 'lesson' }), 4);
    assert.equal(effectiveTier('journal', 'journal', { kind: 'observation', sources: CITED }), 5);
    assert.equal(effectiveTier('journal', undefined), 5);
    assert.equal(effectiveTier('raw', undefined), 6);
    assert.equal(effectiveTier('raw', 'accepted'), 6);
  });
});

function item(p: Partial<RankItem> & { path: string }): RankItem {
  return { folderClass: 'curated', ...p };
}

describe('rank', () => {
  // One synthetic index row per tier, deliberately listed in reverse.
  const perTier: RankItem[] = [
    item({ path: 'u.md', status: 'someday', bm25: -50 }),
    item({ path: 's.md', status: 'stale', bm25: -50 }),
    item({ path: '_raw/r.md', folderClass: 'raw', bm25: -50 }),
    item({ path: 'journal/b/o.md', folderClass: 'journal', status: 'journal', kind: 'log', bm25: -50 }),
    item({ path: 'journal/b/l.md', folderClass: 'journal', status: 'journal', kind: 'lesson', bm25: -50 }),
    item({ path: 'journal/b/c.md', folderClass: 'journal', status: 'journal', kind: 'lesson', sources: CITED, bm25: -50 }),
    item({ path: '_inbox/i.md', folderClass: 'inbox', status: 'proposed', bm25: -50 }),
    item({ path: 'c.md', status: 'accepted', bm25: -0.1 }),
  ];

  it('orders by tier before relevance', () => {
    const out = rank(perTier);
    assert.deepEqual(out.map((r) => r.tier), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(out[0]!.item.path, 'c.md', 'a weak T1 match beats a strong T2 match');
  });

  it('drops hidden notes by default; includeHidden puts them after T8', () => {
    const hidden = [
      item({ path: 'h1.md', status: 'superseded', bm25: -99 }),
      item({ path: '_archive/h2.md', folderClass: 'archive', bm25: -99 }),
      item({ path: '_inbox/_rejected/h3.md', folderClass: 'inbox', folderHidden: true, status: 'rejected', bm25: -99 }),
    ];
    assert.equal(rank([...hidden, ...perTier]).length, perTier.length);
    const all = rank([...hidden, ...perTier], { includeHidden: true });
    assert.deepEqual(all.slice(-3).map((r) => r.tier), ['hidden', 'hidden', 'hidden']);
    assert.deepEqual(all.slice(-3).map((r) => r.item.path), ['_archive/h2.md', '_inbox/_rejected/h3.md', 'h1.md']);
  });

  it('within a tier: lower bm25 first, quantized to 1e-6, then path, then ordinal', () => {
    const rows = [
      item({ path: 'b.md', ordinal: 0, bm25: -2.0000004 }),
      item({ path: 'a.md', ordinal: 3, bm25: -2.0000001 }),
      item({ path: 'a.md', ordinal: 1, bm25: -1.9999996 }),
      item({ path: 'z.md', ordinal: 0, bm25: -3 }),
      item({ path: 'c.md', ordinal: 0, bm25: -2.000002 }),
    ];
    // -2.0000004, -2.0000001, -1.9999996 all quantize to -2000000: a tie broken by path then ordinal.
    assert.deepEqual(
      rank(rows).map((r) => `${r.item.path}#${r.item.ordinal}`),
      ['z.md#0', 'c.md#0', 'a.md#1', 'a.md#3', 'b.md#0'],
    );
    assert.equal(quantize(-2.0000004), quantize(-1.9999996));
    assert.notEqual(quantize(-2.000002), quantize(-2));
    assert.equal(Object.is(quantize(-1e-9), 0), true, 'no negative zero');
    assert.equal(quantize(Number.NaN), Number.POSITIVE_INFINITY);
  });

  it('path tie-break is bytewise on NFC, independent of input order', () => {
    const paths = ['b.md', 'B.md', 'a.md', 'Z.md', 'é.md', 'e\u0301x.md', 'データ.md', '_x.md'];
    const rows = paths.map((p) => item({ path: p, bm25: -1 }));
    const expected = rank(rows).map((r) => r.item.path);
    assert.deepEqual(expected, ['B.md', 'Z.md', '_x.md', 'a.md', 'b.md', 'é.md', 'e\u0301x.md', 'データ.md']);
    const rand = prng(13);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...rows].sort(() => rand() - 0.5);
      assert.deepEqual(rank(shuffled).map((r) => r.item.path), expected);
    }
  });

  it('listings without relevance order by tier then path', () => {
    const out = rank([item({ path: 'b.md' }), item({ path: 's.md', status: 'stale' }), item({ path: 'a.md' })]);
    assert.deepEqual(out.map((r) => r.item.path), ['a.md', 'b.md', 's.md']);
  });

  it('reference books come after every note tier and are ordered among themselves', () => {
    const refs = [
      item({ path: 'ref:book2/ch1', source: 'ref', bm25: -9 }),
      item({ path: 'ref:book1/ch1', source: 'ref', bm25: -1 }),
      item({ path: 'ref:book1/ch0', source: 'ref', bm25: -1 }),
    ];
    const out = rank([...refs, ...perTier]);
    assert.deepEqual(out.slice(-3).map((r) => r.item.path), ['ref:book2/ch1', 'ref:book1/ch0', 'ref:book1/ch1']);
    assert.equal(tierOf(refs[0]!), 1);
    assert.deepEqual(out.slice(0, 8).map((r) => r.tier), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not modify its input', () => {
    const input = [...perTier];
    rank(input);
    assert.deepEqual(input, perTier);
  });
});

// I13 scan: only src/index/rank.ts orders results. Sorting elsewhere is
// allowed only in the modules below, for canonical (non-relevance) orders,
// and never in src/mcp/. No module but rank.ts may ORDER BY relevance.
const ORDER_ALLOWED: Record<string, string> = {
  'src/vault/names.ts': 'collision groups in listing order',
  'src/vault/scan.ts': 'scanner output in listing order',
  'src/vault/parse.ts': 'canonical frontmatter key and tag order',
  'src/index/dump.ts': 'canonical dump order',
  'src/index/identity.ts': 'identity passes in listing order',
  'src/index/resolve.ts': 'link resolution candidate choice',
  'src/index/query.ts': 'match candidates in listing order (unranked)',
  'src/audit/audit.ts': 'audit segments in numeric order',
  'src/scrub/detectors.ts': 'scrub spans in text-offset order; literals longest first',
  'src/journal/import.ts': 'workspace daily-note files in name (date) order',
  'src/import/sources.ts': 'ChatGPT thread walked leaf-to-root, then reversed to conversation order',
  'src/import/load.ts': 'source files in name order (deterministic turn order)',
  'src/import/archive.ts': 'conversations by id and archive year dirs in name order; turn times for start/end',
  'src/index/vectors.ts': 'embedding sync visits missing chunks in listing order (selection and fusion live in rank.ts)',
  'src/refs/db.ts': 'refs list in title order; chunk navigation in (chapter, ordinal) reading order',
  'src/refs/library.ts': 'refs reindex candidates in ref id order',
  'src/propose/archive-reader.ts': 'archive notes in path order (deterministic provider request order)',
};
const ORDER_PATTERNS = [/\.sort\s*\(/, /\.toSorted\s*\(/, /\.reverse\s*\(/, /\.toReversed\s*\(/, /\bORDER\s+BY\b/i];
const RELEVANCE_ORDER = /\bORDER\s+BY\b[^;`'"]*\b(?:bm25|rank|score|relevance)\b/i;

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) srcFiles(full, out);
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

export function findOrderingOffenders(root: string): string[] {
  const offenders: string[] = [];
  for (const file of srcFiles(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === 'src/index/rank.ts') continue;
    const text = fs.readFileSync(file, 'utf8');
    if (RELEVANCE_ORDER.test(text)) offenders.push(`${rel}: orders by relevance`);
    else if (ORDER_PATTERNS.some((re) => re.test(text)) && (rel.startsWith('src/mcp/') || !(rel in ORDER_ALLOWED))) {
      offenders.push(`${rel}: sorts outside rank.ts`);
    }
  }
  return offenders;
}

describe('ordering scan (I13)', () => {
  it('rank.ts is the only module that orders results', () => {
    assert.deepEqual(findOrderingOffenders(repoRoot()), []);
  });

  it('the scan patterns catch the ways to reorder', () => {
    for (const s of ['xs.sort((a, b) => a - b)', 'xs.toSorted()', 'xs.reverse()', 'SELECT * FROM t order by path']) {
      assert.ok(ORDER_PATTERNS.some((re) => re.test(s)), s);
    }
    for (const s of ['SELECT x FROM chunks_fts ORDER BY bm25(chunks_fts)', 'ORDER BY rank', 'order by n.score desc']) {
      assert.ok(RELEVANCE_ORDER.test(s), s);
    }
    assert.ok(!RELEVANCE_ORDER.test('SELECT path FROM notes ORDER BY path_nfc, path'));
  });
});
