// The Claude plugin and marketplace in this repo stay consistent with the
// package: same version, the marketplace points at a real plugin folder, the
// skill's name matches its folder, and the plugin is skill-only: it ships no
// MCP server and no scripts, so the directory accepts it from any publisher.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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

  it('declares privacy, support, and terms URLs, and the privacy policy file exists', () => {
    for (const key of ['privacyPolicyUrl', 'supportUrl', 'termsOfServiceUrl']) {
      assert.match(String(plugin[key]), /^https:\/\/github\.com\/spacepacket1\/e3d-brain\//, key);
    }
    assert.match(String(plugin['privacyPolicyUrl']), /docs\/PRIVACY\.md$/);
    assert.ok(fs.existsSync(path.join(root, 'docs/PRIVACY.md')));
    assert.ok(fs.existsSync(path.join(root, 'LICENSE')));
  });

  it('is skill-only: no MCP server, no scripts, only file types the directory accepts from any publisher', () => {
    const dir = path.join(root, 'plugin/e3d-brain');
    const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    assert.ok(!files.some((f) => path.basename(f) === '.mcp.json'), 'no bundled MCP server');
    assert.equal(plugin['mcpServers'], undefined);
    const allowed = /(\.(md|txt|json|ya?ml|png|jpe?g|gif|webp|ico)|(^|\/)LICENSE)$/;
    for (const f of files) {
      assert.match(f.split(path.sep).join('/'), allowed, f);
      const head = fs.readFileSync(path.join(dir, f)).subarray(0, 2).toString('latin1');
      assert.notEqual(head, '#!', `${f} must not start with a shebang`);
    }
  });

  it('tells the user how to install and register the server themselves', () => {
    const readme = fs.readFileSync(path.join(root, 'plugin/e3d-brain/README.md'), 'utf8');
    assert.match(readme, /npm install -g e3d-brain/);
    assert.match(readme, /ebrain setup/);
    const skill = fs.readFileSync(path.join(root, 'plugin/e3d-brain/skills/e3d-brain-memory/SKILL.md'), 'utf8');
    assert.match(skill, /ebrain setup/);
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
