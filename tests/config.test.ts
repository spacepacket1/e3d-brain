import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigError, configPath, ensureStateDir, expandHome, loadConfig, parseConfig } from '../src/config.js';
import { createExclusive, resolveInState, writeAtomic } from '../src/safe-path.js';
import { mode, realTmpDir, rmrf } from './helpers.js';

let base: string;
let home: string;

const valid = () => ({
  vaultPath: '/abs/path/to/vault',
  stateDir: '~/.e3d-brain',
  principal: { id: 'chris', type: 'human' },
  mode: 'inbox',
  limits: { maxCharsPerCall: 10000 },
  network: { allowedHosts: [] as string[] },
  scrub: { extraPatterns: [] as string[] },
  embeddings: { provider: 'none' },
});

function parse(raw: unknown) {
  return parseConfig(raw, { homeDir: home });
}

function rejectsWith(raw: unknown, pattern: RegExp): void {
  assert.throws(() => parse(raw), (err: unknown) => err instanceof ConfigError && pattern.test(err.message));
}

function writeConfig(name: string, body: string, fileMode = 0o600): string {
  const file = path.join(base, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, fileMode);
  return file;
}

before(() => {
  base = realTmpDir();
  home = path.join(base, 'home');
  fs.mkdirSync(home);
});

after(() => rmrf(base));

describe('parseConfig', () => {
  it('accepts the documented example and expands ~/ in stateDir', () => {
    const c = parse(valid());
    assert.equal(c.vaultPath, '/abs/path/to/vault');
    assert.equal(c.stateDir, path.join(home, '.e3d-brain'));
    assert.deepEqual(c.principal, { id: 'chris', type: 'human' });
    assert.equal(c.mode, 'inbox');
    assert.equal(c.limits.maxCharsPerCall, 10000);
    assert.deepEqual(c.network.allowedHosts, []);
    assert.equal(c.embeddings.provider, 'none');
  });

  it('fills defaults for optional sections', () => {
    const c = parse({ vaultPath: '~/vault', principal: { id: 'a1', type: 'agent' }, mode: 'read-only' });
    assert.equal(c.vaultPath, path.join(home, 'vault'));
    assert.equal(c.stateDir, path.join(home, '.e3d-brain'));
    assert.equal(c.limits.maxCharsPerCall, 10000);
    assert.deepEqual(c.scrub.extraPatterns, []);
  });

  it('rejects unknown keys at every level, naming the key', () => {
    rejectsWith({ ...valid(), vaultPth: '/x' }, /unknown config key "vaultPth"/);
    rejectsWith({ ...valid(), limits: { maxCharsPerCall: 10, maxTokens: 5 } }, /unknown config key "limits\.maxTokens"/);
    rejectsWith({ ...valid(), principal: { id: 'chris', type: 'human', role: 'admin' } }, /unknown config key "principal\.role"/);
    rejectsWith({ ...valid(), network: { allowedHosts: [], enabled: true } }, /unknown config key "network\.enabled"/);
    rejectsWith(JSON.parse('{"__proto__": {"x": 1}, "vaultPath": "/v"}'), /unknown config key "__proto__"/);
  });

  it('rejects hostile principal ids', () => {
    for (const id of ['../x', 'Chris', 'CHRIS', 'a'.repeat(65), '', '-x', '_x', 'a/b', 'a.b', 'a b', 'é']) {
      rejectsWith({ ...valid(), principal: { id, type: 'human' } }, /principal\.id/);
    }
    assert.equal(parse({ ...valid(), principal: { id: 'a'.repeat(64), type: 'human' } }).principal.id, 'a'.repeat(64));
    assert.equal(parse({ ...valid(), principal: { id: '0agent_x-1', type: 'agent' } }).principal.id, '0agent_x-1');
  });

  it('rejects unknown modes and principal types, and journal for humans', () => {
    rejectsWith({ ...valid(), mode: 'write' }, /"mode"/);
    rejectsWith({ ...valid(), mode: 'INBOX' }, /"mode"/);
    rejectsWith({ ...valid(), principal: { id: 'chris', type: 'robot' } }, /principal\.type/);
    rejectsWith({ ...valid(), mode: 'journal' }, /journal.*agent/);
    assert.equal(parse({ ...valid(), mode: 'journal', principal: { id: 'bot', type: 'agent' } }).mode, 'journal');
  });

  it('requires vaultPath, principal, and mode', () => {
    const { vaultPath: _v, ...noVault } = valid();
    const { principal: _p, ...noPrincipal } = valid();
    const { mode: _m, ...noMode } = valid();
    rejectsWith(noVault, /vaultPath/);
    rejectsWith(noPrincipal, /principal/);
    rejectsWith(noMode, /mode/);
    rejectsWith([], /JSON object/);
    rejectsWith(null, /JSON object/);
  });

  it('validates limits, network hosts, scrub patterns, and embeddings', () => {
    for (const v of [0, -1, 1.5, 10001, '100', null]) {
      rejectsWith({ ...valid(), limits: { maxCharsPerCall: v } }, /maxCharsPerCall/);
    }
    assert.equal(parse({ ...valid(), limits: { maxCharsPerCall: 2000 } }).limits.maxCharsPerCall, 2000);
    for (const h of ['https://x.com', 'x.com:443', '*.x.com', 'X.COM', '', 'a b']) {
      rejectsWith({ ...valid(), network: { allowedHosts: [h] } }, /allowedHosts/);
    }
    assert.deepEqual(parse({ ...valid(), network: { allowedHosts: ['api.example.com'] } }).network.allowedHosts, ['api.example.com']);
    rejectsWith({ ...valid(), scrub: { extraPatterns: [1] } }, /extraPatterns/);
    rejectsWith({ ...valid(), embeddings: { provider: 'openai' } }, /embeddings\.provider/);
    rejectsWith({ ...valid(), limits: 5 }, /"limits" must be an object/);
    rejectsWith({ ...valid(), stateDir: null }, /stateDir/);
    rejectsWith({ ...valid(), network: null }, /network/);
    rejectsWith({ ...valid(), network: { allowedHosts: null } }, /allowedHosts/);
    rejectsWith({ ...valid(), embeddings: { provider: null } }, /embeddings\.provider/);
  });

  it('expands exactly a leading ~/ and requires absolute paths', () => {
    assert.equal(expandHome('~/v', 'k', home), path.join(home, 'v'));
    for (const p of ['~', '~v', '~root/v', '$HOME/v', '${HOME}/v', 'relative/v', './v', '']) {
      rejectsWith({ ...valid(), vaultPath: p }, /vaultPath/);
    }
    rejectsWith({ ...valid(), stateDir: '$HOME/.e3d-brain' }, /stateDir/);
  });

  it('rejects a state dir inside the vault and vice versa', () => {
    rejectsWith({ ...valid(), vaultPath: '/v', stateDir: '/v/.state' }, /must not contain/);
    rejectsWith({ ...valid(), vaultPath: '/s/vault', stateDir: '/s' }, /must not contain/);
    rejectsWith({ ...valid(), vaultPath: '/v', stateDir: '/v' }, /must not contain/);
  });
});

describe('loadConfig', () => {
  it('uses EBRAIN_CONFIG when set, else ~/.e3d-brain/config.json', () => {
    assert.equal(configPath({ env: {}, homeDir: home }), path.join(home, '.e3d-brain', 'config.json'));
    assert.equal(configPath({ env: { EBRAIN_CONFIG: '/etc/x.json' }, homeDir: home }), '/etc/x.json');
    assert.equal(configPath({ env: { EBRAIN_CONFIG: '~/c.json' }, homeDir: home }), path.join(home, 'c.json'));
    assert.throws(() => configPath({ env: { EBRAIN_CONFIG: 'rel.json' }, homeDir: home }), ConfigError);
  });

  it('loads a private config file', () => {
    const file = writeConfig('ok.json', JSON.stringify(valid()));
    const loaded = loadConfig({ env: { EBRAIN_CONFIG: file }, homeDir: home });
    assert.equal(loaded.config.principal.id, 'chris');
    assert.equal(loaded.configPath, file);
    writeConfig('readable.json', JSON.stringify(valid()), 0o644);
    assert.equal(loadConfig({ path: path.join(base, 'readable.json'), homeDir: home }).config.mode, 'inbox');
  });

  it('rejects group- or world-writable config files', () => {
    for (const m of [0o620, 0o602, 0o666]) {
      const file = writeConfig(`loose-${m.toString(8)}.json`, JSON.stringify(valid()), m);
      assert.throws(() => loadConfig({ path: file, homeDir: home }), /group- or world-writable/);
    }
  });

  it('rejects a missing file, invalid JSON, and an unknown key in the file', () => {
    assert.throws(() => loadConfig({ path: path.join(base, 'missing.json'), homeDir: home }), /not found/);
    assert.throws(() => loadConfig({ path: writeConfig('bad.json', '{nope'), homeDir: home }), /not valid JSON/);
    const file = writeConfig('unknown.json', JSON.stringify({ ...valid(), extra: 1 }));
    assert.throws(() => loadConfig({ path: file, homeDir: home }), /unknown config key "extra"/);
  });

  it('rejects a config path that is a symlink leaving its directory', () => {
    const elsewhere = realTmpDir('ebrain-cfg-');
    try {
      const target = path.join(elsewhere, 'real.json');
      fs.writeFileSync(target, JSON.stringify(valid()), { mode: 0o600 });
      const link = path.join(base, 'link.json');
      fs.symlinkSync(target, link);
      assert.throws(() => loadConfig({ path: link, homeDir: home }), ConfigError);
    } finally {
      rmrf(elsewhere);
    }
  });
});

describe('state directory and file modes', () => {
  it('creates the state dir 0700 and files 0600 regardless of umask', () => {
    const previous = process.umask(0o000);
    try {
      const stateDir = path.join(base, 'state-parent', 'nested', '.e3d-brain');
      const config = parse({ ...valid(), vaultPath: path.join(base, 'vault'), stateDir });
      const dir = ensureStateDir(config);
      assert.equal(mode(stateDir), 0o700);
      assert.equal(mode(path.join(base, 'state-parent')), 0o700);
      assert.equal(mode(path.join(base, 'state-parent', 'nested')), 0o700);
      const created = resolveInState(dir, 'created.json');
      createExclusive(created, '{}');
      assert.equal(mode(created), 0o600);
      const replaced = resolveInState(dir, 'replaced.json');
      writeAtomic(replaced, '1');
      writeAtomic(replaced, '2');
      assert.equal(mode(replaced), 0o600);
      const excl = resolveInState(dir, 'excl.json');
      createExclusive(excl, '{}', { strategy: 'excl' });
      assert.equal(mode(excl), 0o600);
    } finally {
      process.umask(previous);
    }
  });

  it('tightens an existing loose state dir to 0700 and rejects a symlinked one', () => {
    const loose = path.join(base, 'loose-state');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o755);
    ensureStateDir(parse({ ...valid(), vaultPath: path.join(base, 'vault'), stateDir: loose }));
    assert.equal(mode(loose), 0o700);
    const link = path.join(base, 'state-link');
    fs.symlinkSync(loose, link);
    assert.throws(() => ensureStateDir(parse({ ...valid(), vaultPath: path.join(base, 'vault'), stateDir: link })));
  });
});
