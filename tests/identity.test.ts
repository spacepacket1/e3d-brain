import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkNoteCitation, formatCitation, parseCitation } from '../src/cite/citation.js';
import { runDoctor } from '../src/cli/doctor.js';
import { dumpIndex } from '../src/index/dump.js';
import {
  citingNotes, deriveProvisionalId, duplicateIds, missingIdentities, noteIdentityById, noteIdentityByPath, noteLookup,
  noteRevisions, type NoteIdentity,
} from '../src/index/identity.js';
import { closeIndex, indexTotals, openIndex, refreshIndex, reindex, type IndexHandle } from '../src/index/indexer.js';
import { matchChunks } from '../src/index/query.js';
import { revOf } from '../src/vault/parse.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import { realTmpDir, rmrf, treeChecksum, writeTestConfig } from './helpers.js';

const bases: string[] = [];
after(() => bases.forEach(rmrf));

interface Env {
  base: string;
  vault: string;
  stateDir: SafePath;
  h: IndexHandle;
  write: (rel: string, content: string | Buffer) => void;
  move: (from: string, to: string) => void;
  id: (rel: string) => NoteIdentity;
}

function setup(files: Record<string, string> = {}): Env {
  const base = realTmpDir('ebrain-identity-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault);
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  const h = openIndex({ vaultPath: vault, stateDir });
  return {
    base, vault, stateDir, h, write,
    move: (from, to) => {
      fs.mkdirSync(path.dirname(path.join(vault, to)), { recursive: true });
      fs.renameSync(path.join(vault, from), path.join(vault, to));
    },
    id: (rel) => {
      const ident = noteIdentityByPath(h.db, rel);
      assert.ok(ident, `not indexed: ${rel}`);
      return ident;
    },
  };
}

function done(env: Env): void {
  closeIndex(env.h);
}

const ALPHA = '---\nid: 01JALPHA0000000000000000AA\nstatus: accepted\n---\n# Alpha\n\nAlpha body.\n';

describe('revisions', () => {
  it('CRLF, CR, LF, and a leading BOM give the same rev; any surviving byte change does not', () => {
    const lf = '---\nkind: fact\n---\n# T\n\nline one\nline two\n';
    const env = setup({
      'lf.md': lf,
      'crlf.md': lf.replace(/\n/g, '\r\n'),
      'cr.md': lf.replace(/\n/g, '\r'),
      'bom.md': `﻿${lf.replace(/\n/g, '\r\n')}`,
      'key.md': lf.replace('kind: fact\n', 'kind: fact\nstatus: accepted\n'),
      'trailing.md': `${lf}\n`,
    });
    reindex(env.h);
    const rev = env.id('lf.md').rev;
    assert.match(rev, /^[0-9a-f]{16}$/);
    assert.equal(rev, revOf(lf));
    for (const p of ['crlf.md', 'cr.md', 'bom.md']) assert.equal(env.id(p).rev, rev, p);
    assert.notEqual(env.id('key.md').rev, rev, 'adding a frontmatter key changes rev');
    assert.notEqual(env.id('trailing.md').rev, rev);
    done(env);
  });

  it('editing a note changes its rev, keeps its id, and adds a note_revisions row', () => {
    const env = setup({ 'n.md': '# N\n\nfirst\n' });
    reindex(env.h);
    const before = env.id('n.md');
    assert.equal(before.provisional, true);
    assert.deepEqual(noteRevisions(env.h.db, before.id).map((r) => r.rev), [before.rev]);
    env.write('n.md', '# N\n\nsecond\n');
    refreshIndex(env.h);
    const after = env.id('n.md');
    assert.equal(after.id, before.id);
    assert.notEqual(after.rev, before.rev);
    assert.deepEqual(noteRevisions(env.h.db, before.id).map((r) => r.rev).sort(), [before.rev, after.rev].sort());
    // Adding an explicit id is an edit too: new rev, and the note now has an assigned identity.
    env.write('n.md', '---\nid: ASSIGNED1\n---\n# N\n\nsecond\n');
    reindex(env.h);
    const assigned = env.id('n.md');
    assert.equal(assigned.id, 'ASSIGNED1');
    assert.equal(assigned.provisional, false);
    assert.notEqual(assigned.rev, after.rev);
    // note_revisions holds hashes only.
    const cols = (env.h.db.prepare('PRAGMA table_info(note_revisions)').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ['id', 'rev', 'first_seen']);
    done(env);
  });

  it('every chunk records chunk_rev over its own text', () => {
    const env = setup({ 'c.md': '# A\n\none\n\n# B\n\ntwo\n' });
    reindex(env.h);
    const rows = env.h.db.prepare('SELECT text, chunk_rev FROM chunks ORDER BY ordinal').all() as { text: string; chunk_rev: string }[];
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.chunk_rev, revOf(r.text));
    assert.notEqual(rows[0]!.chunk_rev, env.id('c.md').rev);
    done(env);
  });
});

describe('identity', () => {
  it('reads an explicit id, otherwise derives a prov_ id from hash plus path', () => {
    const env = setup({ 'Projects/Alpha.md': ALPHA, 'plain.md': '# Plain\n' });
    reindex(env.h);
    assert.deepEqual(env.id('Projects/Alpha.md'), {
      path: 'Projects/Alpha.md', id: '01JALPHA0000000000000000AA', provisional: false, rev: revOf(ALPHA),
    });
    const plain = env.id('plain.md');
    assert.equal(plain.provisional, true);
    assert.match(plain.id, /^prov_[0-9a-f]{20}$/);
    const hash = (env.h.db.prepare('SELECT hash FROM notes WHERE path = ?').get('plain.md') as { hash: string }).hash;
    assert.equal(plain.id, deriveProvisionalId(hash, 'plain.md'));
    done(env);
  });

  it('invalid or prov_-prefixed explicit ids fall back to a provisional id and are reported', () => {
    const env = setup({ 'a.md': '---\nid: has-dash\n---\nA\n', 'b.md': '---\nid: prov_stolen\n---\nB\n' });
    reindex(env.h);
    for (const p of ['a.md', 'b.md']) {
      assert.equal(env.id(p).provisional, true, p);
      assert.notEqual(env.id(p).id, 'prov_stolen');
    }
    assert.equal(indexTotals(env.h.db).invalidFields, 2);
    done(env);
  });

  it('two byte-identical notes get distinct provisional ids', () => {
    const env = setup({ 'one.md': 'same\n', 'two.md': 'same\n', 'e1.md': '', 'e2.md': '' });
    reindex(env.h);
    const ids = ['one.md', 'two.md', 'e1.md', 'e2.md'].map((p) => env.id(p).id);
    assert.equal(new Set(ids).size, 4);
    done(env);
  });

  for (const mode of ['refresh', 'reindex'] as const) {
    it(`renaming or moving without editing keeps the id (${mode})`, () => {
      const env = setup({ 'Projects/Alpha.md': ALPHA, 'plain.md': '# Plain\n\nunique text\n' });
      const update = () => (mode === 'refresh' ? refreshIndex(env.h) : reindex(env.h));
      reindex(env.h);
      const prov = env.id('plain.md');
      env.move('plain.md', 'Renamed.md');
      env.move('Projects/Alpha.md', 'Archive/Deep/Alpha moved.md');
      const r = update();
      assert.equal(r.added, 2);
      assert.equal(r.removed, 2);
      assert.equal(env.id('Renamed.md').id, prov.id);
      assert.equal(env.id('Renamed.md').rev, prov.rev);
      assert.equal(env.id('Archive/Deep/Alpha moved.md').id, '01JALPHA0000000000000000AA');
      assert.deepEqual(missingIdentities(env.h.db), []);
      // Move again into a subfolder: still the same identity.
      env.move('Renamed.md', 'sub/Renamed.md');
      update();
      assert.equal(env.id('sub/Renamed.md').id, prov.id);
      // Edit in place after moving: identity continues.
      env.write('sub/Renamed.md', '# Plain\n\nedited text\n');
      update();
      assert.equal(env.id('sub/Renamed.md').id, prov.id);
      assert.deepEqual(missingIdentities(env.h.db), []);
      done(env);
    });
  }

  it('editing and moving in one step yields a new provisional id and reports the old one missing', () => {
    const env = setup({ 'old.md': '# Old\n\ntext\n' });
    reindex(env.h);
    const old = env.id('old.md');
    env.move('old.md', 'new.md');
    env.write('new.md', '# Old\n\ntext, edited\n');
    refreshIndex(env.h);
    const fresh = env.id('new.md');
    assert.equal(fresh.provisional, true);
    assert.notEqual(fresh.id, old.id);
    const missing = missingIdentities(env.h.db);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]!.id, old.id);
    assert.equal(missing[0]!.lastPath, 'old.md');
    assert.equal(missing[0]!.lastRev, old.rev);
    assert.equal(missing[0]!.provisional, true);
    done(env);
  });

  it('an explicit id survives edit+move; deleting it reports it missing until it comes back', () => {
    const env = setup({ 'a.md': ALPHA });
    reindex(env.h);
    env.move('a.md', 'b.md');
    env.write('b.md', ALPHA.replace('Alpha body.', 'Changed body.'));
    refreshIndex(env.h);
    assert.equal(env.id('b.md').id, '01JALPHA0000000000000000AA');
    assert.deepEqual(missingIdentities(env.h.db), []);
    fs.rmSync(path.join(env.vault, 'b.md'));
    refreshIndex(env.h);
    assert.deepEqual(missingIdentities(env.h.db).map((m) => [m.id, m.provisional]), [['01JALPHA0000000000000000AA', false]]);
    env.write('c.md', ALPHA);
    refreshIndex(env.h);
    assert.deepEqual(missingIdentities(env.h.db), []);
    done(env);
  });

  it('moving one of two identical notes does not transfer identity by guesswork', () => {
    const env = setup({ 'one.md': 'twin\n', 'two.md': 'twin\n' });
    reindex(env.h);
    const one = env.id('one.md');
    const two = env.id('two.md');
    env.move('one.md', 'three.md');
    refreshIndex(env.h);
    const three = env.id('three.md');
    assert.equal(env.id('two.md').id, two.id, 'the unmoved twin keeps its id');
    assert.notEqual(three.id, one.id);
    assert.notEqual(three.id, two.id);
    assert.deepEqual(missingIdentities(env.h.db).map((m) => m.id), [one.id]);
    done(env);
  });

  it('several files sharing a hash disappearing and appearing infer no rename', () => {
    const env = setup({ 'a.md': '', 'b.md': '', 'keep.md': 'k\n' });
    reindex(env.h);
    const a = env.id('a.md').id;
    const b = env.id('b.md').id;
    env.move('a.md', 'c.md');
    env.move('b.md', 'd.md');
    reindex(env.h);
    const newIds = [env.id('c.md').id, env.id('d.md').id];
    for (const id of newIds) assert.ok(id !== a && id !== b);
    assert.deepEqual(missingIdentities(env.h.db).map((m) => m.id).sort(), [a, b].sort());
    // One disappeared, two appeared with the same hash: still ambiguous.
    const env2 = setup({ 'x.md': 'dup\n' });
    reindex(env2.h);
    const x = env2.id('x.md').id;
    env2.move('x.md', 'y.md');
    env2.write('z.md', 'dup\n');
    reindex(env2.h);
    assert.ok(env2.id('y.md').id !== x && env2.id('z.md').id !== x);
    assert.deepEqual(missingIdentities(env2.h.db).map((m) => m.id), [x]);
    done(env);
    done(env2);
  });

  it('a new note at a path a moved note was first seen at gets a distinct id', () => {
    const env = setup({ 'p.md': 'content\n' });
    reindex(env.h);
    const first = env.id('p.md').id;
    env.move('p.md', 'q.md');
    refreshIndex(env.h);
    assert.equal(env.id('q.md').id, first);
    env.write('p.md', 'content\n'); // same hash, same first-seen path: would derive the same id
    refreshIndex(env.h);
    assert.notEqual(env.id('p.md').id, first);
    assert.equal(env.id('q.md').id, first);
    done(env);
  });

  it('duplicate explicit ids: both indexed, the later in path order is provisional, doctor fails', () => {
    const dup = (body: string) => `---\nid: SAME_ID\nstatus: accepted\n---\n${body}\n`;
    const env = setup({ 'b.md': dup('second wombat'), 'a.md': dup('first wombat') });
    reindex(env.h);
    assert.equal(env.id('a.md').id, 'SAME_ID');
    assert.equal(env.id('b.md').provisional, true);
    assert.deepEqual(duplicateIds(env.h.db), [{ id: 'SAME_ID', paths: ['a.md', 'b.md'] }]);
    assert.deepEqual(matchChunks(env.h.db, 'wombat').map((m) => m.path).sort(), ['a.md', 'b.md']);
    assert.equal(noteIdentityById(env.h.db, 'SAME_ID')!.path, 'a.md');

    const config = writeTestConfig(env.base, env.vault, env.stateDir);
    const report = runDoctor({ env: { EBRAIN_CONFIG: config }, homeDir: env.base });
    const out = report.lines.join('\n');
    assert.equal(report.ok, false);
    assert.match(out, /^duplicate ids: FAIL 1/m);
    assert.match(out, /duplicate id "SAME_ID": "a\.md" "b\.md"/);

    // Removing the first hands the explicit id to the remaining note.
    fs.rmSync(path.join(env.vault, 'a.md'));
    refreshIndex(env.h);
    assert.equal(env.id('b.md').id, 'SAME_ID');
    assert.deepEqual(duplicateIds(env.h.db), []);
    assert.deepEqual(missingIdentities(env.h.db), [], 'b.md still exists; only its effective id changed');
    done(env);
  });

  it('an unknown status is counted, flagged, and still indexed', () => {
    const env = setup({ 'u.md': '---\nstatus: maybe-later\n---\nquokka\n' });
    reindex(env.h);
    assert.equal(indexTotals(env.h.db).unknownStatuses, 1);
    const row = env.h.db.prepare('SELECT status, status_known FROM notes WHERE path = ?').get('u.md') as { status: string; status_known: number };
    assert.deepEqual(row, { status: 'maybe-later', status_known: 0 });
    assert.deepEqual(matchChunks(env.h.db, 'quokka').map((m) => m.path), ['u.md']);
    done(env);
  });

  it('a full rebuild re-derives provisional ids and clears rename history; the dump omits both', () => {
    const env = setup({ 'Projects/Alpha.md': ALPHA, 'a.md': 'aaa\n', 'b.md': 'bbb\n' });
    reindex(env.h);
    env.move('a.md', 'moved.md');
    env.move('b.md', 'b2.md');
    env.write('b2.md', 'bbb edited\n');
    reindex(env.h);
    const carried = env.id('moved.md').id;
    assert.equal(missingIdentities(env.h.db).length, 1);
    const incremental = dumpIndex(env.h.db);
    reindex(env.h, { full: true });
    assert.deepEqual(missingIdentities(env.h.db), []);
    const hash = (env.h.db.prepare('SELECT hash FROM notes WHERE path = ?').get('moved.md') as { hash: string }).hash;
    assert.equal(env.id('moved.md').id, deriveProvisionalId(hash, 'moved.md'));
    assert.notEqual(env.id('moved.md').id, carried);
    assert.equal(env.id('Projects/Alpha.md').id, '01JALPHA0000000000000000AA');
    assert.equal(dumpIndex(env.h.db), incremental);
    assert.doesNotMatch(incremental, /prov_/);
    done(env);
  });
});

describe('citation edges', () => {
  it('a note citing another via sources appears in cites and the cited note reports it', () => {
    const env = setup({ 'Projects/Alpha.md': ALPHA });
    reindex(env.h);
    const alpha = env.id('Projects/Alpha.md');
    const cite = formatCitation({ kind: 'note', id: alpha.id, rev: alpha.rev });
    const headingCite = formatCitation({ kind: 'note', id: alpha.id, rev: alpha.rev, heading: 'Alpha, part @1' });
    env.write('citer.md', `---\nsources: [${cite}, "url:https://example.com/x"]\n---\nCites alpha.\n`);
    env.write('deriver.md', `---\nderived_from:\n  - ${headingCite}\n---\nDerived.\n`);
    refreshIndex(env.h);
    const citer = env.id('citer.md');
    const rows = env.h.db.prepare('SELECT from_id, to_id, to_rev FROM cites ORDER BY from_path').all();
    assert.deepEqual(rows, [
      { from_id: citer.id, to_id: alpha.id, to_rev: alpha.rev },
      { from_id: env.id('deriver.md').id, to_id: alpha.id, to_rev: alpha.rev },
    ]);
    const citing = citingNotes(env.h.db, alpha.id);
    assert.deepEqual(citing.map((c) => [c.fromPath, c.field, c.provisional]), [
      ['citer.md', 'sources', true], ['deriver.md', 'derived_from', true],
    ]);
    assert.equal(indexTotals(env.h.db).cites, 2);
    const parsed = parseCitation(cite);
    assert.ok(parsed.ok && parsed.citation.kind === 'note');
    if (!parsed.ok || parsed.citation.kind !== 'note') return;
    assert.equal(checkNoteCitation(parsed.citation, noteLookup(env.h.db)), 'fresh');

    // Editing the cited note makes the citation stale; deleting it makes it missing.
    env.write('Projects/Alpha.md', ALPHA.replace('Alpha body.', 'New body.'));
    refreshIndex(env.h);
    assert.equal(checkNoteCitation(parsed.citation, noteLookup(env.h.db)), 'stale');
    assert.equal(citingNotes(env.h.db, alpha.id).length, 2, 'edges survive the cited note changing');
    fs.rmSync(path.join(env.vault, 'Projects', 'Alpha.md'));
    refreshIndex(env.h);
    assert.equal(checkNoteCitation(parsed.citation, noteLookup(env.h.db)), 'missing');

    // Removing the citing note removes its edges.
    fs.rmSync(path.join(env.vault, 'citer.md'));
    refreshIndex(env.h);
    assert.deepEqual(citingNotes(env.h.db, alpha.id).map((c) => c.fromPath), ['deriver.md']);
    done(env);
  });

  it('a provisional citation keeps resolving (as stale) after the note is assigned an explicit id', () => {
    const env = setup({ 'target.md': '# Target\n\nbody\n' });
    reindex(env.h);
    const t = env.id('target.md');
    env.write('citer.md', `---\nsources: [note:${t.id}@${t.rev}]\n---\nx\n`);
    refreshIndex(env.h);
    const parsed = parseCitation(`note:${t.id}@${t.rev}`);
    assert.ok(parsed.ok && parsed.citation.kind === 'note');
    if (!parsed.ok || parsed.citation.kind !== 'note') return;
    assert.equal(checkNoteCitation(parsed.citation, noteLookup(env.h.db)), 'fresh');
    env.write('target.md', '---\nid: TARGET\n---\n# Target\n\nbody\n');
    refreshIndex(env.h);
    assert.equal(env.id('target.md').id, 'TARGET');
    assert.equal(checkNoteCitation(parsed.citation, noteLookup(env.h.db)), 'stale');
    assert.equal(noteIdentityById(env.h.db, t.id)!.id, 'TARGET');
    assert.deepEqual(citingNotes(env.h.db, 'TARGET').map((c) => c.fromPath), ['citer.md']);
    assert.deepEqual(citingNotes(env.h.db, t.id).map((c) => c.fromPath), ['citer.md']);
    assert.deepEqual(missingIdentities(env.h.db), [], 'the note still exists, so its provisional id is not missing');
    done(env);
  });

  it('cites follow the citing note through a rename and use its explicit id', () => {
    const env = setup({ 'target.md': '# Target\n' });
    reindex(env.h);
    const t = env.id('target.md');
    env.write('src.md', `---\nid: CITER\nsources: note:${t.id}@${t.rev}\n---\nx\n`);
    refreshIndex(env.h);
    env.move('src.md', 'moved/src.md');
    refreshIndex(env.h);
    assert.deepEqual(citingNotes(env.h.db, t.id).map((c) => [c.fromId, c.fromPath, c.provisional]), [['CITER', 'moved/src.md', false]]);
    done(env);
  });

  it('malformed citations in sources are reported, never indexed as edges', () => {
    const env = setup({ 'bad.md': '---\nsources: ["note:abc", "note:abc@0123456789ABCDEF", "see chapter 3"]\n---\nx\n' });
    reindex(env.h);
    assert.equal(indexTotals(env.h.db).cites, 0);
    const problems = env.h.db.prepare("SELECT field FROM problems WHERE kind = 'invalid_field'").all() as { field: string }[];
    assert.deepEqual(problems.map((p) => p.field), ['sources', 'sources', 'sources']);
    done(env);
  });
});

describe('vault safety', () => {
  it('indexing never writes ids into notes (vault checksum unchanged)', () => {
    const env = setup({ 'a.md': 'no id here\n', 'b.md': ALPHA, 'c.md': '---\nid: DUP\n---\n', 'd.md': '---\nid: DUP\n---\n' });
    const before = treeChecksum(env.vault);
    reindex(env.h);
    refreshIndex(env.h);
    reindex(env.h, { full: true });
    assert.equal(treeChecksum(env.vault), before);
    env.move('a.md', 'e.md');
    const moved = treeChecksum(env.vault);
    refreshIndex(env.h);
    reindex(env.h);
    assert.equal(treeChecksum(env.vault), moved);
    done(env);
  });
});
