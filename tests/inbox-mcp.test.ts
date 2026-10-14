// Phase 8 integration: spawn `ebrain mcp` per mode (the tool list matches
// expectedTools(<mode>, 8); no accept/delete/move/overwrite tool anywhere),
// capture and list_inbox end to end with one audit line each and no body
// text in the audit, then the owner CLI (`ebrain inbox list|show|accept|
// reject`, `--to`, `--edit`) and `ebrain doctor` reporting the duplicate id an
// interrupted accept leaves behind.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FORBIDDEN_TOOL_NAME } from '../src/mcp/dispatch.js';
import { splitFrontmatter } from '../src/vault/parse.js';
import { materializeFixture, realTmpDir, repoRoot, rmrf, treeChecksum } from './helpers.js';
import { header, McpProcess, results, type ToolResponse } from './mcp-client.js';
import { checkToolsSincePhase, expectedTools, loadToolRegistry, TOOL_MODES, type ToolMode } from './tool-registry.js';

const PHASE = 8;
const cli = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
const bases: string[] = [];

after(() => {
  for (const b of bases) rmrf(b);
});

interface Instance {
  base: string;
  vault: string;
  stateDir: string;
  config: string;
}

function makeInstance(mode: ToolMode, type: 'human' | 'agent' = mode === 'journal' ? 'agent' : 'human'): Instance {
  const base = realTmpDir('ebrain-p8i-');
  bases.push(base);
  const vault = materializeFixture(base);
  const stateDir = path.join(base, 'state');
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ vaultPath: vault, stateDir, principal: { id: 'tester', type }, mode }), { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  return { base, vault, stateDir, config };
}

function run(inst: Instance, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cli(), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: inst.base, EBRAIN_CONFIG: inst.config, ...env },
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function text(r: ToolResponse): string {
  return r.content[0]!.text;
}

function auditLines(stateDir: string): Record<string, unknown>[] {
  const file = path.join(stateDir, 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function frontmatter(file: string): Record<string, unknown> {
  return parseYaml(splitFrontmatter(fs.readFileSync(file, 'utf8')).yaml ?? '') as Record<string, unknown>;
}

/** Checksum of the vault with _inbox/ left out. */
function outsideInbox(vault: string): string {
  const copy = `${vault}-copy-${Math.random().toString(36).slice(2)}`;
  fs.cpSync(vault, copy, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(path.join(copy, '_inbox'), { recursive: true, force: true });
  try {
    return treeChecksum(copy);
  } finally {
    rmrf(copy);
  }
}

describe('ebrain mcp: inbox tools by mode', () => {
  for (const mode of TOOL_MODES) {
    it(`mode ${mode}: tools/list matches expectedTools(${mode}, ${PHASE})`, async () => {
      const inst = makeInstance(mode);
      const m = new McpProcess(inst.config);
      try {
        await m.initialize();
        const listed = await m.listTools();
        // Exactly the phase-8 tools, plus only later-phase registry tools of this mode.
        assert.equal(checkToolsSincePhase(listed, mode, PHASE), undefined);
        for (const name of listed) assert.ok(!FORBIDDEN_TOOL_NAME.test(name), name);
        assert.equal(listed.includes('capture'), mode === 'inbox');
        assert.equal(listed.includes('list_inbox'), mode === 'inbox');
        if (mode !== 'inbox') {
          const r = await m.call('capture', { title: 'x', body: 'y' });
          assert.equal(r.isError, true);
          assert.ok(!fs.existsSync(path.join(inst.vault, '_inbox')) || fs.readdirSync(path.join(inst.vault, '_inbox')).every((n) => !n.startsWith('2')));
        }
      } finally {
        await m.close();
      }
    });
  }

  it('the registry has no accept/delete/move/overwrite tool in any mode', () => {
    for (const e of loadToolRegistry()) assert.ok(!/accept|promote|edit|delete|move|overwrite/.test(e.name), e.name);
    for (const mode of TOOL_MODES) for (const n of expectedTools(mode, 15)) assert.ok(!FORBIDDEN_TOOL_NAME.test(n), n);
  });
});

describe('ebrain mcp: capture and list_inbox end to end, then the owner CLI', () => {
  it('capture writes only under _inbox/, is audited without content, and the CLI accepts/rejects it', async () => {
    const inst = makeInstance('inbox');
    const before = outsideInbox(inst.vault);
    const m = new McpProcess(inst.config);
    let acceptId = '';
    let rejectId = '';
    try {
      await m.initialize();
      const a = await m.call('capture', { title: '../../Escape attempt', body: 'capturebodymarker one', kind: 'decision', sources: ['commit:abc1234'] });
      assert.notEqual(a.isError, true, text(a));
      const ha = header(a) as Record<string, unknown>;
      assert.match(String(ha['path']), /^_inbox\/\d{8}-\d{6}-escape-attempt\.md$/);
      acceptId = String(ha['id']);
      const b = await m.call('capture', { title: '.obsidian/app', body: 'capturebodymarker two' });
      const hb = header(b) as Record<string, unknown>;
      assert.match(String(hb['path']), /^_inbox\/\d{8}-\d{6}-obsidian-app\.md$/);
      rejectId = String(hb['id']);

      const listed = await m.call('list_inbox', {});
      const rows = results(listed);
      const ids = rows.map((r) => r['id']);
      assert.ok(ids.includes(acceptId) && ids.includes(rejectId));
      assert.ok(!rows.some((r) => String(r['path']).startsWith('_inbox/_rejected/')), 'rejected proposals hidden');
      assert.ok(rows.every((r) => r['status'] === 'proposed' && r['tier'] === 2));

      const found = results(await m.call('search', { query: 'capturebodymarker' }));
      assert.equal(found.length, 2);
      assert.ok(found.every((r) => r['status'] === 'proposed'));

      const lines = auditLines(inst.stateDir);
      assert.equal(lines.length, 4);
      assert.deepEqual(lines.map((l) => l['tool']), ['capture', 'capture', 'list_inbox', 'search']);
      assert.deepEqual(lines[0]!['returned'], [{ id: acceptId, rev: ha['rev'] }]);
      const raw = fs.readFileSync(path.join(inst.stateDir, 'audit.jsonl'), 'utf8');
      for (const leak of ['capturebodymarker', 'Escape', 'obsidian']) assert.ok(!raw.includes(leak), `audit leaked ${leak}`);
    } finally {
      assert.equal(await m.close(), 0);
    }
    assert.equal(outsideInbox(inst.vault), before, 'capture changed nothing outside _inbox/');
    assert.ok(!fs.existsSync(path.join(inst.vault, '.obsidian', 'app.md')));

    // Owner CLI.
    const list = run(inst, ['inbox', 'list']);
    assert.equal(list.code, 0, list.err);
    assert.ok(list.out.includes(acceptId) && list.out.includes(rejectId));
    assert.ok(list.out.includes('_inbox/proposal.md'), 'fixture proposal listed');
    const show = run(inst, ['inbox', 'show', acceptId]);
    assert.equal(show.code, 0, show.err);
    assert.match(show.out, /capturebodymarker one/);

    for (const to of ['_inbox', 'journal/x', '../x', '_raw/y', '.obsidian']) {
      const refused = run(inst, ['inbox', 'accept', acceptId, '--to', to]);
      assert.equal(refused.code, 1, `${to}: ${refused.out}`);
    }
    fs.mkdirSync(path.join(inst.vault, 'Decisions'));
    fs.writeFileSync(path.join(inst.vault, 'Decisions', 'escape-attempt.md'), 'taken\n');
    const acc = run(inst, ['inbox', 'accept', acceptId, '--to', 'Decisions']);
    assert.equal(acc.code, 0, acc.err);
    assert.match(acc.out, /-> Decisions\/escape-attempt-2\.md/);
    assert.equal(fs.readFileSync(path.join(inst.vault, 'Decisions', 'escape-attempt.md'), 'utf8'), 'taken\n');
    const fm = frontmatter(path.join(inst.vault, 'Decisions', 'escape-attempt-2.md'));
    assert.equal(fm['id'], acceptId);
    assert.equal(fm['status'], 'accepted');
    assert.match(String(fm['accepted']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(fm['kind'], 'decision');

    const rej = run(inst, ['inbox', 'reject', rejectId, '--reason', 'duplicate']);
    assert.equal(rej.code, 0, rej.err);
    const rejected = fs.readdirSync(path.join(inst.vault, '_inbox', '_rejected')).filter((n) => n.includes('obsidian-app'));
    assert.equal(rejected.length, 1);
    const rfm = frontmatter(path.join(inst.vault, '_inbox', '_rejected', rejected[0]!));
    assert.equal(rfm['status'], 'rejected');
    assert.equal(rfm['id'], rejectId);
    assert.equal(rfm['rejected_reason'], 'duplicate');

    const after = run(inst, ['inbox', 'list']);
    assert.ok(!after.out.includes(acceptId) && !after.out.includes(rejectId));
    assert.equal(run(inst, ['inbox', 'accept', 'no_such_id']).code, 1);
    assert.equal(run(inst, ['inbox', 'accept']).code, 2);
    assert.equal(run(inst, ['inbox', 'frobnicate']).code, 2);
  });

  it('an interrupted accept is reported by doctor as a duplicate id and finished by re-running accept', async () => {
    const inst = makeInstance('inbox');
    const m = new McpProcess(inst.config);
    let id = '';
    let rel = '';
    try {
      await m.initialize();
      const h = header(await m.call('capture', { title: 'Half done', body: 'interrupted' })) as Record<string, unknown>;
      id = String(h['id']);
      rel = String(h['path']);
    } finally {
      await m.close();
    }
    // Simulate the crash: the destination exists (as accept writes it), the source was not unlinked.
    const src = fs.readFileSync(path.join(inst.vault, rel), 'utf8');
    fs.mkdirSync(path.join(inst.vault, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(inst.vault, 'notes', 'half-done.md'), src.replace('status: proposed', 'status: accepted\naccepted: 2026-10-14T00:00:00Z'));
    assert.equal(run(inst, ['reindex']).code, 0);
    const doctor = run(inst, ['doctor']);
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, new RegExp(`duplicate id "${id}"`));

    const again = run(inst, ['inbox', 'accept', id]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /completed an interrupted accept/);
    assert.ok(!fs.existsSync(path.join(inst.vault, rel)));
    assert.ok(fs.existsSync(path.join(inst.vault, 'notes', 'half-done.md')));
    assert.match(run(inst, ['doctor']).out, /duplicate ids: none/);
  });

  it('accept --edit opens $EDITOR (no shell) on the accepted note; works in any mode', () => {
    const inst = makeInstance('read-only');
    fs.writeFileSync(path.join(inst.vault, '_inbox', 'owner-job.md'), '---\nid: 01JOWNERJOB000000000000000\nstatus: proposed\n---\nfrom a cli job\n');
    const editor = path.join(inst.base, 'fake-editor.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nprintf "edited by owner\\n" >> "$1"\n', { mode: 0o700 });
    const r = run(inst, ['inbox', 'accept', '01JOWNERJOB000000000000000', '--edit'], { EDITOR: editor });
    assert.equal(r.code, 0, r.err);
    const dest = path.join(inst.vault, 'notes', 'owner-job.md');
    assert.match(fs.readFileSync(dest, 'utf8'), /edited by owner/);
    assert.equal(frontmatter(dest)['status'], 'accepted');

    fs.writeFileSync(path.join(inst.vault, '_inbox', 'two.md'), '---\nid: 01JOWNERJOB000000000000002\nstatus: proposed\n---\nx\n');
    const bad = run(inst, ['inbox', 'accept', '01JOWNERJOB000000000000002', '--edit'], { EDITOR: 'vi -c "!rm -rf /"' });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /single program/);
    assert.ok(fs.existsSync(path.join(inst.vault, 'notes', 'two.md')), 'accepted even though the editor was refused');
  });
});
