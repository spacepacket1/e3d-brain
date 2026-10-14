// Phase 5: principal enforcement and the audit log, through dispatch with
// fake tools in every mode: one line per call (rejected, invalid, and
// errored calls included), no secrets / query text / note bodies, segment
// rotation under the lock, readers across segments, prune, and two
// concurrent appenders.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  AUDIT_FILE,
  AuditLog,
  auditLine,
  listSegments,
  MAX_LINE_BYTES,
  REDACTED,
  readAudit,
  segmentBytes,
  serializeLine,
  summarizeArgs,
  type AuditLine,
} from '../src/audit/audit.js';
import { runAudit } from '../src/cli/audit-commands.js';
import type { Mode } from '../src/config.js';
import {
  AUDIT_FAILURE_DETAIL,
  dispatch,
  registerTool,
  ToolRegistry,
  ToolRejection,
  type DispatchContext,
  type DispatchRecord,
} from '../src/mcp/dispatch.js';
import { MAX_CHARS_SCHEMA, type ObjectSchema } from '../src/mcp/schema.js';
import { ensurePrivateDir, type SafePath } from '../src/safe-path.js';
import { mode as fileMode, realTmpDir, rmrf } from './helpers.js';

const run = promisify(execFile);
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit-worker.js');
const MODES: Mode[] = ['inbox', 'journal', 'read-only'];

// Fixture secrets and text that must never reach the audit log.
const SECRETS = [
  'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE',
  'AKIAFAKEFAKEFAKEFAKE',
  'abandon ability able about above absent absorb abstract absurd abuse access accident',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'hunter2-password',
];
const QUERY = 'what did we decide about the treasury multisig';
const BODY = 'NOTE BODY: the vault seed lives in the blue binder';
const CRASH = 'crash detail /etc/passwd';
const ID = '01JALPHA0000000000000000AA';
const REV = '0123456789abcdef';

const SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    path: { type: 'string' },
    ids: { type: 'array', items: { type: 'string' } },
    format: { type: 'string', enum: ['full', 'compact'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    max_chars: MAX_CHARS_SCHEMA,
  },
};

function env(maxSegmentBytes = 50 * 1024 * 1024) {
  const base = realTmpDir();
  const state = ensurePrivateDir(path.join(base, 'state'));
  return { base, state, audit: new AuditLog(state, { maxSegmentBytes }) };
}

function setup(m: Mode, audit: AuditLog) {
  const registry = new ToolRegistry();
  const records: DispatchRecord[] = [];
  registerTool(
    {
      name: 'fake_read',
      modes: MODES,
      schema: SCHEMA,
      auditArgs: { path: 'path', ids: 'id' },
      handler: (args) => {
        if (args['path'] === 'limit') throw new ToolRejection({ type: 'limit', detail: `rate limit ${SECRETS[0]}`, code: 'rate' });
        if (args['path'] === 'scrub') throw new ToolRejection({ type: 'strict-scrub', detail: `found ${SECRETS[3]}`, code: 'openssh-private-key' });
        if (args['path'] === 'bad-code') throw new ToolRejection({ type: 'limit', detail: 'x', code: SECRETS[0] });
        if (args['path'] === 'crash') throw new Error(CRASH);
        return {
          content: [{ type: 'text', text: 'results:' }, { type: 'data', text: BODY, source: `note:${ID}@${REV}` }],
          recall_id: '01JRECALL000000000000000000',
          returned: [{ id: ID, rev: REV }, { id: 'prov_0123456789abcdef0123', rev: REV }],
        };
      },
    },
    registry,
  );
  const ctx: DispatchContext = { mode: m, principal: { id: 'tester', type: 'human' }, maxCharsPerCall: 10000, registry, audit, onRecord: (r) => records.push(r) };
  return { ctx, records };
}

function rawLog(state: string): string {
  return listSegments(state as SafePath).map((s) => fs.readFileSync(s.path, 'utf8')).join('');
}

function lines(state: string): AuditLine[] {
  return readAudit(state as SafePath).lines;
}

function assertClean(text: string): void {
  for (const s of [...SECRETS, QUERY, BODY, CRASH, 'mallory', 'secret-tool-name']) assert.ok(!text.includes(s), `audit log leaks ${JSON.stringify(s)}`);
}

describe('audit log through dispatch', () => {
  it('writes exactly one line per call in every mode, with no secrets, query text, or bodies', async () => {
    for (const m of MODES) {
      const { base, state, audit } = env();
      try {
        const { ctx } = setup(m, audit);
        const calls: [unknown, unknown][] = [
          ['fake_read', { query: `${QUERY} ${SECRETS[0]}`, path: 'notes/a.md', ids: [ID, SECRETS[1]], format: 'compact', limit: 5, max_chars: 2000 }],
          ['fake_read', { query: 'x', limit: 'five' }], // bad argument type
          ['fake_read', { path: 'a.md', author: 'mallory' }],
          ['fake_read', { path: 'a.md', principal: 'mallory' }],
          ['fake_read', { path: 'limit' }],
          ['fake_read', { path: 'scrub' }],
          ['fake_read', { path: 'bad-code' }],
          ['fake_read', { path: 'crash', query: SECRETS[2] }],
          ['secret-tool-name', {}],
          ['fake_read', { path: `/abs/${SECRETS[4]}` }],
        ];
        for (const [name, args] of calls) await dispatch(ctx, name, args);
        const raw = rawLog(state);
        assert.equal(raw.split('\n').filter((l) => l !== '').length, calls.length, `${m}: one line per call`);
        assertClean(raw);
        const ls = lines(state);
        for (const l of ls) {
          assert.equal(l.principal, 'tester');
          assert.equal(l.mode, m);
          assert.ok(!Number.isNaN(Date.parse(l.ts)));
          assert.equal(typeof l.bytes_returned, 'number');
        }
        assert.deepEqual(ls.map((l) => l.outcome), ['ok', 'invalid', 'invalid', 'invalid', 'rejected', 'rejected', 'rejected', 'error', 'invalid', 'ok']);
        const ok = ls[0]!;
        assert.equal(ok.tool, 'fake_read');
        assert.equal(ok.recall_id, '01JRECALL000000000000000000');
        assert.deepEqual(ok.returned, [{ id: ID, rev: REV }, { id: 'prov_0123456789abcdef0123', rev: REV }]);
        assert.equal(ok.result_count, 2);
        assert.deepEqual(ok.args_summary, {
          query: REDACTED,
          path: 'notes/a.md',
          ids: { count: 2, items: [ID, REDACTED] },
          format: 'compact',
          limit: 5,
          max_chars: 2000,
        });
        // Rejected by schema (author/principal are never arguments) and still audited.
        for (const l of ls.slice(1, 4)) {
          assert.deepEqual(l.error, { type: 'invalid' });
          assert.deepEqual(l.args_summary, {});
        }
        assert.deepEqual(ls[4]!.error, { type: 'limit', code: 'rate' });
        assert.deepEqual(ls[5]!.error, { type: 'strict-scrub', code: 'openssh-private-key' });
        assert.deepEqual(ls[6]!.error, { type: 'limit' }, 'a code that is not a short token is dropped');
        assert.deepEqual(ls[7]!.error, { type: 'internal' });
        assert.equal(ls[7]!.args_summary.query, REDACTED);
        assert.equal(ls[8]!.tool, '(unknown)');
        assert.equal(ls[9]!.args_summary.path, REDACTED, 'absolute paths are not path-shaped');
        assert.equal(fileMode(path.join(state, AUDIT_FILE)), 0o600);
      } finally {
        rmrf(base);
      }
    }
  });

  it('a tool of another mode is logged as unknown', async () => {
    const { base, state, audit } = env();
    try {
      const registry = new ToolRegistry();
      registerTool({ name: 'fake_capture', modes: ['inbox'], schema: { type: 'object', properties: {} }, handler: () => ({ content: 'ok' }) }, registry);
      const ctx: DispatchContext = { mode: 'read-only', principal: { id: 'tester', type: 'human' }, maxCharsPerCall: 10000, registry, audit };
      await dispatch(ctx, 'fake_capture', {});
      const [l] = lines(state);
      assert.equal(l!.tool, '(unknown)');
      assert.equal(l!.outcome, 'invalid');
    } finally {
      rmrf(base);
    }
  });

  it('is never truncated across server restarts', async () => {
    const { base, state, audit } = env();
    try {
      await dispatch(setup('inbox', audit).ctx, 'fake_read', { path: 'a.md' });
      const before = fs.readFileSync(path.join(state, AUDIT_FILE));
      // A restarted server: a fresh AuditLog over the same state dir.
      const again = new AuditLog(state, { maxSegmentBytes: 50 * 1024 * 1024 });
      await dispatch(setup('read-only', again).ctx, 'fake_read', { path: 'b.md' });
      const after = fs.readFileSync(path.join(state, AUDIT_FILE));
      assert.ok(after.subarray(0, before.length).equals(before), 'earlier bytes kept');
      assert.deepEqual(lines(state).map((l) => l.mode), ['inbox', 'read-only']);
    } finally {
      rmrf(base);
    }
  });

  it('turns an audit write failure into an error response', async () => {
    const { base, state, audit } = env();
    try {
      fs.mkdirSync(path.join(state, AUDIT_FILE)); // not a regular file
      const res = await dispatch(setup('inbox', audit).ctx, 'fake_read', { path: 'a.md' });
      assert.equal(res.isError, true);
      assert.deepEqual(res.structuredContent, { error: { type: 'internal', detail: AUDIT_FAILURE_DETAIL } });
      assert.ok(!res.content[0]!.text.includes(BODY));
    } finally {
      rmrf(base);
    }
  });

  it('registerTool checks auditArgs', () => {
    const registry = new ToolRegistry();
    const h = () => ({ content: '' });
    assert.throws(() => registerTool({ name: 'a', modes: ['inbox'], schema: SCHEMA, auditArgs: { nope: 'path' }, handler: h }, registry), /unknown argument/);
    assert.throws(() => registerTool({ name: 'b', modes: ['inbox'], schema: SCHEMA, auditArgs: { path: 'body' as 'path' }, handler: h }, registry), /audit kind/);
  });
});

describe('audit line building', () => {
  it('summarizeArgs keeps only paths, ids, enums, numbers, booleans, and counts', () => {
    const s = summarizeArgs(
      { query: QUERY, path: 'a/b c.md', ids: [`note:${ID}@${REV}`, 'not an id'], nested: { q: QUERY, n: 3 }, flag: true, tags: ['x', 'y'] },
      SCHEMA,
      { path: 'path', ids: 'id' },
    );
    assert.deepEqual(s, {
      query: REDACTED,
      path: 'a/b c.md',
      ids: { count: 2, items: [`note:${ID}@${REV}`, REDACTED] },
      nested: { q: REDACTED, n: 3 },
      flag: true,
      tags: { count: 2 },
    });
    assert.equal(summarizeArgs({ path: 'a\u0000b' }, SCHEMA, { path: 'path' }).path, REDACTED);
    assert.equal(summarizeArgs({ path: 'a\\..\\b' }, SCHEMA, { path: 'path' }).path, REDACTED);
    assert.equal(summarizeArgs({ format: 'other' }, SCHEMA).format, REDACTED);
    // Credential-shaped values are redacted even where an id or path is declared.
    assert.equal(summarizeArgs({ path: 'notes/AKIAFAKEFAKEFAKEFAKE.md' }, SCHEMA, { path: 'path' }).path, REDACTED);
    assert.deepEqual(summarizeArgs({ ids: ['ghp_FAKEFAKEFAKEFAKEFAKEFAKE'] }, SCHEMA, { ids: 'id' }).ids, { count: 1 });
  });

  it('caps line size by truncating the returned list', () => {
    const returned = Array.from({ length: 500 }, (_, i) => ({ id: `01JALPHA00000000000000${String(i).padStart(4, '0')}`, rev: REV }));
    const record: DispatchRecord = { tool: 'fake_read', mode: 'inbox', principal: 'tester', outcome: 'ok', bytes_returned: 10, result_count: 500, recall_id: 'R', returned };
    const text = serializeLine(auditLine(record, {}));
    assert.ok(Buffer.byteLength(text) <= MAX_LINE_BYTES);
    const l = JSON.parse(text) as AuditLine;
    assert.equal(l.returned_truncated, true);
    assert.ok(l.returned!.length > 10 && l.returned!.length < 500);
    assert.deepEqual(l.returned!.slice(0, 2), returned.slice(0, 2));
    assert.equal(l.result_count, 500);
    // Small lines are untouched.
    const small = JSON.parse(serializeLine(auditLine({ ...record, returned: returned.slice(0, 3) }, {}))) as AuditLine;
    assert.equal(small.returned_truncated, undefined);
    assert.equal(small.returned!.length, 3);
  });
});

describe('audit segments', () => {
  function cfg(base: string, state: string, maxSegmentMB: number): { env: NodeJS.ProcessEnv; homeDir: string } {
    const vault = path.join(base, 'vault');
    fs.mkdirSync(vault, { recursive: true });
    const file = path.join(base, 'config.json');
    const body = { vaultPath: vault, stateDir: state, principal: { id: 'tester', type: 'human' }, mode: 'inbox', audit: { maxSegmentMB } };
    fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return { env: { EBRAIN_CONFIG: file }, homeDir: base };
  }

  it('starts a new segment past the threshold; tail and stats read both in order; prune deletes whole old segments', async () => {
    const maxSegmentMB = 0.002; // ~2 KiB
    const base = realTmpDir();
    try {
      const state = ensurePrivateDir(path.join(base, 'state'));
      const opts = cfg(base, state, maxSegmentMB);
      const audit = new AuditLog(state, { maxSegmentBytes: segmentBytes(maxSegmentMB) });
      const { ctx } = setup('inbox', audit);
      const N = 30;
      for (let i = 0; i < N; i++) await dispatch(ctx, 'fake_read', { path: `n${String(i).padStart(2, '0')}.md` });
      const segs = listSegments(state).map((s) => s.name);
      assert.ok(segs.length >= 2, 'rotated');
      assert.equal(segs[0], AUDIT_FILE);
      assert.equal(segs[1], `${AUDIT_FILE}.1`);
      for (const s of listSegments(state).slice(0, -1)) {
        const size = fs.statSync(s.path).size;
        assert.ok(size >= segmentBytes(maxSegmentMB) && size < segmentBytes(maxSegmentMB) + MAX_LINE_BYTES, 'rotation at the threshold');
        assert.equal(fileMode(s.path), 0o600);
      }
      const segAt = segs.length;
      const firstBytes = fs.readFileSync(path.join(state, AUDIT_FILE));

      const tail = runAudit(['tail', '-n', String(N)], opts);
      assert.equal(tail.code, 0, tail.stderr);
      const tailed = tail.stdout.trim().split('\n').map((l) => JSON.parse(l) as AuditLine);
      assert.deepEqual(tailed.map((l) => l.args_summary.path), Array.from({ length: N }, (_, i) => `n${String(i).padStart(2, '0')}.md`));
      const last3 = runAudit(['tail', '-n', '3'], opts).stdout.trim().split('\n');
      assert.deepEqual(last3.map((l) => (JSON.parse(l) as AuditLine).args_summary.path), ['n27.md', 'n28.md', 'n29.md']);

      const stats = runAudit(['stats'], opts);
      assert.equal(stats.code, 0, stats.stderr);
      assert.match(stats.stdout, new RegExp(`^segments: ${segAt}$`, 'm'));
      assert.match(stats.stdout, new RegExp(`^lines: ${N}$`, 'm'));
      assert.match(stats.stdout, /^by outcome: ok=30$/m);
      assert.match(stats.stdout, /^ {2}audit\.jsonl: \d+ lines/m);
      assert.match(stats.stdout, /^ {2}audit\.jsonl\.1: \d+ lines/m);

      // Earlier segments are untouched by later writes.
      await dispatch(ctx, 'fake_read', { path: 'later.md' });
      assert.ok(fs.readFileSync(path.join(state, AUDIT_FILE)).equals(firstBytes));

      // Prune: nothing is old yet; then age all but the newest two segments.
      assert.match(runAudit(['prune', '--older-than', '1'], opts).stdout, /pruned 0 segment/);
      const all = listSegments(state);
      const old = new Date(Date.now() - 10 * 86_400_000);
      for (const s of all) fs.utimesSync(s.path, old, old);
      const keepFrom = all.length - 2;
      for (const s of all.slice(keepFrom)) fs.utimesSync(s.path, new Date(), new Date());
      const sizes = new Map(all.map((s) => [s.name, fs.statSync(s.path).size]));
      const pr = runAudit(['prune', '--older-than', '5'], opts);
      assert.equal(pr.code, 0, pr.stderr);
      const remaining = listSegments(state);
      assert.deepEqual(remaining.map((s) => s.name), all.slice(keepFrom).map((s) => s.name));
      for (const s of remaining) assert.equal(fs.statSync(s.path).size, sizes.get(s.name), 'kept segments untouched');
      // Even if everything is old, the current segment stays.
      for (const s of remaining) fs.utimesSync(s.path, old, old);
      runAudit(['prune', '--older-than', '0'], opts);
      assert.deepEqual(listSegments(state).map((s) => s.name), [all[all.length - 1]!.name]);
      // New lines continue in the current segment, and numbering never reuses a pruned name.
      await dispatch(ctx, 'fake_read', { path: 'after-prune.md' });
      assert.equal(lines(state).at(-1)!.args_summary.path, 'after-prune.md');
      assert.ok(!fs.existsSync(path.join(state, AUDIT_FILE)));
    } finally {
      rmrf(base);
    }
  });

  it('CLI usage errors and empty log', () => {
    const base = realTmpDir();
    try {
      const state = path.join(base, 'state');
      const opts = cfg(base, state, 50);
      assert.equal(runAudit([], opts).code, 2);
      assert.equal(runAudit(['tail', '-n', '0'], opts).code, 2);
      assert.equal(runAudit(['prune'], opts).code, 2);
      assert.equal(runAudit(['prune', '--older-than', '-1'], opts).code, 2);
      assert.equal(runAudit(['stats', 'x'], opts).code, 2);
      const t = runAudit(['tail'], opts);
      assert.equal(t.code, 0, t.stderr);
      assert.equal(t.stdout, '');
      assert.match(runAudit(['stats'], opts).stdout, /^segments: 0$/m);
    } finally {
      rmrf(base);
    }
  });

  it('two concurrent processes past the threshold: no torn lines, exactly one new segment', async () => {
    const base = realTmpDir();
    try {
      const state = ensurePrivateDir(path.join(base, 'state'));
      const calls = 150;
      // Each line is ~300 bytes; 2 x 150 lines is ~90 KB, so a 60 KB threshold is crossed once.
      const threshold = 60_000;
      await Promise.all(['p1', 'p2'].map((tag) => run(process.execPath, [WORKER, state, String(threshold), String(calls), tag])));
      const segs = listSegments(state);
      assert.deepEqual(segs.map((s) => s.name), [AUDIT_FILE, `${AUDIT_FILE}.1`]);
      const r = readAudit(state);
      assert.equal(r.malformed, 0, 'no torn lines');
      assert.equal(r.lines.length, calls * 2);
      for (const tag of ['p1', 'p2']) {
        const seen = r.lines.filter((l) => String(l.args_summary.path).startsWith(`${tag}/`)).map((l) => String(l.args_summary.path));
        assert.equal(new Set(seen).size, calls, `${tag}: every call logged once`);
      }
      for (const s of segs) {
        const text = fs.readFileSync(s.path, 'utf8');
        assert.ok(text.endsWith('\n'));
      }
      assert.deepEqual(fs.readdirSync(path.join(state, 'locks')), [], 'audit lock released');
    } finally {
      rmrf(base);
    }
  });
});
