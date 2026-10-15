// Phase 10: conversation importers and the raw archive. Parsers (only real
// human/assistant text, malformed lines counted), the safe zip reader
// (zip-slip, absolute and backslash names, oversized entries, entry count,
// total size, lying headers), the archive writer (stable ids, occurred =
// conversation start, idempotent re-runs, atomic updates, dry run, human
// principal only), the CLI end to end (counts, scrub findings, no secrets in
// the vault, hostile archives write nothing), and raw notes in search (T6,
// `raw-archive` label, notice).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AuditLog } from '../src/audit/audit.js';
import { isNoteId } from '../src/cite/citation.js';
import { runConversationImport } from '../src/cli/import-commands.js';
import { archiveConversations, archiveId, ARCHIVE_ID_RE, ImportRefusedError, RAW_CONVERSATIONS_DIR } from '../src/import/archive.js';
import { loadClaudeCode, loadExport } from '../src/import/load.js';
import { ClaudeCodeCollector, emptyStats, parseChatgptExport, parseClaudeExport, type Conversation } from '../src/import/sources.js';
import { DEFAULT_ZIP_LIMITS, entryNameProblem, readZipEntries, ZipRejectedError } from '../src/import/zip.js';
import { closeIndex, openIndex } from '../src/index/indexer.js';
import { dispatch, ToolRegistry } from '../src/mcp/dispatch.js';
import { RAW_NOTICE, registerReadTools } from '../src/mcp/tools.js';
import { ensurePrivateDir, openExternalFile, type SafePath } from '../src/safe-path.js';
import { scrub } from '../src/scrub/index.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { CODE_SESSION_A, CODE_SESSION_B, writeConversationFixtures, type FixtureManifest } from './conversation-fixtures.js';
import { realTmpDir, rmrf, treeChecksum, writeTestConfig } from './helpers.js';
import { buildZip } from './zip-writer.js';

const bases: string[] = [];
after(() => {
  for (const b of bases) rmrf(b);
});

let fx: FixtureManifest;
before(() => {
  const dir = realTmpDir('ebrain-p10-fx-');
  bases.push(dir);
  fx = writeConversationFixtures(dir);
});

const NOW = new Date('2026-10-14T12:00:00Z');

interface Env {
  base: string;
  vault: string;
  stateDir: SafePath;
  env: NodeJS.ProcessEnv;
}

function makeEnv(type: 'human' | 'agent' = 'human'): Env {
  const base = realTmpDir('ebrain-p10-');
  bases.push(base);
  const vault = path.join(base, 'vault');
  fs.mkdirSync(vault);
  const stateDir = ensurePrivateDir(path.join(base, 'state'));
  let config = writeTestConfig(base, vault, stateDir);
  if (type === 'agent') {
    config = path.join(base, 'agent.json');
    fs.writeFileSync(config, JSON.stringify({ vaultPath: vault, stateDir, principal: { id: 'bot', type: 'agent' }, mode: 'journal' }), { mode: 0o600 });
  }
  return { base, vault, stateDir, env: { EBRAIN_CONFIG: config } };
}

function allFiles(dir: string, rel = ''): string[] {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...allFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}

function frontmatter(file: string): Record<string, unknown> {
  return parseYaml(splitFrontmatter(fs.readFileSync(file, 'utf8')).yaml ?? '') as Record<string, unknown>;
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

async function importCli(e: Env, args: string[]) {
  return runConversationImport(args, { env: e.env, now: () => NOW });
}

function summaryCounts(stdout: string): { conversations: number; turns: number; created: number; updated: number; unchanged: number } {
  const m = /import [a-z-]+: (\d+) conversations, (\d+) turns \((\d+) (?:would create|created), (\d+) (?:would update|updated), (\d+) unchanged\)/.exec(stdout);
  assert.ok(m, stdout);
  return { conversations: Number(m[1]), turns: Number(m[2]), created: Number(m[3]), updated: Number(m[4]), unchanged: Number(m[5]) };
}

describe('conversation parsers', () => {
  it('Claude Code: keeps human and assistant text only, merges streamed blocks, counts malformed lines', () => {
    const loaded = loadClaudeCode(fx.projectsDir);
    const byId = new Map(loaded.conversations.map((c) => [c.conversationId, c]));
    assert.deepEqual([...byId.keys()].sort(), [CODE_SESSION_A, CODE_SESSION_B].sort());
    const a = byId.get(CODE_SESSION_A)!;
    assert.deepEqual(a.turns.map((t) => t.role), ['user', 'assistant', 'assistant', 'user']);
    assert.equal(a.title, 'Deploying the service');
    assert.equal(a.turns[0]!.at, '2026-03-01T10:00:00Z');
    const all = loaded.conversations.flatMap((c) => c.turns.map((t) => t.text)).join('\n');
    for (const dropped of ['Caveat', '/clear', 'secret plan thoughts', 'tool output text', 'subagent chatter', '"command"']) {
      assert.ok(!all.includes(dropped), dropped);
    }
    assert.ok(all.includes('codecheckmarker'));
    assert.equal(loaded.stats.malformedLines, fx.expected['claude-code'].malformed);
    assert.equal(loaded.files, 4);
  });

  it('Claude Code: tolerates arbitrary garbage lines and unknown record types', () => {
    const c = new ClaudeCodeCollector();
    c.addFile(['', 'null', '"str"', '{"type":"user"}', '{"type":"user","sessionId":"../x","message":{"content":"hi"}}', '{"type":"weird"}', '\u0000'].join('\n'), 'stem');
    assert.deepEqual(c.conversations(), []);
    assert.equal(c.stats.malformedLines, 5);
  });

  it('Claude export: content blocks preferred over text, thinking and tools dropped, malformed records counted', () => {
    const stats = emptyStats();
    const convs = parseClaudeExport(read(path.join(fx.claudeExportDir, 'conversations.json')), stats);
    assert.equal(convs.length, 3);
    assert.deepEqual(convs.map((c) => c.turns.length), [2, 3, 0]);
    const text = convs.flatMap((c) => c.turns.map((t) => t.text)).join('\n');
    assert.ok(!text.includes('ignored when content exists') && !text.includes('hidden reasoning'));
    assert.equal(stats.malformedConversations, 2);
    assert.equal(convs[1]!.title, undefined);
  });

  it('ChatGPT export: follows the current thread, drops system, tool, hidden, code and thoughts', async () => {
    const loaded = await loadExport('chatgpt-export', fx.chatgptExportZip);
    const [g1, g2] = loaded.conversations;
    assert.deepEqual(g1!.turns.map((t) => [t.role, t.text]), [
      ['user', 'Review the budget. chatgptmarker'],
      ['assistant', 'The budget looks fine.'],
      ['user', g1!.turns[2]!.text],
      ['assistant', 'Never share that key.'],
    ]);
    assert.equal(g1!.created, '2026-01-01T00:00:00Z');
    assert.deepEqual(g2!.turns.map((t) => t.text), ['How long is a year?', 'About 365 days.']);
    assert.equal(loaded.stats.malformedConversations, 1);
  });

  it('ChatGPT export: survives a parent cycle', () => {
    const json = JSON.stringify([{ id: 'cyc', current_node: 'a', mapping: {
      a: { parent: 'b', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['A'] } } },
      b: { parent: 'a', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['B'] } } },
    } }]);
    const convs = parseChatgptExport(json, emptyStats());
    assert.equal(convs[0]!.turns.length, 2);
  });
});

describe('safe zip reading', () => {
  const open = (p: string) => openExternalFile(p, [path.dirname(p)]);
  async function rejects(p: string, code: string | RegExp, limits = DEFAULT_ZIP_LIMITS) {
    const f = open(p);
    try {
      await assert.rejects(readZipEntries(f, () => true, limits), (err: unknown) => {
        assert.ok(err instanceof ZipRejectedError, String(err));
        assert.match(err.code, typeof code === 'string' ? new RegExp(`^${code}$`) : code);
        return true;
      });
    } finally {
      f.close();
    }
  }

  it('entry name rules', () => {
    for (const bad of ['../../evil.md', '/abs.md', 'C:/x.md', 'a\\b.md', 'a/../b', './a', 'a//b', 'a\u0000b', '']) {
      assert.ok(entryNameProblem(bad) !== undefined, JSON.stringify(bad));
    }
    for (const good of ['conversations.json', 'dir/', 'a/b/c.json', 'données/ü.json', '..a/b..']) assert.equal(entryNameProblem(good), undefined, good);
  });

  it('reads only the wanted entries of a normal archive', async () => {
    const f = open(fx.claudeExportZip);
    try {
      const out = await readZipEntries(f, (n) => n === 'conversations.json');
      assert.deepEqual([...out.keys()], ['conversations.json']);
      assert.equal(out.get('conversations.json')!.toString('utf8'), read(path.join(fx.claudeExportDir, 'conversations.json')));
    } finally {
      f.close();
    }
  });

  it('rejects zip-slip, absolute, and backslash names even for unread entries', async () => {
    await rejects(fx.hostile.zipSlip, 'entry-name');
    await rejects(fx.hostile.absolute, 'entry-name');
    await rejects(fx.hostile.backslash, 'entry-name');
  });

  it('rejects oversized entries, too many entries, too much in total, and lying headers', async () => {
    await rejects(fx.hostile.oversized, 'entry-size');
    await rejects(fx.hostile.tooMany, 'entry-count');
    await rejects(fx.hostile.bomb, 'entry-size');
    const dir = path.dirname(fx.hostile.bomb);
    const big = path.join(dir, 'big-real.zip');
    fs.writeFileSync(big, buildZip([{ name: 'conversations.json', data: Buffer.alloc(3 * 1024 * 1024, 0x20) }]));
    await rejects(big, 'entry-size', { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1024 * 1024 });
    const many = path.join(dir, 'total.zip');
    fs.writeFileSync(many, buildZip([0, 1, 2].map((i) => ({ name: `p${i}.bin`, data: Buffer.alloc(600 * 1024) }))));
    await rejects(many, 'total-size', { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 });
    const notZip = path.join(dir, 'garbage.zip');
    fs.writeFileSync(notZip, 'PK\x03\x04 garbage');
    await rejects(notZip, 'malformed');
  });
});

describe('raw archive writer', () => {
  const conv = (over: Partial<Conversation> = {}): Conversation => ({
    source: 'claude-export',
    conversationId: 'conv-1',
    title: 'A title',
    created: '2026-05-01T10:00:00Z',
    turns: [
      { role: 'user', text: 'hello rawwritermarker', at: '2026-05-01T10:00:05Z' },
      { role: 'assistant', text: 'hi', at: '2026-05-01T10:00:09Z' },
    ],
    ...over,
  });

  it('archive ids are stable, source-scoped, and valid note ids', () => {
    const id = archiveId('claude-export', 'conv-1');
    assert.equal(id, archiveId('claude-export', 'conv-1'));
    assert.notEqual(id, archiveId('chatgpt-export', 'conv-1'));
    assert.match(id, ARCHIVE_ID_RE);
    assert.ok(isNoteId(id));
  });

  it('writes the spec frontmatter, keeps identity on re-import, and replaces updated conversations atomically', () => {
    const e = makeEnv();
    const opts = { vaultPath: e.vault, stateDir: e.stateDir, principal: { id: 'tester', type: 'human' as const }, now: NOW };
    const r1 = archiveConversations([conv()], opts);
    assert.equal(r1.created, 1);
    const rel = `${RAW_CONVERSATIONS_DIR}/claude-export/2026/${archiveId('claude-export', 'conv-1')}.md`;
    assert.deepEqual(r1.files, [{ path: rel, action: 'created' }]);
    const file = path.join(e.vault, rel);
    const fm = frontmatter(file);
    assert.deepEqual(Object.keys(fm), [
      'schema', 'id', 'title', 'kind', 'source', 'conversation_id', 'started', 'ended', 'occurred', 'turns', 'origin', 'author', 'created', 'scrubVersion',
    ]);
    assert.equal(fm['id'], archiveId('claude-export', 'conv-1'));
    assert.equal(fm['kind'], 'raw');
    assert.equal(fm['started'], '2026-05-01T10:00:00Z');
    assert.equal(fm['occurred'], fm['started']);
    assert.equal(fm['ended'], '2026-05-01T10:00:09Z');
    assert.equal(fm['turns'], 2);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const before = read(file);

    const later = { ...opts, now: new Date('2027-01-01T00:00:00Z') };
    const r2 = archiveConversations([conv()], later);
    assert.equal(r2.unchanged, 1);
    assert.equal(read(file), before);

    const r3 = archiveConversations([conv({ turns: [...conv().turns, { role: 'user', text: 'more', at: '2026-05-02T00:00:00Z' }] })], later);
    assert.equal(r3.updated, 1);
    const fm3 = frontmatter(file);
    assert.equal(fm3['id'], fm['id']);
    assert.equal(fm3['created'], fm['created']);
    assert.equal(fm3['turns'], 3);
    assert.deepEqual(allFiles(e.vault), [rel]);
  });

  it('keeps an existing file when the start year changes, and dedups repeated ids', () => {
    const e = makeEnv();
    const opts = { vaultPath: e.vault, stateDir: e.stateDir, principal: { id: 'tester', type: 'human' as const }, now: NOW };
    archiveConversations([conv()], opts);
    const r = archiveConversations([conv({ created: '2025-12-31T00:00:00Z' }), conv()], opts);
    assert.equal(r.duplicates, 1);
    assert.equal(r.updated, 1);
    assert.equal(allFiles(e.vault).length, 1);
  });

  it('dry run writes nothing; empty and timeless conversations are counted', () => {
    const e = makeEnv();
    const opts = { vaultPath: e.vault, stateDir: e.stateDir, principal: { id: 'tester', type: 'human' as const }, now: NOW, dryRun: true };
    const r = archiveConversations([conv(), conv({ conversationId: 'e', turns: [] }), conv({ conversationId: 't', created: undefined, turns: [{ role: 'user', text: 'x' }] })], opts);
    assert.equal(r.created, 1);
    assert.equal(r.empty, 1);
    assert.deepEqual(r.skipped, [{ conversationId: 't', reason: 'no valid timestamp' }]);
    assert.deepEqual(allFiles(e.vault), []);
    assert.deepEqual(allFiles(e.stateDir), []);
  });

  it('refuses an agent principal', () => {
    const e = makeEnv();
    assert.throws(() => archiveConversations([conv()], { vaultPath: e.vault, stateDir: e.stateDir, principal: { id: 'bot', type: 'agent' } }), ImportRefusedError);
    assert.deepEqual(allFiles(e.vault), []);
  });

  it('refuses a symlinked _raw directory', () => {
    const e = makeEnv();
    const outside = path.join(e.base, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(e.vault, '_raw'));
    assert.throws(() => archiveConversations([conv()], { vaultPath: e.vault, stateDir: e.stateDir, principal: { id: 'tester', type: 'human' } }));
    assert.deepEqual(allFiles(outside), []);
  });
});

describe('ebrain import (CLI)', () => {
  for (const [source, input] of [
    ['claude-code', () => ['--projects-dir', fx.projectsDir]],
    ['claude-export', () => [fx.claudeExportZip]],
    ['chatgpt-export', () => [fx.chatgptExportZip]],
  ] as const) {
    it(`${source}: counts match, secrets redacted and reported, re-run is a no-op`, async () => {
      const e = makeEnv();
      const dry = await importCli(e, [source, ...input(), '--dry-run']);
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /^dry run: /m);
      assert.deepEqual(allFiles(e.vault), []);
      const exp = fx.expected[source];
      assert.deepEqual(summaryCounts(dry.stdout), { conversations: exp.conversations, turns: exp.turns, created: exp.conversations, updated: 0, unchanged: 0 });

      const r = await importCli(e, [source, ...input()]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(summaryCounts(r.stdout), { conversations: exp.conversations, turns: exp.turns, created: exp.conversations, updated: 0, unchanged: 0 });
      assert.match(r.stdout, new RegExp(`${exp.malformed} malformed (?:lines|records)`));
      const findings = /scrub findings: (.*)$/m.exec(r.stdout)![1]!;
      assert.notEqual(findings, 'none');
      assert.equal(/scrub findings: (.*)$/m.exec(dry.stdout)![1], findings);

      const files = allFiles(e.vault);
      assert.equal(files.length, exp.conversations);
      const all = files.map((f) => read(path.join(e.vault, f))).join('\n');
      for (const s of fx.secrets) assert.ok(!all.includes(s), 'secret reached the vault');
      assert.ok(all.includes('[REDACTED:'));
      for (const s of fx.secrets) {
        const sr = scrub(s);
        assert.ok(sr.ok);
        if (all.includes(sr.text)) for (const f of sr.findings) assert.ok(findings.includes(`${f.type}: `), f.type);
      }
      for (const f of files) {
        const fm = frontmatter(path.join(e.vault, f));
        assert.match(f, new RegExp(`^_raw/conversations/${source}/\\d{4}/${fm['id']}\\.md$`));
        assert.equal(fm['id'], archiveId(source, fm['conversation_id'] as string));
        assert.equal(fm['occurred'], fx.starts[`${source}/${fm['conversation_id']}`]);
        assert.equal(fm['occurred'], fm['started']);
        assert.equal(f.split('/')[3], (fm['started'] as string).slice(0, 4));
      }

      const sum = treeChecksum(e.vault);
      const again = await runConversationImport([source, ...input()], { env: e.env, now: () => new Date('2027-06-01T00:00:00Z') });
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(summaryCounts(again.stdout), { conversations: exp.conversations, turns: exp.turns, created: 0, updated: 0, unchanged: exp.conversations });
      assert.equal(treeChecksum(e.vault), sum);
    });
  }

  it('claude-export from an unpacked directory matches the zip', async () => {
    const e = makeEnv();
    assert.equal((await importCli(e, ['claude-export', fx.claudeExportZip])).code, 0);
    const sum = treeChecksum(e.vault);
    const r = await importCli(e, ['claude-export', fx.claudeExportDir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(summaryCounts(r.stdout).unchanged, 2);
    assert.equal(treeChecksum(e.vault), sum);
  });

  it('hostile archives are rejected and nothing is written', async () => {
    const e = makeEnv();
    const hostileParent = path.dirname(path.dirname(fx.hostile.zipSlip));
    const sumFx = treeChecksum(hostileParent);
    for (const [name, p] of Object.entries(fx.hostile)) {
      for (const source of ['claude-export', 'chatgpt-export']) {
        const r = await importCli(e, [source, p]);
        assert.equal(r.code, 1, `${name}: ${r.stdout}`);
        assert.match(r.stderr, /archive rejected/, name);
      }
    }
    assert.deepEqual(allFiles(e.vault), []);
    assert.deepEqual(allFiles(e.stateDir), []);
    assert.equal(treeChecksum(hostileParent), sumFx);
    assert.ok(!fs.existsSync(path.join(path.dirname(hostileParent), 'evil.md')));
  });

  it('refuses an agent principal, unknown flags, and a non-zip file', async () => {
    const agent = makeEnv('agent');
    const r = await importCli(agent, ['claude-code', '--projects-dir', fx.projectsDir]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /human principal/);
    assert.deepEqual(allFiles(agent.vault), []);
    const e = makeEnv();
    for (const flag of ['--no-scrub', '--skip-scrub']) assert.equal((await importCli(e, ['claude-export', fx.claudeExportZip, flag])).code, 2);
    assert.equal((await importCli(e, ['claude-export'])).code, 2);
    assert.equal((await importCli(e, ['claude-code', 'extra'])).code, 2);
    const txt = path.join(e.base, 'x.zip');
    fs.writeFileSync(txt, 'not a zip');
    const nz = await importCli(e, ['claude-export', txt]);
    assert.equal(nz.code, 1);
    assert.match(nz.stderr, /not a zip/);
  });

  it('skips a symlinked transcript that escapes the projects directory', async () => {
    const e = makeEnv();
    const proj = path.join(e.base, 'projects', 'p');
    fs.mkdirSync(proj, { recursive: true });
    fs.copyFileSync(path.join(fx.projectsDir, '-home-u-other', `${CODE_SESSION_B}.jsonl`), path.join(e.base, 'outside.jsonl'));
    fs.symlinkSync(path.join(e.base, 'outside.jsonl'), path.join(proj, 'link.jsonl'));
    const r = await importCli(e, ['claude-code', '--projects-dir', path.join(e.base, 'projects')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skipped file p\/link\.jsonl: symlink/);
    assert.equal(summaryCounts(r.stdout).conversations, 0);
  });
});

describe('raw notes in search (T6)', () => {
  it('rank below curated notes, carry kind raw, the raw-archive label, and a notice', async () => {
    const e = makeEnv();
    fs.mkdirSync(path.join(e.vault, 'notes'));
    fs.writeFileSync(path.join(e.vault, 'notes', 'curated.md'), '# Curated\n\nchatgptmarker in a curated note\n');
    assert.equal((await importCli(e, ['chatgpt-export', fx.chatgptExportZip])).code, 0);
    const index = openIndex({ vaultPath: e.vault, stateDir: e.stateDir });
    try {
      const registry = new ToolRegistry();
      registerReadTools({ vaultPath: e.vault, index, now: () => NOW, mode: 'inbox' }, registry);
      const audit = new AuditLog(e.stateDir, { maxSegmentBytes: 1024 * 1024 });
      const res = await dispatch(
        { mode: 'inbox', principal: { id: 'tester', type: 'human' }, maxCharsPerCall: 10000, registry, audit },
        'search',
        { query: 'chatgptmarker' },
      );
      assert.notEqual(res.isError, true);
      const lines = res.content[0]!.text.split('\n');
      const header = JSON.parse(lines[0]!) as Record<string, unknown>;
      assert.ok(String(header['notice']).includes(RAW_NOTICE));
      const open = lines.findIndex((l) => /^`{3,}text$/.test(l));
      const fence = lines[open]!.slice(0, -4);
      const close = lines.findIndex((l, i) => i > open && l === fence);
      const rows = lines.slice(open + 1, close).map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.deepEqual(rows.map((r) => [r['folder_class'], r['tier']]), [['curated', 1], ['raw', 6]]);
      assert.equal(rows[1]!['kind'], 'raw');
      assert.deepEqual(rows[1]!['labels'], ['raw-archive']);
      assert.equal(rows[1]!['id'], archiveId('chatgpt-export', '6a7b8c9d-0000-4000-8000-0000000000a1'));
      assert.equal(rows[1]!['occurred'], '2026-01-01T00:00:00Z');
    } finally {
      closeIndex(index);
    }
  });
});
