// Cognition Phase 3: evidence sources and citation resolution.
//
// - record.ts: the closed JSONL record format (limits checked before parsing,
//   nesting pre-scan, scrub on load, size re-checked after scrubbing).
// - store.ts: discovery (only evidence.sources and *.jsonl in evidence.dir;
//   I1 hostile paths refused), the derived <stateDir>/evidence.db (rebuildable),
//   `ebrain evidence import|stats|reindex`, and no network (I3 spy).
// - cite/resolve.ts: resolved | unresolved | stale | malformed, cached per run.
// - review accept refuses (without marking stale) while a cited thesis/outcome
//   is not in local evidence.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { formatCitation, type NoteLookup } from '../src/cite/citation.js';
import { CitationResolver, resolveCitation } from '../src/cite/resolve.js';
import { runEvidence } from '../src/cli/evidence-commands.js';
import { runReview } from '../src/cli/review-commands.js';
import { runIds } from '../src/cli/undo-commands.js';
import { runJob, type CognitionJob } from '../src/cognition/run.js';
import { ConfigError, parseConfig, type Config } from '../src/config.js';
import {
  jsonDepthExceeds, MAX_ATTRIBUTE_VALUES, MAX_RECORD_DEPTH, normalizeOccurred, parseEvidenceBuffer, parseEvidenceLine, type RecordLimits,
} from '../src/evidence/record.js';
import { memoryEvidenceSource, type EvidenceSource } from '../src/evidence/source.js';
import { discoverEvidence, EvidenceError, evidenceStats, importEvidence, openEvidence, refreshEvidence } from '../src/evidence/store.js';
import { allNoteRows } from '../src/index/query.js';
import { closeIndex, openIndex, refreshIndex } from '../src/index/indexer.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import { mode, realTmpDir, repoRoot, rmrf } from './helpers.js';

const bases: string[] = [];
after(() => bases.forEach(rmrf));

const FIXTURE = path.join(repoRoot(), 'tests', 'fixtures', 'evidence', 'e3d-sample.jsonl');
const SECRET = `sk-${'Ab3'.repeat(16)}`;
const HUMAN: RecordLimits = { maxRecordBytes: 8192, scrub: { principal: { type: 'human' } } };
const AGENT: RecordLimits = { maxRecordBytes: 8192, scrub: { principal: { type: 'agent' } } };

const line = (o: Record<string, unknown>) => JSON.stringify({ kind: 'thesis', id: 'th_1', occurred: '2026-09-01T00:00:00Z', summary: 'text', ...o });

interface Inst {
  base: string;
  vault: string;
  stateDir: SafePath;
  ext: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  config: Config;
}

function setup(evidence: Record<string, unknown> = {}, type: 'human' | 'agent' = 'human'): Inst {
  const base = realTmpDir('ebrain-evidence-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const ext = path.join(base, 'exports');
  fs.mkdirSync(ext);
  const configPath = path.join(base, 'config.json');
  const raw = { vaultPath: vault, stateDir, principal: { id: 'tester', type }, mode: 'inbox', evidence };
  fs.writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return { base, vault, stateDir, ext, configPath, env: { EBRAIN_CONFIG: configPath }, config: parseConfig(raw) };
}

function withSource(name = 'e3d.jsonl', content: string | Buffer = fs.readFileSync(FIXTURE)): Inst {
  const probe = realTmpDir('ebrain-evidence-src-');
  bases.push(probe);
  const file = path.join(probe, name);
  fs.writeFileSync(file, content);
  return setup({ sources: [file] });
}

const envOf = (i: Inst) => ({ config: i.config, stateDir: i.stateDir });

describe('evidence record format', () => {
  it('accepts a valid record, normalizing occurred and sorting attribute keys', () => {
    const r = parseEvidenceLine(line({ attributes: { z: 1, a: 'x', n: null, b: true, arr: [1, 'two'] } }), HUMAN);
    assert.ok(r.ok);
    assert.equal(r.record.occurred, '2026-09-01T00:00:00.000Z');
    assert.deepEqual(Object.keys(r.record.attributes), ['a', 'arr', 'b', 'n', 'z']);
    assert.equal(r.canonical, JSON.stringify(r.record));
    assert.ok(parseEvidenceLine(line({}), HUMAN).ok, 'attributes are optional');
    assert.ok(parseEvidenceLine(`${line({})}\r`, HUMAN).ok, 'a trailing CR is ignored');
  });

  it('rejects malformed records (closed format)', () => {
    const bad = [
      'not json', '[]', '"x"', 'null',
      line({ extra: 1 }), line({ kind: 'Thesis' }), line({ kind: '' }), line({ kind: 'a'.repeat(40) }), line({ id: 'has space' }),
      line({ id: 'x'.repeat(129) }), line({ id: 7 }), line({ occurred: '2026-09-01' }), line({ occurred: '2026-09-01T00:00:00+02:00' }),
      line({ occurred: '2026-02-30T00:00:00Z' }), line({ occurred: '2026-09-01T24:00:00Z' }), line({ summary: '' }), line({ summary: '   ' }),
      line({ summary: 'bell\u0007' }), line({ summary: 5 }), line({ attributes: [] }), line({ attributes: 'x' }),
      line({ attributes: { 'bad-key': 1 } }), line({ attributes: { '': 1 } }), line({}).replace('"summary"', '"attributes":{"a":1e400},"summary"'),
    ];
    for (const b of bad) {
      const r = parseEvidenceLine(b, HUMAN);
      assert.ok(!r.ok && r.reason === 'malformed', b.slice(0, 80));
    }
  });

  it('rejects large records within limits (line, summary, value count, post-scrub size)', () => {
    const big = line({ summary: 'x'.repeat(900), attributes: { pad: 'y'.repeat(8000) } });
    assert.deepEqual(parseEvidenceLine(big, HUMAN), { ok: false, reason: 'too_large' });
    assert.deepEqual(parseEvidenceLine(line({ summary: 'x'.repeat(1001) }), HUMAN), { ok: false, reason: 'too_large' });
    const many = Object.fromEntries(Array.from({ length: MAX_ATTRIBUTE_VALUES + 1 }, (_, i) => [`k${i}`, i]));
    assert.deepEqual(parseEvidenceLine(line({ attributes: many }), { ...HUMAN, maxRecordBytes: 65536 }), { ok: false, reason: 'too_large' });
    // Exactly at the limit is fine; one byte over is not.
    // (The limit applies to the stored, canonical form; this line is already canonical.)
    const canon = (summary: string) => line({ occurred: '2026-09-01T00:00:00.000Z', summary, attributes: {} });
    const fit = canon('x'.repeat(1 + 300 - Buffer.byteLength(canon('x'))));
    assert.equal(Buffer.byteLength(fit), 300);
    assert.ok(parseEvidenceLine(fit, { ...HUMAN, maxRecordBytes: 300 }).ok);
    assert.deepEqual(parseEvidenceLine(fit, { ...HUMAN, maxRecordBytes: 299 }), { ok: false, reason: 'too_large' });
  });

  it('rejects deeply nested records before parsing them', () => {
    assert.ok(parseEvidenceLine(line({ attributes: { a: { b: [1] } } }), HUMAN).ok, 'depth 4 is allowed');
    assert.ok(parseEvidenceLine(line({ attributes: { a: { b: { c: 1 } } } }), HUMAN).ok, 'two levels below attributes');
    assert.deepEqual(parseEvidenceLine(line({ attributes: { a: { b: { c: { d: 1 } } } } }), HUMAN), { ok: false, reason: 'too_deep' });
    assert.deepEqual(parseEvidenceLine(line({ attributes: { a: [[[1]]] } }), HUMAN), { ok: false, reason: 'too_deep' });
    // Hostile nesting far beyond any parser's comfort is refused by the pre-scan, quickly and without a stack overflow.
    const hostile = `{"attributes":${'['.repeat(30000)}${']'.repeat(30000)}}`;
    const t0 = Date.now();
    assert.deepEqual(parseEvidenceLine(hostile, { ...HUMAN, maxRecordBytes: 65536 }), { ok: false, reason: 'too_deep' });
    assert.ok(Date.now() - t0 < 1000);
    // Brackets inside strings do not count; escaped quotes do not end a string.
    assert.equal(jsonDepthExceeds('{"s":"[[[[[[[[\\"[[[["}', MAX_RECORD_DEPTH), false);
    assert.equal(jsonDepthExceeds('[[[[[', MAX_RECORD_DEPTH), true);
  });

  it('scrubs summary and attribute strings on load; strict mode drops a record with a credential', () => {
    const withSecret = line({ summary: `key ${SECRET} leaked`, attributes: { note: `again ${SECRET}`, list: [SECRET] } });
    const r = parseEvidenceLine(withSecret, HUMAN);
    assert.ok(r.ok);
    assert.ok(!r.canonical.includes(SECRET));
    assert.ok(r.findings >= 3);
    assert.deepEqual(parseEvidenceLine(withSecret, AGENT), { ok: false, reason: 'scrub_rejected' });
    // A key the scrubber would rewrite is refused, never rewritten.
    assert.deepEqual(parseEvidenceLine(line({ attributes: { [`k_${'A1b2C3d4'.repeat(6)}`]: 1 } }), { ...HUMAN, scrub: { principal: { type: 'human' }, extraPatterns: ['A1b2C3d4'] } }), { ok: false, reason: 'scrub_rejected' });
  });

  it('normalizes occurred and refuses calendar rollovers', () => {
    assert.equal(normalizeOccurred('2026-09-21T12:30:00.5Z'), '2026-09-21T12:30:00.500Z');
    assert.equal(normalizeOccurred('2028-02-29T00:00:00Z'), '2028-02-29T00:00:00.000Z');
    for (const bad of ['2027-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-01T00:60:00Z', 'yesterday', 20260901]) assert.equal(normalizeOccurred(bad), undefined, String(bad));
  });

  it('parses a buffer line by line: blank lines ignored, bad UTF-8 and over-long lines skipped and counted', () => {
    const good = line({});
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${good}\n\n   \n`), Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from(`${'x'.repeat(10000)}\n${line({ id: 'th_2' })}`),
    ]);
    const seen: string[] = [];
    const c = parseEvidenceBuffer(buf, HUMAN, ({ record, line: n }) => seen.push(`${record.id}@${n}`));
    assert.deepEqual(seen, ['th_1@1', 'th_2@6']);
    assert.equal(c.lines, 4);
    assert.equal(c.records, 2);
    assert.deepEqual(c.skipped, { malformed: 1, too_large: 1, too_deep: 0, scrub_rejected: 0 });
  });
});

describe('evidence config', () => {
  const base = { vaultPath: '/v', stateDir: '/s', principal: { id: 'a', type: 'human' }, mode: 'inbox' };
  it('defaults: dir under the state dir, no sources, 64 MB files, 8192-byte records', () => {
    assert.deepEqual(parseConfig(base).evidence, { dir: '/s/evidence', sources: [], maxFileMB: 64, maxRecordBytes: 8192 });
    assert.deepEqual(parseConfig({ ...base, evidence: { sources: ['~/x/e.jsonl'] } }, { homeDir: '/h' }).evidence.sources, ['/h/x/e.jsonl']);
  });
  it('rejects hostile or overlapping evidence paths and bad limits', () => {
    const bad: Record<string, unknown>[] = [
      { dir: '/v/evidence' }, { dir: '/' }, { dir: '/s' }, { dir: 'relative' }, { dir: '/x/../v' },
      { sources: ['/x/../etc/e.jsonl'] }, { sources: ['/x/./e.jsonl'] }, { sources: ['relative.jsonl'] }, { sources: ['/x/e.json'] },
      { sources: ['/x/.hidden.jsonl'] }, { sources: ['/v/notes/e.jsonl'] }, { sources: ['/s/recalls.jsonl'] }, { sources: ['/x/a.jsonl', '/x/a.jsonl'] },
      { sources: '/x/a.jsonl' }, { sources: [''] }, { maxFileMB: 0 }, { maxFileMB: 2000 }, { maxRecordBytes: 100 }, { maxRecordBytes: 1.5 },
      { maxRecordBytes: 100000 }, { other: 1 },
    ];
    for (const b of bad) assert.throws(() => parseConfig({ ...base, evidence: b }), ConfigError, JSON.stringify(b));
  });
});

describe('evidence store', () => {
  it('the fixture file resolves known ids, returns notfound for unknown ids, and counts skipped lines', () => {
    const i = withSource();
    const ev = openEvidence(envOf(i));
    try {
      assert.deepEqual(ev.kinds(), ['outcome', 'thesis']);
      const th = ev.resolve('thesis', 'th_123');
      assert.ok(th.found);
      assert.equal(th.occurred, '2026-09-01T00:00:00.000Z');
      assert.equal(th.summary, 'ETH outperforms BTC over 3 weeks');
      assert.deepEqual(th.attributes, { agent: '0xabc', status: 'closed' }, 'the later duplicate wins');
      const oc = ev.resolve('outcome', 'oc_456');
      assert.ok(oc.found);
      assert.equal(oc.attributes['result'], 'win');
      assert.deepEqual(ev.resolve('thesis', 'th_999'), { found: false });
      assert.deepEqual(ev.resolve('outcome', 'th_123'), { found: false }, 'kind is part of the key');
      for (const skipped of ['th_bad id', 'th_feb30', 'th_extra', 'th_deep']) assert.deepEqual(ev.resolve('thesis', skipped), { found: false });
      assert.deepEqual(ev.list('thesis').map((r) => r.id), ['th_123', 'th_124']);
      assert.deepEqual(ev.list('outcome', '2026-09-21T00:00:00Z').map((r) => r.id), ['oc_457']);
      assert.deepEqual(ev.list('outcome', new Date('2026-10-01T00:00:00Z')), []);
      assert.throws(() => ev.list('thesis', 'not a date'), RangeError);
    } finally {
      ev.close();
    }
    const s = evidenceStats(envOf(i));
    assert.equal(s.records, 4);
    assert.deepEqual(s.byKind, [{ kind: 'outcome', count: 2 }, { kind: 'thesis', count: 2 }]);
    const f = s.files[0]!;
    assert.equal(f.refused, null);
    assert.equal(f.lines, 10);
    assert.equal(f.records, 5);
    assert.equal(f.duplicates, 1);
    assert.deepEqual(f.skipped, { malformed: 4, too_large: 0, too_deep: 1, scrub_rejected: 0 });
    assert.equal(mode(path.join(i.stateDir, 'evidence.db')), 0o600);
  });

  it('the index is derived: rebuilt when a file changes or evidence.db is deleted, unchanged otherwise', () => {
    const i = withSource();
    assert.equal(refreshEvidence(envOf(i)).rebuilt, true);
    assert.equal(refreshEvidence(envOf(i)).rebuilt, false);
    assert.equal(refreshEvidence(envOf(i), { force: true }).rebuilt, true);
    fs.appendFileSync(i.config.evidence.sources[0]!, `${line({ id: 'th_new' })}\n`);
    const r = refreshEvidence(envOf(i));
    assert.equal(r.rebuilt, true);
    assert.equal(r.records, 5);
    fs.rmSync(path.join(i.stateDir, 'evidence.db'));
    const ev = openEvidence(envOf(i));
    assert.ok(ev.resolve('thesis', 'th_new').found);
    ev.close();
    // A removed source drops its records.
    fs.rmSync(i.config.evidence.sources[0]!);
    const s = evidenceStats(envOf(i));
    assert.equal(s.records, 0);
    assert.equal(s.files[0]!.refused, 'missing');
  });

  it('later files override earlier ones for the same kind and id; the replaced record is counted', () => {
    const i = withSource('a.jsonl', `${line({ id: 'th_1', summary: 'from source' })}\n`);
    fs.mkdirSync(i.config.evidence.dir, { mode: 0o700 });
    fs.writeFileSync(path.join(i.config.evidence.dir, 'b.jsonl'), `${line({ id: 'th_1', summary: 'from dir' })}\n`);
    const ev = openEvidence(envOf(i));
    const r = ev.resolve('thesis', 'th_1');
    assert.ok(r.found && r.summary === 'from dir');
    ev.close();
    const s = evidenceStats(envOf(i));
    assert.deepEqual(s.files.map((f) => [path.basename(f.path), f.origin, f.duplicates]), [['a.jsonl', 'source', 1], ['b.jsonl', 'dir', 0]]);
  });

  it('files larger than evidence.maxFileMB are refused unread', () => {
    const probe = realTmpDir('ebrain-evidence-src-');
    bases.push(probe);
    const file = path.join(probe, 'big.jsonl');
    fs.writeFileSync(file, `${line({ id: 'th_big' })}\n`.repeat(100));
    const i = setup({ sources: [file], maxFileMB: 0.001 });
    const s = evidenceStats(envOf(i));
    assert.equal(s.files[0]!.refused, 'larger than evidence.maxFileMB');
    assert.equal(s.records, 0);
    assert.throws(() => importEvidence(envOf(i), file), /larger than evidence\.maxFileMB/);
  });

  it('scrubs records on load; agent brains drop records with credentials (counted)', () => {
    const content = `${line({ id: 'th_s', summary: `leak ${SECRET}` })}\n${line({ id: 'th_ok' })}\n`;
    const human = withSource('s.jsonl', content);
    const ev = openEvidence(envOf(human));
    const r = ev.resolve('thesis', 'th_s');
    assert.ok(r.found && !r.summary.includes(SECRET));
    ev.close();
    assert.ok(!fs.readFileSync(path.join(human.stateDir, 'evidence.db')).includes(SECRET), 'no secret in evidence.db');

    const probe = realTmpDir('ebrain-evidence-src-');
    bases.push(probe);
    fs.writeFileSync(path.join(probe, 's.jsonl'), content);
    const agent = setup({ sources: [path.join(probe, 's.jsonl')] }, 'agent');
    const s = evidenceStats(envOf(agent));
    assert.equal(s.records, 1);
    assert.equal(s.files[0]!.skipped.scrub_rejected, 1);
  });
});

describe('evidence paths (I1 hostile-path tests)', () => {
  it('never reads outside the configured evidence paths', () => {
    const i = setup();
    const outside = path.join(i.base, 'outside');
    fs.mkdirSync(outside);
    const secretFile = path.join(outside, 'secret.jsonl');
    fs.writeFileSync(secretFile, `${line({ id: 'th_outside' })}\n`);
    fs.writeFileSync(path.join(i.vault, 'notes', 'n.jsonl'), `${line({ id: 'th_vault' })}\n`);
    fs.writeFileSync(path.join(i.stateDir, 'stray.jsonl'), `${line({ id: 'th_state' })}\n`);
    const dir = i.config.evidence.dir;
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'good.jsonl'), `${line({ id: 'th_good' })}\n`);
    fs.symlinkSync(secretFile, path.join(dir, 'link.jsonl'));
    fs.symlinkSync(path.join(dir, 'good.jsonl'), path.join(dir, 'inner-link.jsonl'));
    fs.symlinkSync(path.join(dir, 'missing.jsonl'), path.join(dir, 'dangling.jsonl'));
    fs.mkdirSync(path.join(dir, 'subdir.jsonl'));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'deep.jsonl'), `${line({ id: 'th_nested' })}\n`);
    fs.writeFileSync(path.join(dir, '.hidden.jsonl'), `${line({ id: 'th_hidden' })}\n`);
    fs.writeFileSync(path.join(dir, 'notes.txt'), `${line({ id: 'th_txt' })}\n`);
    // A listed source whose final component is a symlink leaving its own directory.
    const srcDir = path.join(i.base, 'srcdir');
    fs.mkdirSync(srcDir);
    fs.symlinkSync(secretFile, path.join(srcDir, 'escape.jsonl'));
    const raw = JSON.parse(fs.readFileSync(i.configPath, 'utf8'));
    raw.evidence = { sources: [path.join(srcDir, 'escape.jsonl'), path.join(i.base, 'nodir', 'x.jsonl')] };
    const config = parseConfig(raw);

    const files = discoverEvidence(config);
    const byName = Object.fromEntries(files.map((f) => [path.basename(f.path), f.refused ?? 'ok']));
    assert.deepEqual(byName, {
      'escape.jsonl': 'outside its evidence path', 'x.jsonl': 'missing',
      'dangling.jsonl': 'symlink', 'good.jsonl': 'ok', 'inner-link.jsonl': 'symlink', 'link.jsonl': 'symlink', 'subdir.jsonl': 'not a regular file',
    });
    const ev = openEvidence({ config, stateDir: i.stateDir });
    try {
      assert.ok(ev.resolve('thesis', 'th_good').found);
      for (const id of ['th_outside', 'th_vault', 'th_state', 'th_nested', 'th_hidden', 'th_txt']) assert.deepEqual(ev.resolve('thesis', id), { found: false }, id);
    } finally {
      ev.close();
    }
    const stats = runEvidence(['stats'], { env: { EBRAIN_CONFIG: writeConfig(i, raw) } });
    assert.equal(stats.code, 0, stats.stderr);
    assert.match(stats.stdout, /escape\.jsonl {2}\[source\] {2}REFUSED: outside its evidence path/);
    assert.match(stats.stdout, /link\.jsonl {2}\[dir\] {2}REFUSED: symlink/);
  });

  it('a symlinked evidence.dir is resolved once; its entries must still stay inside it', () => {
    const i = setup();
    const real = path.join(i.base, 'real-evidence');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'a.jsonl'), `${line({ id: 'th_a' })}\n`);
    const linkDir = path.join(i.base, 'evidence-link');
    fs.symlinkSync(real, linkDir);
    const raw = JSON.parse(fs.readFileSync(i.configPath, 'utf8'));
    raw.evidence = { dir: linkDir };
    const ev = openEvidence({ config: parseConfig(raw), stateDir: i.stateDir });
    assert.ok(ev.resolve('thesis', 'th_a').found);
    ev.close();
  });

  it('import refuses hostile names and sources and writes only inside evidence.dir', () => {
    const i = setup();
    const src = path.join(i.ext, 'export.jsonl');
    fs.writeFileSync(src, fs.readFileSync(FIXTURE));
    for (const name of ['../x.jsonl', 'a/b.jsonl', '.hidden.jsonl', 'x.json', '/abs.jsonl', 'x\u0000.jsonl', '', '-x.jsonl', `${'a'.repeat(200)}.jsonl`]) {
      assert.throws(() => importEvidence(envOf(i), src, { name }), EvidenceError, JSON.stringify(name));
    }
    const outside = path.join(i.base, 'outside.jsonl');
    fs.writeFileSync(outside, fs.readFileSync(FIXTURE));
    const linkDir = path.join(i.base, 'links');
    fs.mkdirSync(linkDir);
    fs.symlinkSync(outside, path.join(linkDir, 'l.jsonl'));
    fs.symlinkSync(path.join(i.base, 'nowhere'), path.join(linkDir, 'dangling.jsonl'));
    assert.throws(() => importEvidence(envOf(i), path.join(linkDir, 'l.jsonl')), /outside its evidence path/);
    assert.throws(() => importEvidence(envOf(i), path.join(linkDir, 'dangling.jsonl')), EvidenceError);
    assert.throws(() => importEvidence(envOf(i), i.ext, { name: 'dir.jsonl' }), /not a regular file/);
    assert.ok(!fs.existsSync(i.config.evidence.dir), 'nothing was written');
    assert.deepEqual(fs.readdirSync(i.base).sort(), ['config.json', 'exports', 'links', 'outside.jsonl', 'state', 'vault']);
  });
});

function writeConfig(i: Inst, raw: unknown): string {
  const file = path.join(i.base, `config-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

describe('ebrain evidence import|stats|reindex', () => {
  it('import validates, scrubs, and writes atomically (0600) into evidence.dir; stats and reindex report counts', () => {
    const i = setup();
    const src = path.join(i.ext, 'e3d-2026.jsonl');
    fs.writeFileSync(src, `${fs.readFileSync(FIXTURE, 'utf8')}${line({ id: 'th_secret', summary: `k ${SECRET}` })}\n`);
    const r = runEvidence(['import', 'e3d-2026.jsonl'], { env: i.env, cwd: i.ext });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /evidence import: 6 records written to .*e3d-2026\.jsonl\n/);
    assert.match(r.stdout, /11 lines checked, skipped: 4 malformed, 1 too deep, 1 redactions/);
    assert.match(r.stdout, /evidence index: 5 records from 1 files/);
    const dest = path.join(i.config.evidence.dir, 'e3d-2026.jsonl');
    assert.equal(mode(dest), 0o600);
    assert.equal(mode(i.config.evidence.dir), 0o700);
    const written = fs.readFileSync(dest, 'utf8');
    assert.ok(!written.includes(SECRET));
    assert.equal(written.trim().split('\n').length, 6, 'only valid records are written');
    assert.ok(!written.includes('not json'));
    assert.deepEqual(fs.readdirSync(i.config.evidence.dir), ['e3d-2026.jsonl'], 'no temp files left behind');
    assert.ok(!r.stdout.includes('ETH outperforms'), 'output carries counts, not record text');

    // Re-import replaces; --name picks the file name; a file with no valid record is refused.
    const again = runEvidence(['import', src, '--name', 'renamed.jsonl'], { env: i.env });
    assert.equal(again.code, 0, again.stderr);
    assert.ok(fs.existsSync(path.join(i.config.evidence.dir, 'renamed.jsonl')));
    assert.match(runEvidence(['import', src], { env: i.env }).stdout, /replaced the previous file/);
    const junk = path.join(i.ext, 'junk.jsonl');
    fs.writeFileSync(junk, 'nope\n{}\n');
    const refused = runEvidence(['import', junk], { env: i.env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /no valid evidence records \(2 lines checked\); nothing was written/);
    assert.ok(!fs.existsSync(path.join(i.config.evidence.dir, 'junk.jsonl')));

    const s = runEvidence(['stats'], { env: i.env });
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /e3d-2026\.jsonl {2}\[dir\] {2}6 records of 6 lines, 0 skipped, 6 duplicates replaced/, 'replaced by the same records in renamed.jsonl');
    assert.match(s.stdout, /renamed\.jsonl {2}\[dir\] {2}6 records of 6 lines, 0 skipped, 1 duplicates replaced/);
    assert.match(s.stdout, /kinds: outcome 2, thesis 3/);
    assert.match(s.stdout, /evidence: 5 records from 2 files/);
    assert.match(runEvidence(['reindex'], { env: i.env }).stdout, /\(index rebuilt\)/);
  });

  it('usage errors', () => {
    const i = setup();
    for (const args of [[], ['nope'], ['import'], ['import', 'a', 'b'], ['import', 'a', '--name'], ['import', 'a', '--bogus'], ['stats', 'x'], ['reindex', 'x']]) {
      assert.equal(runEvidence(args, { env: i.env }).code, 2, args.join(' '));
    }
    assert.match(runEvidence(['stats'], { env: i.env }).stdout, /no evidence files/);
    assert.equal(runEvidence(['import', path.join(i.ext, 'missing.jsonl')], { env: i.env }).code, 1);
  });
});

describe('evidence loading makes no network call (I3 spy)', () => {
  it('import, refresh, stats, resolve, and list never connect, fetch, or resolve a host', async () => {
    let calls = 0;
    const spy = () => {
      calls++;
      throw new Error('network call during evidence loading');
    };
    const saved = {
      connect: net.Socket.prototype.connect, fetch: globalThis.fetch, lookup: dns.lookup, httpRequest: http.request, httpGet: http.get,
      httpsRequest: https.request, httpsGet: https.get, netConnect: net.connect, createConnection: net.createConnection,
    };
    net.Socket.prototype.connect = spy as never;
    globalThis.fetch = spy as never;
    dns.lookup = spy as never;
    http.request = spy as never;
    http.get = spy as never;
    https.request = spy as never;
    https.get = spy as never;
    net.connect = spy as never;
    net.createConnection = spy as never;
    try {
      const i = withSource();
      const src = path.join(i.ext, 'urls.jsonl');
      fs.writeFileSync(src, `${line({ id: 'th_url', summary: 'see https://e3d.example/t/1 and http://127.0.0.1:9/x', attributes: { link: 'https://e3d.example/api' } })}\n`);
      assert.equal(runEvidence(['import', src], { env: i.env }).code, 0);
      const ev = openEvidence(envOf(i));
      assert.ok(ev.resolve('thesis', 'th_url').found);
      ev.list('outcome');
      ev.kinds();
      ev.close();
      evidenceStats(envOf(i));
      refreshEvidence(envOf(i), { force: true });
      const res = new CitationResolver({ evidence: memoryEvidenceSource([]) });
      res.resolve('url:https://e3d.example/t/1');
      res.resolve('commit:abcdef1');
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      net.Socket.prototype.connect = saved.connect;
      globalThis.fetch = saved.fetch;
      dns.lookup = saved.lookup;
      http.request = saved.httpRequest;
      http.get = saved.httpGet;
      https.request = saved.httpsRequest;
      https.get = saved.httpsGet;
      net.connect = saved.netConnect;
      net.createConnection = saved.createConnection;
    }
    assert.equal(calls, 0);
  });

  it('src/evidence and src/cite import no network module', () => {
    for (const dir of ['src/evidence', 'src/cite']) {
      for (const name of fs.readdirSync(path.join(repoRoot(), dir))) {
        const text = fs.readFileSync(path.join(repoRoot(), dir, name), 'utf8');
        assert.doesNotMatch(text, /from '(?:node:)?(?:net|http|https|http2|dns|tls|dgram)'|from '\.\.\/net\/|\bfetch\s*\(/, `${dir}/${name}`);
      }
    }
  });
});

describe('citation resolution', () => {
  const REV = '0123456789abcdef';
  const NEW = 'fedcba9876543210';
  const notes: NoteLookup = (id) => (id === 'N1' ? { rev: REV } : undefined);
  const evidence = memoryEvidenceSource([
    { kind: 'thesis', id: 'th_123', occurred: '2026-09-01T00:00:00.000Z', summary: 's', attributes: { status: 'closed' } },
    { kind: 'outcome', id: 'oc_456', occurred: '2026-09-20T00:00:00.000Z', summary: 'o', attributes: {} },
  ]);

  it('combines note and evidence citations into resolved | unresolved | stale | malformed', () => {
    const ctx = { notes, evidence };
    const status = (c: unknown) => resolveCitation(c, ctx).status;
    assert.equal(status(formatCitation({ kind: 'note', id: 'N1', rev: REV })), 'resolved');
    assert.equal(status(formatCitation({ kind: 'note', id: 'N1', rev: REV, heading: 'Why' })), 'resolved');
    assert.equal(status(formatCitation({ kind: 'note', id: 'N1', rev: NEW })), 'stale');
    assert.equal(status(formatCitation({ kind: 'note', id: 'N2', rev: REV })), 'unresolved');
    assert.equal(status('thesis:th_123'), 'resolved');
    assert.equal(status('outcome:oc_456'), 'resolved');
    assert.equal(status('thesis:th_999'), 'unresolved');
    assert.equal(status('outcome:th_123'), 'unresolved');
    assert.equal(status('commit:abcdef1'), 'unresolved');
    assert.equal(status('url:https://e3d.example/x'), 'unresolved');
    assert.equal(status('ref:ref_x/1/0'), 'unresolved');
    assert.equal(resolveCitation('ref:ref_x/1/0', { refs: (r, ch, o) => r === 'ref_x' && ch === '1' && o === 0 }).status, 'resolved');
    for (const bad of ['', 'thesis:', 'thesis:th 1', 'note:N1', `note:N1@${REV.toUpperCase()}`, 'nope:x', ' thesis:th_123', 42, null]) {
      assert.equal(status(bad), 'malformed', String(bad));
    }
    const r = resolveCitation('thesis:th_123', ctx);
    assert.ok(r.evidence?.found);
    assert.deepEqual(r.evidence.attributes, { status: 'closed' });
    // Without the lookups, nothing resolves (and nothing is guessed).
    assert.equal(resolveCitation('thesis:th_123', {}).status, 'unresolved');
    assert.equal(resolveCitation(formatCitation({ kind: 'note', id: 'N1', rev: REV }), {}).status, 'unresolved');
  });

  it('CitationResolver caches per run (one lookup per distinct citation) and only for its own lifetime', () => {
    let lookups = 0;
    const counting: EvidenceSource = { ...evidence, resolve: (k, id) => (lookups++, evidence.resolve(k, id)) };
    const run1 = new CitationResolver({ evidence: counting });
    for (let n = 0; n < 5; n++) {
      assert.equal(run1.resolve('thesis:th_123').status, 'resolved');
      assert.equal(run1.resolve('thesis:th_999').status, 'unresolved');
    }
    assert.equal(lookups, 2);
    assert.equal(run1.size, 2);
    const run2 = new CitationResolver({ evidence: counting });
    run2.resolve('thesis:th_123');
    assert.equal(lookups, 3, 'a new run resolves afresh');
  });

  it('src/cite stays pure: no filesystem or state writes', () => {
    const text = fs.readFileSync(path.join(repoRoot(), 'src', 'cite', 'resolve.ts'), 'utf8');
    assert.doesNotMatch(text, /safe-path|writeAtomic|appendSafe|createExclusive|from '\.\.\/evidence\/store/);
    assert.match(text, /import type \{ EvidenceResolution, EvidenceSource \} from '\.\.\/evidence\/source\.js'/);
  });
});

describe('review accept and evidence citations', () => {
  const THESIS_JOB: CognitionJob = {
    name: 'selftest',
    version: 1,
    description: 'test job citing a thesis',
    llm: 'never',
    async generate(ctx) {
      const r = allNoteRows(ctx.index.db).find((n) => n.path === 'notes/alpha.md')!;
      ctx.input(r.id, r.rev);
      return {
        drafts: [{
          proposal_type: 'demote', title: 'Demote alpha', rationale: 'Outcome th_123 says so.',
          targets: [{ id: r.id, rev: r.rev, path_at_proposal: r.path }],
          evidence: [formatCitation({ kind: 'note', id: r.id, rev: r.rev }), 'thesis:th_123'],
          ops: [{ op: 'set_frontmatter', target: r.id, key: 'status', value: 'stale' }],
        }],
      };
    },
  };

  it('refuses (blocked, not stale) while the cited thesis is not in local evidence; accepts once it is imported', async () => {
    const i = setup();
    fs.writeFileSync(path.join(i.vault, 'notes', 'alpha.md'), '---\ntitle: Alpha\n---\nalpha body\n');
    assert.equal(runIds(['assign'], { env: i.env }).code, 0);
    const h = openIndex({ vaultPath: i.vault, stateDir: i.stateDir });
    let id: string;
    try {
      refreshIndex(h);
      const r = await runJob({ config: i.config, stateDir: i.stateDir, index: h, job: THESIS_JOB });
      assert.equal(r.created.length, 1);
      id = r.created[0]!.id;
    } finally {
      closeIndex(h);
    }
    const show = runReview(['show', id], { env: i.env });
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /blocked: evidence thesis:th_123 is unresolved/);
    const refused = runReview(['accept', id], { env: i.env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /evidence thesis:th_123 is unresolved/);
    assert.doesNotMatch(refused.stderr, /stale/);
    assert.match(fs.readFileSync(path.join(i.vault, 'notes', 'alpha.md'), 'utf8'), /^---\nid: /);
    assert.doesNotMatch(fs.readFileSync(path.join(i.vault, 'notes', 'alpha.md'), 'utf8'), /status: stale/);
    const list = runReview(['list'], { env: i.env });
    assert.match(list.stdout, new RegExp(`${id}\\tproposed\\t`), 'the proposal is not marked stale');

    const src = path.join(i.ext, 'e3d.jsonl');
    fs.writeFileSync(src, fs.readFileSync(FIXTURE));
    assert.equal(runEvidence(['import', src], { env: i.env }).code, 0);
    const ok = runReview(['accept', id], { env: i.env });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(fs.readFileSync(path.join(i.vault, 'notes', 'alpha.md'), 'utf8'), /status: stale/);
  });
});
