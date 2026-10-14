// `ebrain doctor`: environment and configuration report. Read-only with
// respect to the vault; it creates the state dir (0700) if missing and writes
// one short-lived probe file there to test case sensitivity.

import { randomBytes } from 'node:crypto';
import { checkFts5 } from '../index/sqlite.js';
import { ConfigError, ensureStateDir, loadConfig, type Config, type EnvOptions } from '../config.js';
import {
  createExclusive,
  readDirSafe,
  resolveInState,
  resolveInVault,
  statSafe,
  unlinkSafe,
  type SafePath,
} from '../safe-path.js';

export interface DoctorReport {
  ok: boolean;
  lines: string[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

/** Create a lowercase probe in the state dir and look it up in uppercase. */
export function probeCaseSensitivity(stateDir: SafePath): boolean {
  const name = `case-probe-${process.pid}-${randomBytes(4).toString('hex')}`;
  const lower = resolveInState(stateDir, name);
  createExclusive(lower, '');
  try {
    return statSafe(resolveInState(stateDir, name.toUpperCase())) === undefined;
  } finally {
    unlinkSafe(lower);
  }
}

function checkVault(config: Config, lines: string[]): { ok: boolean; dev?: number } {
  try {
    const root = resolveInVault(config.vaultPath, '');
    const entries = readDirSafe(root);
    lines.push(`vault: ${root} (exists, readable, ${entries.length} entries)`);
    return { ok: true, dev: statSafe(root)?.dev };
  } catch (err) {
    lines.push(`vault: FAIL ${config.vaultPath}: ${message(err)}`);
    return { ok: false };
  }
}

function checkStateDir(config: Config, lines: string[], vaultDev: number | undefined): boolean {
  let stateDir: SafePath;
  try {
    stateDir = ensureStateDir(config);
  } catch (err) {
    lines.push(`state dir: FAIL ${config.stateDir}: ${message(err)}`);
    return false;
  }
  let ok = true;
  const st = statSafe(stateDir);
  const mode = st === undefined ? 0 : st.mode & 0o777;
  if (mode === 0o700) {
    lines.push(`state dir: ${stateDir} (mode ${octal(mode)})`);
  } else {
    lines.push(`state dir: FAIL ${stateDir} has mode ${octal(mode)}, expected 0700`);
    ok = false;
  }
  const loose = readDirSafe(stateDir).filter((entry) => {
    const est = statSafe(resolveInState(stateDir, entry.name));
    return est !== undefined && (est.mode & 0o077) !== 0;
  });
  if (loose.length > 0) {
    lines.push(`state files: FAIL group/world-accessible: ${loose.map((e) => e.name).join(', ')}`);
    ok = false;
  } else {
    lines.push('state files: private');
  }
  try {
    const sensitive = probeCaseSensitivity(stateDir);
    const sameFs = vaultDev !== undefined && st !== undefined && st.dev === vaultDev;
    const scope = sameFs ? 'same filesystem as vault' : 'probed in state dir; vault may be on a different filesystem';
    lines.push(`vault case-sensitive: ${sensitive ? 'yes' : 'no'} (${scope})`);
  } catch (err) {
    lines.push(`vault case-sensitive: FAIL probe error: ${message(err)}`);
    ok = false;
  }
  return ok;
}

export function runDoctor(opts: EnvOptions = {}): DoctorReport {
  const lines: string[] = [];
  let ok = true;

  lines.push(`platform: ${process.platform} ${process.arch}`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) {
    lines.push(`node: ${process.version}`);
  } else {
    lines.push(`node: FAIL ${process.version} (requires >= 22)`);
    ok = false;
  }

  const fts = checkFts5();
  if (fts.ok) {
    lines.push(`fts5: available (sqlite ${fts.sqliteVersion})`);
  } else {
    lines.push(`fts5: FAIL ${fts.error}`);
    lines.push(`  fix: ${fts.hint}`);
    ok = false;
  }

  let config: Config;
  try {
    const loaded = loadConfig(opts);
    config = loaded.config;
    lines.push(`config: ${loaded.configPath} (principal ${config.principal.id} [${config.principal.type}], mode ${config.mode})`);
  } catch (err) {
    lines.push(`config: FAIL ${err instanceof ConfigError ? err.message : message(err)}`);
    return { ok: false, lines };
  }

  const vault = checkVault(config, lines);
  ok &&= vault.ok;
  ok &&= checkStateDir(config, lines, vault.dev);

  const hosts = config.network.allowedHosts;
  lines.push(hosts.length === 0 ? 'network: disabled' : `network: allowed hosts ${hosts.join(', ')}`);

  return { ok, lines };
}
