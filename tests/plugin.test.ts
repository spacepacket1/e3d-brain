// The Claude plugin and marketplace in this repo stay consistent with the
// package: same version, the marketplace points at a real plugin folder, the
// skill's name matches its folder, the server entry is `ebrain mcp --auto`, and
// no secrets or absolute paths are baked into the files every user receives.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repoRoot } from './helpers.js';

const root = repoRoot();
const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Record<string, any>;

describe('plugin/e3d-brain', () => {
  const pkg = json('package.json');
  const plugin = json('plugin/e3d-brain/.claude-plugin/plugin.json');

  it('has the same version as the package, and the required manifest fields', () => {
    assert.equal(plugin['version'], pkg['version']);
    assert.equal(plugin['name'], 'e3d-brain');
    assert.equal(plugin['license'], 'MIT');
    assert.ok(String(plugin['description']).length > 40);
    assert.ok(fs.existsSync(path.join(root, 'plugin/e3d-brain/LICENSE')));
    assert.ok(fs.readFileSync(path.join(root, 'plugin/e3d-brain/README.md'), 'utf8').split(/\s+/).length >= 40);
  });

  it('launches the server by running a file in the plugin with plain arguments, and has no secrets or absolute paths', () => {
    const raw = fs.readFileSync(path.join(root, 'plugin/e3d-brain/.mcp.json'), 'utf8');
    const mcp = JSON.parse(raw) as { mcpServers: Record<string, { command: string; args: string[]; env?: unknown }> };
    assert.deepEqual(mcp.mcpServers['e3d-brain'], { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/launch.mjs'] });
    assert.ok(!/\/Users\/|\/home\/|token|secret|key/i.test(raw));
    const launcher = fs.readFileSync(path.join(root, 'plugin/e3d-brain/launch.mjs'), 'utf8');
    assert.ok(launcher.length < 256 * 1024);
    // It may tell the user to install the package; it must not install, download, or call out itself.
    assert.doesNotMatch(launcher, /\bnpx\b|\bcurl\b|\bfetch\(|https?:|node:https?|node:net\b|spawn\('npm/);
  });

  it('the launcher runs `ebrain mcp --auto`, passes stdout through, and explains a missing install', () => {
    const launcher = path.join(root, 'plugin/e3d-brain/launch.mjs');
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ebrain-launch-'));
    try {
      const fake = path.join(dir, 'ebrain');
      fs.writeFileSync(fake, '#!/bin/sh\necho "args:$*"\nexit 3\n', { mode: 0o755 });
      const ok = spawnSync(process.execPath, [launcher], { env: { PATH: dir }, encoding: 'utf8' });
      assert.equal(ok.stdout.trim(), 'args:mcp --auto');
      assert.equal(ok.status, 3, 'the exit code is passed through');
      const empty = fs.mkdtempSync(path.join(dir, 'empty-'));
      const missing = spawnSync(process.execPath, [launcher], { env: { PATH: empty }, encoding: 'utf8' });
      assert.equal(missing.status, 127);
      assert.equal(missing.stdout, '', 'nothing on stdout, which carries the protocol');
      assert.match(missing.stderr, /npm install -g e3d-brain/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has a skill whose name matches its folder and whose description says when to use it', () => {
    const file = path.join(root, 'plugin/e3d-brain/skills/e3d-brain-memory/SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(m, 'frontmatter');
    assert.equal(m![1], 'e3d-brain-memory');
    assert.match(m![2]!, /past decisions/);
    assert.match(text, /never say it is saved/i);
  });

  it('is listed by the repo marketplace, which points at the real folder', () => {
    const market = json('.claude-plugin/marketplace.json');
    const entry = (market['plugins'] as Array<{ name: string; source: string }>).find((p) => p.name === 'e3d-brain');
    assert.ok(entry);
    assert.ok(fs.existsSync(path.join(root, entry!.source, '.claude-plugin/plugin.json')));
  });

  it('the Desktop bundle manifest carries the package version', () => {
    assert.equal(json('mcpb/manifest.json')['version'], pkg['version']);
  });

  it('is not shipped in the npm package (only dist/src and two docs are)', () => {
    assert.deepEqual(pkg['files'], ['dist/src', 'docs/SETUP.md', 'docs/SECURITY.md']);
  });
});
