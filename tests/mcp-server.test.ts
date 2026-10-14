// Phase 6 integration: spawn `ebrain mcp`, do the MCP handshake, list tools
// in every mode (against the registry fixture), and exercise every read tool
// against the fixture vault: path containment, fencing of hostile content,
// result fields and citations, as_of and visibility filters, size caps,
// refresh-on-read, stdout hygiene, and one audit line per call.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkNoteCitation, parseCitation, type NoteCitation } from '../src/cite/citation.js';
import { openIndexDb } from '../src/index/db.js';
import { noteLookup } from '../src/index/identity.js';
import { ULID_RE } from '../src/mcp/ulid.js';
import { resolveInState } from '../src/safe-path.js';
import { materializeFixture, realTmpDir, repoRoot, rmrf } from './helpers.js';
import { fencedBlock, header, McpProcess, results, type ToolResponse } from './mcp-client.js';
import { expectedTools, TOOL_MODES, type ToolMode } from './tool-registry.js';

const PHASE = 6;
const cli = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
const OUTSIDE_CANARY = 'OUTSIDE-SECRET-CANARY';

interface Instance {
  base: string;
  vault: string;
  stateDir: string;
  config: string;
}

const bases: string[] = [];

function makeInstance(mode: ToolMode, extra: Record<string, unknown> = {}): Instance {
  const base = realTmpDir('ebrain-p6-');
  bases.push(base);
  const vault = materializeFixture(base);
  fs.cpSync(path.join(repoRoot(), 'tests', 'fixtures', 'mcp-notes'), vault, { recursive: true });
  const stateDir = path.join(base, 'state');
  const config = path.join(base, 'config.json');
  const principal = { id: 'tester', type: mode === 'journal' ? 'agent' : 'human' };
  fs.writeFileSync(config, JSON.stringify({ vaultPath: vault, stateDir, principal, mode, ...extra }), { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  return { base, vault, stateDir, config };
}

function auditLines(stateDir: string): Record<string, unknown>[] {
  const file = path.join(stateDir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

function text(r: ToolResponse): string {
  return r.content[0]!.text;
}

function paths(r: ToolResponse): string[] {
  return results(r).map((x) => String(x['path']));
}

function assertOk(r: ToolResponse, what: string): void {
  assert.notEqual(r.isError, true, `${what}: ${text(r)}`);
}

function assertFramesOnly(m: McpProcess): void {
  assert.equal(m.partialStdout, '', 'stdout ended mid-line');
  assert.ok(m.stdoutLines.length > 0);
  for (const line of m.stdoutLines) {
    const msg = JSON.parse(line) as Record<string, unknown>;
    assert.equal(msg['jsonrpc'], '2.0', `non-protocol stdout line: ${line.slice(0, 80)}`);
    assert.ok('id' in msg || 'method' in msg);
  }
}

after(() => {
  for (const b of bases) rmrf(b);
});

describe('ebrain mcp: tools in every mode, audit, stdout', () => {
  for (const mode of TOOL_MODES) {
    it(`mode ${mode}: lists expectedTools(${mode}, ${PHASE}), runs each tool, one audit line per call`, async () => {
      const inst = makeInstance(mode);
      const m = new McpProcess(inst.config);
      try {
        const init = await m.initialize();
        assert.equal(init.serverInfo.name, 'e3d-brain');
        const listed = await m.listTools();
        assert.deepEqual([...listed].sort(), expectedTools(mode, PHASE));

        const calls: [string, Record<string, unknown>][] = [
          ['search', { query: 'injectionmarker' }],
          ['read_note', { path: 'Home.md' }],
          ['list_notes', { folder: 'Graph' }],
          ['related', { path: 'Graph/Hub.md' }],
          ['search', { query: 'graphtwin', format: 'compact' }],
        ];
        const responses: ToolResponse[] = [];
        for (const [name, args] of calls) {
          const r = await m.call(name, args);
          assertOk(r, name);
          responses.push(r);
        }
        assert.deepEqual(paths(responses[0]!), ['Injection.md']);
        assert.match(text(responses[1]!), /# Welcome/);
        assert.deepEqual(paths(responses[2]!), ['Graph/Cousin.md', 'Graph/Hub.md', 'Graph/Spoke.md', 'Graph/Twin.md']);
        assert.deepEqual(paths(responses[3]!), ['Graph/Cousin.md', 'Graph/Spoke.md', 'Graph/Twin.md']);
        assert.deepEqual(paths(responses[4]!), ['Graph/Twin.md']);
        // An invalid call is audited too (and carries no recall_id).
        const bad = await m.call('search', { query: 'x', author: 'mallory' });
        assert.equal(bad.isError, true);

        const lines = auditLines(inst.stateDir);
        assert.equal(lines.length, calls.length + 1, 'exactly one audit line per tools/call');
        responses.forEach((r, i) => {
          const h = header(r);
          const line = lines[i]!;
          assert.equal(line['tool'], calls[i]![0]);
          assert.equal(line['outcome'], 'ok');
          assert.equal(line['mode'], mode);
          assert.equal(line['recall_id'], h.recall_id);
          const expected: { id: string; rev: string }[] = [];
          if (calls[i]![0] === 'read_note') {
            const meta = JSON.parse(fencedBlock(text(r))!.body[0]!) as { id: string; rev: string };
            expected.push({ id: meta.id, rev: meta.rev });
          } else for (const x of results(r)) expected.push({ id: String(x['id']), rev: String(x['rev']) });
          assert.deepEqual(line['returned'], expected);
        });
        assert.equal(lines[calls.length]!['outcome'], 'invalid');
        const raw = fs.readFileSync(path.join(inst.stateDir, 'audit.jsonl'), 'utf8');
        for (const leak of ['injectionmarker', 'graphtwin', 'Welcome', 'IGNORE ALL', 'mallory', 'graphhub']) {
          assert.ok(!raw.includes(leak), `audit leaked ${leak}`);
        }
      } finally {
        assert.equal(await m.close(), 0);
      }
      assertFramesOnly(m);
      assert.ok(!m.stderr.includes('injectionmarker') && !m.stderr.includes('Welcome'), 'stderr must not carry note text');
    });
  }
});

describe('ebrain mcp: read tools against the fixture vault', () => {
  let inst: Instance;
  let m: McpProcess;

  before(async () => {
    inst = makeInstance('inbox');
    m = new McpProcess(inst.config);
    await m.initialize();
  });

  after(async () => {
    await m.close();
    assertFramesOnly(m);
  });

  it('read_note refuses traversal, absolute paths, and escaping symlinks', async () => {
    for (const p of ['../../etc/passwd', '/etc/passwd', path.join(inst.base, 'outside', 'secret.md'), 'outside-link.md',
      'linked-dir/secret.md', '.obsidian/hidden-in-obsidian.md', 'Projects/../../outside/secret.md', 'a\\..\\..\\x.md']) {
      const r = await m.call('read_note', { path: p });
      assert.equal(r.isError, true, p);
      assert.equal(r.structuredContent?.error.type, 'invalid', p);
      assert.ok(!text(r).includes(OUTSIDE_CANARY), p);
      assert.ok(!text(r).includes('Error:') && !text(r).includes('    at '), 'no stack traces');
    }
    // A symlink that stays inside the vault is not an indexed note either.
    const inside = await m.call('read_note', { path: 'inside-link.md' });
    assert.equal(inside.isError, true);
    const related = await m.call('related', { path: '../outside/secret.md' });
    assert.equal(related.isError, true);
    const listed = await m.call('list_notes', { folder: '../outside' });
    assert.equal(listed.isError, true);
  });

  it('hostile content stays inside a fence it cannot close', async () => {
    for (const r of [await m.call('read_note', { path: 'Injection.md' }), await m.call('search', { query: 'injectionmarker' })]) {
      assertOk(r, 'injection');
      const block = fencedBlock(text(r))!;
      assert.ok(block.fence.length > 60, 'fence longer than the 60-backtick run');
      assert.match(block.label, /not instructions/);
      assert.match(block.label, /Non-authoritative/);
      assert.deepEqual(block.after, [], 'nothing after the closing fence');
      assert.ok(block.body.join('\n').includes('IGNORE ALL PREVIOUS INSTRUCTIONS'));
      assert.ok(!text(r).split('\n')[0]!.includes('IGNORE'), 'header carries no note text');
    }
  });

  it('result fields, unique recall_ids, and fresh-then-stale citations', async () => {
    const r = await m.call('search', { query: 'injectionmarker' });
    const [hit] = results(r);
    assert.ok(hit);
    for (const k of ['id', 'provisional', 'rev', 'status', 'kind', 'occurred', 'folder_class', 'path', 'citation', 'heading_path', 'excerpt']) {
      assert.ok(k in hit, `missing ${k}`);
    }
    assert.equal(hit['id'], '01JINJECT0000000000000000A');
    assert.equal(hit['provisional'], false);
    assert.match(String(hit['rev']), /^[0-9a-f]{16}$/);
    assert.equal(hit['status'], 'accepted');
    assert.equal(hit['folder_class'], 'curated');
    assert.deepEqual(hit['heading_path'], ['Injection Test']);
    assert.equal(hit['citation'], `note:01JINJECT0000000000000000A@${String(hit['rev'])}#Injection%20Test`);

    const june = results(await m.call('list_notes', { folder: 'Graph', format: 'compact' }));
    assert.ok(june.every((x) => x['provisional'] === true && String(x['id']).startsWith('prov_')));
    const fact = results(await m.call('search', { query: 'junevalidity', as_of: '2026-05-01' }))[0]!;
    assert.equal(fact['kind'], 'fact');
    assert.equal(fact['occurred'], '2026-04-02');

    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const id = header(await m.call('list_notes', { limit: 1 })).recall_id;
      assert.match(id, ULID_RE);
      ids.add(id);
    }
    ids.add(header(r).recall_id);
    assert.equal(ids.size, 6, 'recall_id unique per call');

    const parsed = parseCitation(hit['citation']);
    assert.ok(parsed.ok && parsed.citation.kind === 'note');
    const cite = parsed.citation as NoteCitation;
    const db = openIndexDb(resolveInState(inst.stateDir, ''), { mustExist: true });
    try {
      assert.equal(checkNoteCitation(cite, noteLookup(db)), 'fresh');
      fs.appendFileSync(path.join(inst.vault, 'Injection.md'), '\nAn edit.\n');
      const again = results(await m.call('search', { query: 'injectionmarker' }))[0]!;
      assert.notEqual(again['rev'], hit['rev']);
      assert.equal(checkNoteCitation(cite, noteLookup(db)), 'stale');
    } finally {
      db.close();
    }
  });

  it('as_of evaluates validity windows and lifecycle; include flags reveal hidden notes', async () => {
    const found = async (args: Record<string, unknown>) => paths(await m.call('search', args));
    assert.deepEqual(await found({ query: 'junevalidity', as_of: '2026-05-01' }), ['Valid June.md']);
    assert.deepEqual(await found({ query: 'junevalidity', as_of: '2026-07-01' }), []);
    assert.deepEqual(await found({ query: 'junevalidity', as_of: '2026-06-30T23:00:00Z' }), ['Valid June.md']);
    assert.deepEqual(await found({ query: 'junevalidity' }), [], 'default as_of is now (after June)');

    assert.deepEqual(await found({ query: 'oldplanmarker' }), []);
    assert.deepEqual(await found({ query: 'oldplanmarker', include_superseded: true }), ['Superseded Plan.md']);
    assert.deepEqual(await found({ query: 'oldplanmarker', status: 'superseded' }), ['Superseded Plan.md']);
    assert.deepEqual(await found({ query: 'oldplanmarker', as_of: '2026-02-01' }), ['Superseded Plan.md'], 'superseded later than as_of');
    assert.deepEqual(await found({ query: 'oldplanmarker', as_of: '2026-04-01' }), []);

    assert.deepEqual(await found({ query: 'archivedideamarker' }), []);
    assert.deepEqual(await found({ query: 'archivedideamarker', include_archived: true }), ['_archive/Archived Idea.md']);
    assert.deepEqual(await found({ query: 'archivedideamarker', as_of: '2026-01-15' }), ['_archive/Archived Idea.md']);
    assert.deepEqual(await found({ query: 'archivedideamarker', as_of: '2026-03-01' }), []);

    const listed = async (args: Record<string, unknown>) => paths(await m.call('list_notes', { limit: 200, ...args }));
    const plain = await listed({});
    assert.ok(!plain.includes('Superseded Plan.md') && !plain.includes('_archive/Archived Idea.md') && !plain.includes('_archive/retired.md'));
    assert.ok(!plain.includes('_inbox/_rejected/old-proposal.md'));
    assert.ok((await listed({ include_superseded: true })).includes('Superseded Plan.md'));
    assert.ok((await listed({ include_archived: true })).includes('_archive/Archived Idea.md'));
    assert.deepEqual(await listed({ status: ['stale'] }), ['Stale Note.md']);

    const bad = await m.call('search', { query: 'x', as_of: 'next tuesday' });
    assert.equal(bad.isError, true);
  });

  it('plain queries cannot inject FTS syntax; advanced: true passes it through', async () => {
    for (const q of ['AND OR NOT', '"unbalanced', 'title:(x', 'NEAR(a b', '*', 'a" OR "b']) {
      assertOk(await m.call('search', { query: q }), q);
    }
    assert.deepEqual(paths(await m.call('search', { query: 'graphhu*', advanced: true })), ['Graph/Hub.md']);
    assert.deepEqual(paths(await m.call('search', { query: 'graphhu*' })), [], 'plain mode treats * as text');
    const bad = await m.call('search', { query: '"unbalanced', advanced: true });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent?.error.type, 'invalid');
  });

  it('filters by folder and tags', async () => {
    const tagged = paths(await m.call('search', { query: 'graphcousin OR graphhub OR graphtwin OR graphspoke', advanced: true, tags: ['#GraphTest'] }));
    assert.deepEqual([...tagged].sort(), ['Graph/Cousin.md', 'Graph/Hub.md', 'Graph/Twin.md']);
    assert.deepEqual(paths(await m.call('list_notes', { tag: 'graphtest' })), ['Graph/Cousin.md', 'Graph/Hub.md', 'Graph/Twin.md']);
    assert.deepEqual(paths(await m.call('search', { query: 'injectionmarker', folder: 'Graph' })), []);
    assert.deepEqual(paths(await m.call('list_notes', { folder: 'Projects/' })), ['Projects/Alpha.md', 'Projects/Sub/Deep/Beta.md']);
  });

  it('a note added while the server runs is found by the next search', async () => {
    assert.deepEqual(paths(await m.call('search', { query: 'freshlyaddedmarker' })), []);
    fs.writeFileSync(path.join(inst.vault, 'Fresh Note.md'), '# Fresh\n\nfreshlyaddedmarker appears.\n');
    assert.deepEqual(paths(await m.call('search', { query: 'freshlyaddedmarker' })), ['Fresh Note.md']);
  });

  it('compact format: excerpts of at most 200 characters', async () => {
    for (const r of [await m.call('search', { query: 'injectionmarker', format: 'compact' }), await m.call('list_notes', { format: 'compact', limit: 100 })]) {
      const rs = results(r);
      assert.ok(rs.length > 0);
      for (const x of rs) {
        assert.ok(typeof x['citation'] === 'string');
        assert.ok(String(x['excerpt'] ?? '').length <= 200);
      }
    }
    const note = await m.call('read_note', { path: 'Home.md', format: 'compact' });
    const meta = JSON.parse(fencedBlock(text(note))!.body[0]!) as { excerpt: string };
    assert.ok(meta.excerpt.length <= 200);
    assert.equal(fencedBlock(text(note))!.body.length, 1, 'compact read_note has no full body');
  });
});

describe('ebrain mcp: size caps', () => {
  it('never exceeds the configured cap; max_chars below it is honored, above it clamped', async () => {
    const cap = 1500;
    const inst = makeInstance('read-only', { limits: { maxCharsPerCall: cap } });
    const m = new McpProcess(inst.config);
    try {
      await m.initialize();
      const calls: [string, Record<string, unknown>][] = [
        ['list_notes', { limit: 200 }],
        ['search', { query: 'the OR a OR note', advanced: true, limit: 50 }],
        ['read_note', { path: 'Home.md' }],
        ['related', { path: 'Graph/Hub.md' }],
      ];
      for (const [name, args] of calls) {
        const full = await m.call(name, args);
        assertOk(full, name);
        assert.ok(text(full).length <= cap, `${name} within the config cap`);
        const lowered = await m.call(name, { ...args, max_chars: 400 });
        assertOk(lowered, name);
        assert.ok(text(lowered).length <= 400, `${name} honors max_chars below the cap`);
        const raised = await m.call(name, { ...args, max_chars: 50000 });
        assertOk(raised, name);
        assert.ok(text(raised).length <= cap, `${name} clamps max_chars above the cap`);
        assert.equal(text(raised).length, text(full).length, `${name}: max_chars above the cap behaves like no max_chars`);
      }
      // The list was cut to fit: returned (audited) matches what was shown.
      const listed = await m.call('list_notes', { limit: 200 });
      const h = header(listed);
      assert.ok(Number(h['omitted']) > 0);
      assert.equal(results(listed).length, h.count);
      const line = auditLines(inst.stateDir).at(-1)!;
      assert.equal((line['returned'] as unknown[]).length, h.count);
    } finally {
      await m.close();
    }
    assertFramesOnly(m);
  });
});

describe('ebrain init and doctor --strict', () => {
  function run(args: string[], env: Record<string, string>, home: string) {
    const res = spawnSync(process.execPath, [cli(), ...args], { env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, encoding: 'utf8' });
    return { code: res.status, out: res.stdout, err: res.stderr };
  }

  it('init on an empty temp dir yields a working setup that passes doctor --strict', async () => {
    const base = realTmpDir('ebrain-init-');
    bases.push(base);
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const cfg = path.join(base, 'brain', 'config.json');
    const args = ['init', '--vault', path.join(base, 'vault'), '--principal', 'chris', '--state-dir', path.join(base, 'state'), '--config', cfg];
    const res = run(args, {}, home);
    assert.equal(res.code, 0, res.err);
    for (const d of ['_inbox', '_raw', 'references']) assert.ok(fs.statSync(path.join(base, 'vault', d)).isDirectory(), d);
    assert.ok(!fs.existsSync(path.join(base, 'vault', 'journal')));
    assert.equal(fs.statSync(path.join(base, 'state')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    assert.match(res.out, /claude mcp add --scope user e3d-brain -e EBRAIN_CONFIG=\S+ -- \/\S+ \/\S+main\.js mcp/);
    assert.ok(res.out.includes(`"command": ${JSON.stringify(process.execPath)}`));
    assert.ok(res.out.includes(JSON.stringify(cli())), 'absolute script path');

    // Refuses to overwrite.
    assert.equal(run(args, {}, home).code, 1);

    const doctor = run(['doctor', '--strict'], { EBRAIN_CONFIG: cfg }, home);
    assert.equal(doctor.code, 0, doctor.out + doctor.err);
    assert.match(doctor.out, /strict vault symlinks: ok/);

    // And the server runs against it.
    fs.writeFileSync(path.join(base, 'vault', 'first.md'), '# First\n\nhello brain\n');
    const m = new McpProcess(cfg);
    try {
      await m.initialize();
      assert.deepEqual([...(await m.listTools())].sort(), expectedTools('inbox', PHASE));
      assert.deepEqual(paths(await m.call('search', { query: 'hello brain' })), ['first.md']);
    } finally {
      await m.close();
    }
  });

  it('init in journal mode creates journal/<principal-id>/; missing flags fail without a terminal', () => {
    const base = realTmpDir('ebrain-init-');
    bases.push(base);
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const res = run(['init', '--vault', path.join(base, 'v'), '--principal', 'agent-7', '--mode', 'journal', '--state-dir', path.join(base, 's'),
      '--config', path.join(base, 'c.json')], {}, home);
    assert.equal(res.code, 0, res.err);
    assert.ok(fs.statSync(path.join(base, 'v', 'journal', 'agent-7')).isDirectory());
    assert.match(fs.readFileSync(path.join(base, 'c.json'), 'utf8'), /"type": "agent"/);
    const missing = run(['init', '--config', path.join(base, 'd.json')], {}, home);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /--vault/);
    const human = run(['init', '--vault', path.join(base, 'v2'), '--principal', 'x', '--mode', 'journal', '--type', 'human',
      '--state-dir', path.join(base, 's2'), '--config', path.join(base, 'e.json')], {}, home);
    assert.equal(human.code, 1);
    assert.ok(!fs.existsSync(path.join(base, 'e.json')));
  });

  it('doctor --strict fails on an escaping vault symlink, remote hosts, and loose state perms', () => {
    const inst = makeInstance('inbox');
    const home = path.join(inst.base, 'home');
    fs.mkdirSync(home);
    const plain = run(['doctor'], { EBRAIN_CONFIG: inst.config }, home);
    assert.equal(plain.code, 0, plain.out);
    const strict = run(['doctor', '--strict'], { EBRAIN_CONFIG: inst.config }, home);
    assert.equal(strict.code, 1);
    assert.match(strict.out, /escaping symlink: "linked-dir"/);
    assert.match(strict.out, /escaping symlink: "outside-link.md"/);
    assert.ok(!strict.out.includes('"inside-link.md"'));

    fs.rmSync(path.join(inst.vault, 'linked-dir'));
    fs.rmSync(path.join(inst.vault, 'outside-link.md'));
    assert.equal(run(['doctor', '--strict'], { EBRAIN_CONFIG: inst.config }, home).code, 0);

    const cfg = JSON.parse(fs.readFileSync(inst.config, 'utf8')) as Record<string, unknown>;
    const write = (body: Record<string, unknown>) => {
      fs.writeFileSync(inst.config, JSON.stringify(body), { mode: 0o600 });
    };
    write({ ...cfg, network: { allowedHosts: ['localhost', '127.0.0.1'] } });
    assert.equal(run(['doctor', '--strict'], { EBRAIN_CONFIG: inst.config }, home).code, 0);
    write({ ...cfg, network: { allowedHosts: ['example.com'] } });
    const remote = run(['doctor', '--strict'], { EBRAIN_CONFIG: inst.config }, home);
    assert.equal(remote.code, 1);
    assert.match(remote.out, /non-loopback hosts allowed: example.com/);
    write(cfg);

    fs.mkdirSync(path.join(inst.stateDir, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(inst.stateDir, 'locks', 'x.lock'), '');
    fs.chmodSync(path.join(inst.stateDir, 'locks', 'x.lock'), 0o644);
    const loose = run(['doctor', '--strict'], { EBRAIN_CONFIG: inst.config }, home);
    assert.equal(loose.code, 1);
    assert.match(loose.out, /strict state dir: FAIL .*locks\/x\.lock/);
  });
});
