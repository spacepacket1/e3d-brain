// Cognition Phase 1: the recall record. Every read tool call (a result with
// a `recall_id`) appends {recall_id, ts, principal, ids} to
// <stateDir>/recalls.jsonl from dispatch, at most 500 ids, 0600; the audit
// line is unchanged; `ebrain recalls prune` enforces recallLog.retentionDays.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuditLog, readAudit } from '../src/audit/audit.js';
import { runRecalls } from '../src/cli/undo-commands.js';
import { DEFAULT_RECALL_RETENTION_DAYS, parseConfig } from '../src/config.js';
import { dispatch, RECALL_FAILURE_DETAIL, registerTool, ToolRegistry, type DispatchContext, type ToolResult } from '../src/mcp/dispatch.js';
import { MAX_RECALL_IDS, pruneRecalls, readRecalls, RecallLog, RECALLS_FILE } from '../src/recall/recalls.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import { mode, realTmpDir, rmrf, writeTestConfig } from './helpers.js';

const bases: string[] = [];
after(() => bases.forEach(rmrf));

const rev = (i: number) => i.toString(16).padStart(16, '0');
const noteId = (i: number) => `01JNOTE${String(i).padStart(19, '0')}`;

function setup(now = () => new Date('2026-10-14T12:00:00Z')) {
  const base = realTmpDir('ebrain-recalls-');
  bases.push(base);
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  const registry = new ToolRegistry();
  let n = 0;
  registerTool(
    {
      name: 'fake_search',
      modes: ['inbox', 'journal', 'read-only'],
      schema: { type: 'object', properties: { count: { type: 'integer', minimum: 0, maximum: 1000 } } },
      handler: (args): ToolResult => {
        const count = (args['count'] as number | undefined) ?? 3;
        return {
          content: 'results',
          recall_id: `01JRECALL${String(++n).padStart(17, '0')}`,
          returned: Array.from({ length: count }, (_, i) => ({ id: noteId(i), rev: rev(i) })),
        };
      },
    },
    registry,
  );
  registerTool({ name: 'fake_capture', modes: ['inbox'], schema: { type: 'object', properties: {} }, handler: () => ({ content: 'ok', count: 1 }) }, registry);
  const ctx: DispatchContext = {
    mode: 'inbox',
    principal: { id: 'tester', type: 'human' },
    maxCharsPerCall: 10000,
    registry,
    audit: new AuditLog(stateDir, { maxSegmentBytes: 1024 * 1024 }),
    recalls: new RecallLog(stateDir, { now }),
  };
  return { base, stateDir, ctx };
}

describe('recall record', () => {
  it('each read tool call appends one record; other calls append none; the audit is unchanged', async () => {
    const { stateDir, ctx } = setup();
    assert.ok(!(await dispatch(ctx, 'fake_search', { count: 2 })).isError);
    assert.ok(!(await dispatch(ctx, 'fake_capture', {})).isError);
    assert.ok((await dispatch(ctx, 'fake_search', { bogus: 1 })).isError);
    assert.ok(!(await dispatch(ctx, 'fake_search', { count: 0 })).isError);
    const records = readRecalls(stateDir);
    assert.deepEqual(records, [
      { recall_id: '01JRECALL00000000000000001', ts: '2026-10-14T12:00:00.000Z', principal: 'tester', ids: [{ id: noteId(0), rev: rev(0) }, { id: noteId(1), rev: rev(1) }] },
      { recall_id: '01JRECALL00000000000000002', ts: '2026-10-14T12:00:00.000Z', principal: 'tester', ids: [] },
    ]);
    const file = path.join(stateDir, RECALLS_FILE);
    assert.equal(mode(file), 0o600);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('results'), 'no result text in the recall record');
    const audit = readAudit(stateDir as SafePath).lines;
    assert.equal(audit.length, 4, 'one audit line per call, as before');
    assert.equal(audit[0]!['recall_id'], '01JRECALL00000000000000001');
    assert.deepEqual(audit[0]!['returned'], records[0]!.ids);
  });

  it('keeps at most 500 ids, in result order', async () => {
    const { stateDir, ctx } = setup();
    await dispatch(ctx, 'fake_search', { count: 700 });
    const [r] = readRecalls(stateDir);
    assert.equal(r!.ids.length, MAX_RECALL_IDS);
    assert.deepEqual(r!.ids[0], { id: noteId(0), rev: rev(0) });
    assert.deepEqual(r!.ids[499], { id: noteId(499), rev: rev(499) });
  });

  it('a recall write failure turns the response into an error (and is audited)', async () => {
    const { stateDir, ctx } = setup();
    fs.mkdirSync(path.join(stateDir, RECALLS_FILE));
    const res = await dispatch(ctx, 'fake_search', {});
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.error.detail, RECALL_FAILURE_DETAIL);
    const audit = readAudit(stateDir).lines;
    assert.equal(audit.at(-1)!['outcome'], 'error');
  });

  it('prune drops records older than the retention window and malformed lines', () => {
    const { stateDir } = setup();
    const at = (iso: string) => new RecallLog(stateDir, { now: () => new Date(iso) });
    at('2026-01-01T00:00:00Z').append({ recall_id: '01JOLD0000000000000000000A', principal: 'p', ids: [] });
    at('2026-10-01T00:00:00Z').append({ recall_id: '01JNEW0000000000000000000A', principal: 'p', ids: [] });
    fs.appendFileSync(path.join(stateDir, RECALLS_FILE), 'not json\n');
    assert.deepEqual(pruneRecalls(stateDir, 180, new Date('2026-10-14T00:00:00Z')), { kept: 1, removed: 2 });
    assert.deepEqual(readRecalls(stateDir).map((r) => r.recall_id), ['01JNEW0000000000000000000A']);
    assert.equal(mode(path.join(stateDir, RECALLS_FILE)), 0o600);
    assert.deepEqual(pruneRecalls(stateDir, 180, new Date('2026-10-14T00:00:00Z')), { kept: 1, removed: 0 });
  });

  it('ebrain recalls prune uses recallLog.retentionDays (default 180) or --older-than', () => {
    const { base, stateDir } = setup();
    const vault = path.join(base, 'vault');
    fs.mkdirSync(vault);
    const opts = { env: { EBRAIN_CONFIG: writeTestConfig(base, vault, stateDir) }, homeDir: base, now: () => new Date('2026-10-14T00:00:00Z') };
    new RecallLog(stateDir, { now: () => new Date('2026-05-01T00:00:00Z') }).append({ recall_id: '01JMAR0000000000000000000A', principal: 'p', ids: [] });
    new RecallLog(stateDir, { now: () => new Date('2026-10-10T00:00:00Z') }).append({ recall_id: '01JOCT0000000000000000000A', principal: 'p', ids: [] });
    const r = runRecalls(['prune'], opts);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /kept 2, removed 0 \(older than 180 days\)/);
    const r2 = runRecalls(['prune', '--older-than', '30'], opts);
    assert.match(r2.stdout, /kept 1, removed 1 \(older than 30 days\)/);
    assert.equal(runRecalls([], opts).code, 2);
    assert.equal(runRecalls(['prune', '--older-than', '0'], opts).code, 2);
    assert.equal(runRecalls(['prune', '--older-than'], opts).code, 2);
  });

  it('recallLog.retentionDays: default 180, validated', () => {
    const valid = { vaultPath: '/tmp/v', stateDir: '/tmp/s', principal: { id: 'p', type: 'human' }, mode: 'inbox' };
    assert.equal(DEFAULT_RECALL_RETENTION_DAYS, 180);
    assert.equal(parseConfig(valid).recallLog.retentionDays, 180);
    assert.equal(parseConfig({ ...valid, recallLog: { retentionDays: 30 } }).recallLog.retentionDays, 30);
    for (const bad of [0, -1, 1.5, '30', 40000]) assert.throws(() => parseConfig({ ...valid, recallLog: { retentionDays: bad } }), /recallLog\.retentionDays/);
    assert.throws(() => parseConfig({ ...valid, recallLog: { other: 1 } }));
  });
});
