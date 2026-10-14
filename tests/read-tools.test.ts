// Phase 6 unit tests for the read-tool helpers: ISO date handling, the
// visibility function (validity windows, lifecycle at as_of, include flags,
// status override), citations, result fitting under the size cap, ULIDs, and
// the tools through dispatch in-process.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeIndex, openIndex } from '../src/index/indexer.js';
import type { NoteRow } from '../src/index/query.js';
import { dispatch, listTools, renderContent, ToolRegistry, type DispatchContext } from '../src/mcp/dispatch.js';
import {
  citationFor, COMPACT_EXCERPT_CHARS, effectiveStatus, isoToMs, isVisible, listResponse, normalizeTag, registerReadTools,
  type Visibility,
} from '../src/mcp/tools.js';
import { ulid, ULID_RE } from '../src/mcp/ulid.js';
import { ensurePrivateDir } from '../src/safe-path.js';
import { realTmpDir, rmrf } from './helpers.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');

function row(over: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'n.md', id: 'abc', provisional: 0, rev: '0123456789abcdef', title: 'T', folder_class: 'curated', folder_hidden: 0,
    status: null, status_known: 1, kind: null, occurred: null, valid_from: null, valid_until: null, superseded_at: null,
    archived_at: null, sources: '[]', ...over,
  };
}

function vis(over: Partial<Visibility> = {}): Visibility {
  return { includeSuperseded: false, includeArchived: false, now: NOW, ...over };
}

describe('isoToMs', () => {
  it('reads dates and date-times as UTC; bare dates start or end the day', () => {
    assert.equal(isoToMs('2026-05-01'), Date.parse('2026-05-01T00:00:00Z'));
    assert.equal(isoToMs('2026-05-01', 'end'), Date.parse('2026-05-02T00:00:00Z') - 1);
    assert.equal(isoToMs('2026-05-01T10:00'), Date.parse('2026-05-01T10:00:00Z'));
    assert.equal(isoToMs('2026-05-01 10:00:00'), Date.parse('2026-05-01T10:00:00Z'));
    assert.equal(isoToMs('2026-05-01T10:00:00+0200'), Date.parse('2026-05-01T08:00:00Z'));
    assert.equal(isoToMs('2026-05-01T10:00:00.123456789Z'), Date.parse('2026-05-01T10:00:00.123Z'));
    for (const bad of ['next tuesday', '2026-02-30', '2026-13-01', '', '2026-05-01T25:00']) assert.equal(isoToMs(bad), undefined, bad);
  });
});

describe('isVisible', () => {
  it('applies the validity window at as_of (default now)', () => {
    const june = row({ valid_until: '2026-06-30' });
    assert.equal(isVisible(june, vis({ asOf: isoToMs('2026-05-01') })), true);
    assert.equal(isVisible(june, vis({ asOf: isoToMs('2026-06-30') })), true, 'valid_until includes its day');
    assert.equal(isVisible(june, vis({ asOf: isoToMs('2026-07-01') })), false);
    assert.equal(isVisible(june, vis()), false, 'now is after June');
    const future = row({ valid_from: '2027-01-01' });
    assert.equal(isVisible(future, vis()), false);
    assert.equal(isVisible(future, vis({ asOf: isoToMs('2027-02-01') })), true);
  });

  it('hides rejected/superseded/archived by default; include flags and as_of lifecycle reveal them', () => {
    const sup = row({ status: 'superseded', superseded_at: '2026-03-01' });
    assert.equal(isVisible(sup, vis()), false);
    assert.equal(isVisible(sup, vis({ includeSuperseded: true })), true);
    assert.equal(isVisible(sup, vis({ includeArchived: true })), false);
    assert.equal(isVisible(sup, vis({ asOf: isoToMs('2026-02-01') })), true);
    assert.equal(isVisible(sup, vis({ asOf: isoToMs('2026-04-01') })), false);
    assert.equal(isVisible(row({ status: 'superseded' }), vis({ asOf: isoToMs('2020-01-01') })), false, 'no superseded_at: hidden');

    const arch = row({ status: 'archived', archived_at: '2026-02-01', folder_class: 'archive', folder_hidden: 1 });
    assert.equal(isVisible(arch, vis()), false);
    assert.equal(isVisible(arch, vis({ includeArchived: true })), true);
    assert.equal(isVisible(arch, vis({ asOf: isoToMs('2026-01-01') })), true);
    assert.equal(isVisible(arch, vis({ asOf: isoToMs('2026-03-01') })), false);
    // Under _archive/ without an archived status: still only include_archived reveals it.
    const folderOnly = row({ folder_class: 'archive', folder_hidden: 1 });
    assert.equal(isVisible(folderOnly, vis()), false);
    assert.equal(isVisible(folderOnly, vis({ includeArchived: true })), true);

    const rej = row({ status: 'rejected' });
    assert.equal(isVisible(rej, vis({ includeArchived: true, includeSuperseded: true })), false);
    assert.equal(isVisible(rej, vis({ statuses: ['rejected'] })), true);
  });

  it('status lists filter and override status-based hiding', () => {
    assert.equal(isVisible(row(), vis({ statuses: ['accepted'] })), true, 'curated without status is accepted');
    assert.equal(isVisible(row(), vis({ statuses: ['stale'] })), false);
    assert.equal(isVisible(row({ status: 'stale' }), vis({ statuses: ['stale', 'accepted'] })), true);
    assert.equal(isVisible(row({ status: 'superseded' }), vis({ statuses: ['superseded'] })), true);
    const rejectedFolder = row({ folder_class: 'inbox', folder_hidden: 1, status: 'rejected' });
    assert.equal(isVisible(rejectedFolder, vis()), false);
    assert.equal(isVisible(rejectedFolder, vis({ statuses: ['rejected'] })), true);
  });

  it('unknown statuses stay visible (lowest tier) and are never reported as accepted', () => {
    const odd = row({ status: 'bogus', status_known: 0 });
    assert.equal(isVisible(odd, vis()), true);
    assert.equal(effectiveStatus(odd), 'bogus');
    assert.equal(effectiveStatus(row({ folder_class: 'raw' })), null);
    assert.equal(effectiveStatus(row({ folder_class: 'reference' })), 'accepted');
  });
});

describe('citations and tags', () => {
  it('pins the revision and drops uncitable headings', () => {
    assert.equal(citationFor(row()), 'note:abc@0123456789abcdef');
    assert.equal(citationFor(row(), 'A, b @ #c'), 'note:abc@0123456789abcdef#A%2C%20b%20%40%20%23c');
    assert.equal(citationFor(row(), 'bad\u0007heading'), 'note:abc@0123456789abcdef');
  });

  it('normalizes tags like the index', () => {
    assert.equal(normalizeTag('#Project/X'), 'project/x');
    assert.equal(normalizeTag(' Café '), 'café');
  });
});

describe('listResponse', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    fields: { id: `id${i}`, rev: '0123456789abcdef', path: `n${i}.md` },
    excerpt: `excerpt ${'x'.repeat(200)} ${i}`,
  }));

  it('fits whole results under the cap and reports exactly those as returned', () => {
    for (const cap of [10000, 3000, 900, 400]) {
      const r = listResponse('list_notes', 'full', items, cap);
      const text = renderContent(r.content, cap).text;
      const rendered = renderContent(r.content, Number.MAX_SAFE_INTEGER).text;
      assert.equal(text, rendered, `cap ${cap}: no dispatch truncation needed`);
      assert.ok(text.length <= cap);
      assert.equal(r.returned!.length, r.count);
      const head = JSON.parse(text.split('\n')[0]!) as { count: number; omitted: number; recall_id: string };
      assert.equal(head.count, r.count);
      assert.equal(head.count + head.omitted, items.length);
      assert.match(head.recall_id, ULID_RE);
    }
  });

  it('shortens the first excerpt rather than returning nothing', () => {
    const big = [{ fields: { id: 'a', rev: '0123456789abcdef' }, excerpt: 'y'.repeat(5000) }];
    const r = listResponse('search', 'full', big, 800);
    assert.equal(r.count, 1);
    assert.ok(renderContent(r.content, 800).text.length <= 800);
  });

  it('returns no results when not even one fits', () => {
    const r = listResponse('search', 'full', items, 60);
    assert.equal(r.count, 0);
    assert.deepEqual(r.returned, []);
  });
});

describe('ulid', () => {
  it('is 26 Crockford characters, time-prefixed, and unique', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => ulid()));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.match(id, ULID_RE);
    assert.ok(ulid(Date.parse('2020-01-01')) < ulid(Date.parse('2030-01-01')));
    assert.equal(ulid(0).slice(0, 10), '0000000000');
  });
});

describe('read tools through dispatch (in-process)', () => {
  it('register in every mode, refresh before reading, and reject bad arguments', async () => {
    const base = realTmpDir('ebrain-rt-');
    try {
      const vault = path.join(base, 'vault');
      fs.mkdirSync(vault);
      fs.writeFileSync(path.join(vault, 'a.md'), '# A\n\nalphaword here\n');
      const stateDir = ensurePrivateDir(path.join(base, 'state'));
      const index = openIndex({ vaultPath: vault, stateDir });
      const registry = new ToolRegistry();
      registerReadTools({ vaultPath: vault, index, now: () => new Date(NOW) }, registry);
      for (const mode of ['inbox', 'journal', 'read-only'] as const) {
        assert.deepEqual(listTools(mode, registry).map((t) => t.name), ['search', 'read_note', 'list_notes', 'related']);
      }
      const ctx: DispatchContext = { mode: 'read-only', principal: { id: 't', type: 'human' }, maxCharsPerCall: 10000, registry };
      const r1 = await dispatch(ctx, 'search', { query: 'alphaword' });
      assert.match(r1.content[0]!.text, /"count":1/);
      fs.writeFileSync(path.join(vault, 'b.md'), '# B\n\nalphaword again\n');
      const r2 = await dispatch(ctx, 'search', { query: 'alphaword', format: 'compact' });
      assert.match(r2.content[0]!.text, /"count":2/, 'refreshIndex ran before the read');
      for (const bad of [{}, { query: '' }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, { query: 'x', format: 'tiny' },
        { query: 'x', status: 'bogus' }, { query: 'x', principal: 'p' }, { query: 'x', scope: 'refs' }]) {
        const r = await dispatch(ctx, 'search', bad);
        assert.equal(r.isError, true, JSON.stringify(bad));
      }
      const compact = await dispatch(ctx, 'read_note', { path: 'a.md', format: 'compact' });
      assert.ok(!compact.isError);
      assert.ok(COMPACT_EXCERPT_CHARS === 200);
      closeIndex(index);
    } finally {
      rmrf(base);
    }
  });
});
