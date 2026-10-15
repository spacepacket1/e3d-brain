import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mode, realTmpDir, repoRoot, rmrf } from './helpers.js';

let base: string;
let vault: string;
let stateDir: string;
const cli = () => path.join(repoRoot(), 'dist', 'src', 'cli', 'main.js');

function run(args: string[], env: Record<string, string>) {
  const res = spawnSync(process.execPath, [cli(), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: path.join(base, 'home'), ...env },
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

function writeConfig(name: string, extra: Record<string, unknown> = {}): string {
  const file = path.join(base, name);
  const body = { vaultPath: vault, stateDir, principal: { id: 'chris', type: 'human' }, mode: 'inbox', ...extra };
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

before(() => {
  base = realTmpDir();
  vault = path.join(base, 'vault');
  stateDir = path.join(base, 'state');
  fs.mkdirSync(path.join(base, 'home'));
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'note.md'), '# hi\n');
});

after(() => rmrf(base));

describe('ebrain CLI', () => {
  it('--version prints the package version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { version: string };
    const res = run(['--version'], {});
    assert.equal(res.code, 0);
    assert.equal(res.out.trim(), pkg.version);
  });

  it('rejects unknown commands', () => {
    assert.equal(run(['frobnicate'], {}).code, 2);
  });

  it('doctor reports platform, node, case sensitivity, fts5, vault, state dir, and network', () => {
    const before = fs.readdirSync(vault).sort();
    const res = run(['doctor'], { EBRAIN_CONFIG: writeConfig('config.json') });
    assert.match(res.out, new RegExp(`platform: ${process.platform} ${process.arch}`));
    assert.match(res.out, new RegExp(`node: ${process.version.replace(/\./g, '\\.')}`));
    assert.match(res.out, /vault case-sensitive: (yes|no)/);
    assert.match(res.out, /fts5: (available|FAIL)/);
    if (/fts5: FAIL/.test(res.out)) assert.match(res.out, /npm run build:native/);
    assert.match(res.out, /vault: .*exists, readable/);
    assert.match(res.out, /state dir: .*mode 0700/);
    assert.match(res.out, /^network: disabled$/m);
    assert.equal(mode(stateDir), 0o700);
    assert.deepEqual(fs.readdirSync(vault).sort(), before, 'doctor must not write into the vault');
    assert.deepEqual(fs.readdirSync(stateDir), [], 'case probe must be removed');
    if (/fts5: available/.test(res.out)) assert.equal(res.code, 0, res.out);
  });

  it('doctor lists allowed hosts instead of network: disabled', () => {
    const res = run(['doctor'], { EBRAIN_CONFIG: writeConfig('net.json', { network: { allowedHosts: ['api.example.com'] } }) });
    assert.doesNotMatch(res.out, /network: disabled/);
    assert.match(res.out, /network: allowed hosts api\.example\.com/);
  });

  it('doctor fails on an invalid config and a missing vault', () => {
    const bad = writeConfig('bad.json', { surprise: true });
    const res = run(['doctor'], { EBRAIN_CONFIG: bad });
    assert.equal(res.code, 1);
    assert.match(res.out, /config: FAIL unknown config key "surprise"/);
    const missing = path.join(base, 'missing-vault.json');
    fs.writeFileSync(missing, JSON.stringify({ vaultPath: path.join(base, 'nope'), stateDir, principal: { id: 'chris', type: 'human' }, mode: 'inbox' }), { mode: 0o600 });
    const res2 = run(['doctor'], { EBRAIN_CONFIG: missing });
    assert.equal(res2.code, 1);
    assert.match(res2.out, /vault: FAIL/);
  });
});
