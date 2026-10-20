// `ebrain setup` and `ebrain mcp --auto`: config + vault creation, reuse of an
// existing config, registration with Claude Code / Claude Desktop / Codex
// through an injected CLI runner (no real client is touched), idempotence,
// --force, a malformed Claude Desktop config left untouched, and the npx
// command used when run through the npx cache.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigError } from '../src/config.js';
import type { ClientCli, ClientCliResult, ClientCliRunner } from '../src/exec/clients.js';
import { bootstrapConfig, parseSetupArgs, runSetup, serverCommand, type SetupOptions } from '../src/cli/setup.js';
import { realTmpDir, rmrf, mode } from './helpers.js';

const bases: string[] = [];
after(() => {
  for (const b of bases) rmrf(b);
});

const ENTRY = { node: '/opt/node/bin/node', script: '/opt/ebrain/dist/src/cli/main.js' };

interface Call {
  cli: ClientCli;
  args: string[];
}

interface Fixture {
  home: string;
  calls: Call[];
  registered: Set<string>;
  opts: SetupOptions;
}

function result(ok: boolean, absent = false): ClientCliResult {
  return { ok, absent, status: ok ? 0 : absent ? null : 1, stdout: '', stderr: '' };
}

function fixture(o: { claude?: boolean; codex?: boolean; desktop?: boolean; desktopJson?: string } = {}): Fixture {
  const home = realTmpDir('ebrain-setup-');
  bases.push(home);
  const calls: Call[] = [];
  const registered = new Set<string>();
  if (o.desktop !== false) {
    const dir = path.join(home, 'Library', 'Application Support', 'Claude');
    fs.mkdirSync(dir, { recursive: true });
    if (o.desktopJson !== undefined) fs.writeFileSync(path.join(dir, 'claude_desktop_config.json'), o.desktopJson);
  }
  const run: ClientCliRunner = (cli, args) => {
    calls.push({ cli, args: [...args] });
    const present = cli === 'claude' ? o.claude !== false : o.codex !== false;
    if (!present) return result(false, true);
    if (args[0] === '--version') return result(true);
    if (args[0] === 'mcp' && args[1] === 'get') return result(registered.has(cli));
    if (args[0] === 'mcp' && args[1] === 'add') {
      registered.add(cli);
      return result(true);
    }
    if (args[0] === 'mcp' && args[1] === 'remove') {
      registered.delete(cli);
      return result(true);
    }
    return result(false);
  };
  return { home, calls, registered, opts: { homeDir: home, env: { USER: 'Tester' }, run, entry: ENTRY, platform: 'darwin' } };
}

const desktopFile = (home: string) => path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

describe('parseSetupArgs', () => {
  it('parses flags and rejects bad ones', () => {
    assert.deepEqual(parseSetupArgs(['--vault', '~/N', '--yes', '--mode=read-only']), { vault: '~/N', mode: 'read-only', yes: true, dryRun: false, force: false });
    assert.throws(() => parseSetupArgs(['--mode', 'journal']), ConfigError);
    assert.throws(() => parseSetupArgs(['--bogus']), ConfigError);
    assert.throws(() => parseSetupArgs(['--vault']), ConfigError);
    assert.throws(() => parseSetupArgs(['--vault', 'a', '--vault', 'b']), ConfigError);
  });
});

describe('serverCommand', () => {
  it('uses this install, and refuses a copy running from a temporary download', () => {
    assert.deepEqual(serverCommand(ENTRY), { command: ENTRY.node, args: [ENTRY.script, 'mcp'] });
    assert.throws(
      () => serverCommand({ node: '/opt/node/bin/node', script: '/home/u/.npm/_npx/abc/node_modules/e3d-brain/dist/src/cli/main.js' }),
      /temporary download/,
    );
  });

  it('runSetup reports that refusal and changes nothing', async () => {
    const f = fixture();
    const r = await runSetup(['--yes'], { ...f.opts, entry: { node: ENTRY.node, script: '/home/u/.npm/_npx/abc/node_modules/e3d-brain/dist/src/cli/main.js' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /temporary download/);
    assert.equal(fs.existsSync(path.join(f.home, '.e3d-brain')), false);
  });
});

describe('runSetup', () => {
  it('--dry-run prints the plan and changes nothing', async () => {
    const f = fixture();
    const r = await runSetup(['--dry-run'], f.opts);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /will be created/);
    assert.match(r.stdout, /clients: claude-code, claude-desktop, codex/);
    assert.match(r.stdout, /dry run: nothing changed/);
    assert.equal(fs.existsSync(path.join(f.home, '.e3d-brain')), false);
    assert.equal(fs.existsSync(path.join(f.home, 'Brain')), false);
    assert.equal(f.calls.some((c) => c.args[1] === 'add'), false);
  });

  it('refuses to edit client configs without --yes when there is no terminal', async () => {
    const f = fixture();
    const r = await runSetup([], f.opts);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pass --yes/);
    assert.equal(fs.existsSync(path.join(f.home, '.e3d-brain')), false);
  });

  it('asks for confirmation on a terminal and cancels cleanly', async () => {
    const f = fixture();
    const r = await runSetup([], { ...f.opts, prompt: async () => 'no' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cancelled/);
    assert.equal(fs.existsSync(path.join(f.home, '.e3d-brain')), false);
  });

  it('creates the config and vault, and registers with all three clients', async () => {
    const f = fixture({ desktopJson: JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2) });
    const r = await runSetup(['--yes'], f.opts);
    assert.equal(r.code, 0, r.stderr);
    const cfg = path.join(f.home, '.e3d-brain', 'config.json');
    const config = JSON.parse(fs.readFileSync(cfg, 'utf8')) as { vaultPath: string; mode: string; principal: { id: string } };
    assert.equal(config.vaultPath, path.join(f.home, 'Brain'));
    assert.equal(config.mode, 'inbox');
    assert.equal(config.principal.id, 'tester');
    assert.equal(mode(cfg), 0o600);
    for (const d of ['_inbox', '_raw', 'references']) assert.ok(fs.statSync(path.join(f.home, 'Brain', d)).isDirectory());

    const claudeAdd = f.calls.find((c) => c.cli === 'claude' && c.args[1] === 'add');
    assert.deepEqual(claudeAdd?.args, ['mcp', 'add', '--scope', 'user', 'e3d-brain', '-e', `EBRAIN_CONFIG=${cfg}`, '--', ENTRY.node, ENTRY.script, 'mcp']);
    const codexAdd = f.calls.find((c) => c.cli === 'codex' && c.args[1] === 'add');
    assert.deepEqual(codexAdd?.args, ['mcp', 'add', 'e3d-brain', '--env', `EBRAIN_CONFIG=${cfg}`, '--', ENTRY.node, ENTRY.script, 'mcp']);

    const desktop = JSON.parse(fs.readFileSync(desktopFile(f.home), 'utf8')) as { theme: string; mcpServers: Record<string, unknown> };
    assert.equal(desktop.theme, 'dark');
    assert.deepEqual(desktop.mcpServers['other'], { command: 'x' });
    assert.deepEqual(desktop.mcpServers['e3d-brain'], { command: ENTRY.node, args: [ENTRY.script, 'mcp'], env: { EBRAIN_CONFIG: cfg } });
    assert.ok(fs.existsSync(`${desktopFile(f.home)}.ebrain-backup`), 'the original Desktop config is backed up');
    assert.match(r.stdout, /Claude Code: registered/);
    assert.match(r.stdout, /Claude Desktop: registered/);
    assert.match(r.stdout, /Codex: registered/);
  });

  it('is idempotent: a second run reuses the config and registers nothing twice', async () => {
    const f = fixture();
    assert.equal((await runSetup(['--yes'], f.opts)).code, 0);
    const before = fs.readFileSync(desktopFile(f.home), 'utf8');
    f.calls.length = 0;
    const r = await runSetup(['--yes'], f.opts);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /exists; reused|using /);
    assert.match(r.stdout, /Claude Code: already registered/);
    assert.match(r.stdout, /Codex: already registered/);
    assert.match(r.stdout, /Claude Desktop: already registered/);
    assert.equal(f.calls.some((c) => c.args[1] === 'add'), false);
    assert.equal(fs.readFileSync(desktopFile(f.home), 'utf8'), before);
  });

  it('--force replaces an existing registration', async () => {
    const f = fixture();
    await runSetup(['--yes'], f.opts);
    f.calls.length = 0;
    const r = await runSetup(['--yes', '--force'], f.opts);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(f.calls.some((c) => c.cli === 'claude' && c.args[1] === 'remove'));
    assert.ok(f.calls.some((c) => c.cli === 'claude' && c.args[1] === 'add'));
    assert.match(r.stdout, /Claude Desktop: registered/);
  });

  it('honours --vault, --mode, and --client, and skips clients that are not asked for', async () => {
    const f = fixture();
    const vault = path.join(f.home, 'notes-here');
    const r = await runSetup(['--yes', '--vault', vault, '--mode', 'read-only', '--client', 'codex'], f.opts);
    assert.equal(r.code, 0, r.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(f.home, '.e3d-brain', 'config.json'), 'utf8')) as { vaultPath: string; mode: string };
    assert.equal(config.vaultPath, vault);
    assert.equal(config.mode, 'read-only');
    assert.equal(f.calls.some((c) => c.cli === 'claude' && c.args[1] === 'add'), false);
    assert.equal(fs.existsSync(desktopFile(f.home)), false);
    assert.ok(f.calls.some((c) => c.cli === 'codex' && c.args[1] === 'add'));
  });

  it('works with only some clients installed, and says so when none are', async () => {
    const some = fixture({ claude: false, codex: false });
    const r1 = await runSetup(['--yes'], some.opts);
    assert.equal(r1.code, 0, r1.stderr);
    assert.match(r1.stdout, /clients: claude-desktop/);
    const none = fixture({ claude: false, codex: false, desktop: false });
    const r2 = await runSetup(['--yes'], none.opts);
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /No Claude Code, Claude Desktop, or Codex found/);
  });

  it('errors when a named client is not on this machine', async () => {
    const f = fixture({ codex: false });
    const r = await runSetup(['--yes', '--client', 'codex'], f.opts);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /codex was not found/);
  });

  it('leaves a malformed Claude Desktop config untouched', async () => {
    const f = fixture({ claude: false, codex: false, desktopJson: '{ not json' });
    const r = await runSetup(['--yes'], f.opts);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a valid JSON object; left untouched/);
    assert.equal(fs.readFileSync(desktopFile(f.home), 'utf8'), '{ not json');
  });

  it('reports a failing `claude mcp add` instead of claiming success', async () => {
    const f = fixture({ codex: false, desktop: false });
    const failing: ClientCliRunner = (cli, args) => (args[1] === 'add' ? { ok: false, absent: false, status: 1, stdout: '', stderr: 'boom\nmore' } : f.opts.run!(cli, args));
    const r = await runSetup(['--yes'], { ...f.opts, run: failing });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /`claude mcp add` failed: boom/);
  });

  it('rejects a different --vault when a config already exists', async () => {
    const f = fixture({ claude: false, codex: false, desktop: false });
    assert.equal((await runSetup(['--yes'], f.opts)).code, 0);
    const r = await runSetup(['--yes', '--vault', path.join(f.home, 'elsewhere')], f.opts);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists and uses vault/);
  });
});

describe('bootstrapConfig (ebrain mcp --auto)', () => {
  it('creates a default config once, from $EBRAIN_VAULT and $EBRAIN_MODE, then reuses it', async () => {
    const home = realTmpDir('ebrain-boot-');
    bases.push(home);
    const vault = path.join(home, 'My Notes');
    const env = { USER: 'sam', EBRAIN_VAULT: vault, EBRAIN_MODE: 'read-only' };
    const first = await bootstrapConfig({}, { homeDir: home, env });
    assert.equal(first.created, true);
    assert.equal(first.vault, vault);
    assert.equal(first.mode, 'read-only');
    assert.equal(first.cfgPath, path.join(home, '.e3d-brain', 'config.json'));
    const second = await bootstrapConfig({}, { homeDir: home, env: { USER: 'sam' } });
    assert.equal(second.created, false);
    assert.equal(second.vault, vault);
  });

  it('rejects a bad mode', async () => {
    const home = realTmpDir('ebrain-boot-');
    bases.push(home);
    await assert.rejects(bootstrapConfig({}, { homeDir: home, env: { USER: 'sam', EBRAIN_MODE: 'journal' } }), ConfigError);
  });
});
