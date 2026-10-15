// `ebrain doctor`: environment and configuration report. Read-only with
// respect to the vault; it creates the state dir (0700) if missing and writes
// one short-lived probe file there to test case sensitivity. If the index
// exists it is refreshed and checked for duplicate ids, missing identities,
// and frontmatter problems; doctor never creates the index.
//
// `--strict` (Phase 6) also fails on: network enabled with a non-loopback
// host, any group/world-accessible entry anywhere under the state dir, and a
// vault symlink that escapes the vault root. (Phase 13 adds: auto-hooks
// installed without a deliberate `captureCheckpoints`.)

import { randomBytes } from 'node:crypto';
import { duplicateIds, missingIdentities } from '../index/identity.js';
import { closeIndex, indexExists, indexTotals, openIndex, refreshIndex } from '../index/indexer.js';
import { checkFts5 } from '../index/sqlite.js';
import { mirrorSummary } from '../mirror/sync.js';
import { findCollisions } from '../vault/names.js';
import { scanVault } from '../vault/scan.js';
import { ConfigError, ensureStateDir, loadConfig, type Config, type EnvOptions } from '../config.js';
import {
  createExclusive,
  readDirSafe,
  resolveInState,
  resolveInVault,
  SafePathError,
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

/**
 * Scan the vault (read-only) and report paths that differ only by case or
 * Unicode normalization: both are indexed, but they are one file on APFS and
 * two on ext4, so a synced vault diverges. A warning, not a failure.
 */
function checkVaultNames(config: Config, lines: string[]): void {
  const scan = scanVault(config.vaultPath);
  const s = scan.skipped;
  lines.push(`vault notes: ${scan.files.length} (skipped: symlinks ${s.symlinks}, hidden ${s.hidden}, unsafe names ${s.unsafeNames})`);
  const collisions = findCollisions(scan.files.map((f) => f.relPath));
  if (collisions.length === 0) {
    lines.push('path collisions: none');
    return;
  }
  lines.push(`path collisions: WARN ${collisions.length} (paths differing only by case or Unicode normalization)`);
  for (const g of collisions) lines.push(`  collision: ${g.map((p) => JSON.stringify(p)).join(' ')}`);
}

function checkVault(config: Config, lines: string[]): { ok: boolean; dev?: number } {
  try {
    const root = resolveInVault(config.vaultPath, '');
    const entries = readDirSafe(root);
    lines.push(`vault: ${root} (exists, readable, ${entries.length} entries)`);
    checkVaultNames(config, lines);
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

/** How fresh each configured mirror is, from the sync state file alone (no source walk): warnings only, never a failure. */
const MIRROR_STALE_DAYS = 7;
function checkMirrors(config: Config, lines: string[]): void {
  if (config.mirrors.length === 0) return;
  try {
    for (const s of mirrorSummary({ config, stateDir: ensureStateDir(config) })) {
      if (s.lastSync === null) lines.push(`mirror ${s.name}: WARN never synced (run \`ebrain sync ${s.name}\`)`);
      else if (s.ageDays !== null && s.ageDays > MIRROR_STALE_DAYS) {
        lines.push(`mirror ${s.name}: WARN last sync ${s.ageDays} days ago (${s.tracked} notes); run \`ebrain sync ${s.name}\``);
      } else lines.push(`mirror ${s.name}: last sync ${s.lastSync.slice(0, 10)} (${s.tracked} notes)`);
    }
  } catch (err) {
    lines.push(`mirrors: WARN could not read sync state: ${message(err)}`);
  }
}

/** Show at most this many entries per list. */
const MAX_LISTED = 20;

function listSome<T>(items: T[], lines: string[], fmt: (item: T) => string): void {
  for (const item of items.slice(0, MAX_LISTED)) lines.push(`  ${fmt(item)}`);
  if (items.length > MAX_LISTED) lines.push(`  ... and ${items.length - MAX_LISTED} more`);
}

/**
 * Index checks (I12, I10): duplicate explicit ids are an error (both notes are
 * indexed; the later one in path order gets a provisional id); missing
 * identities, unknown statuses, malformed frontmatter, and invalid dates are
 * warnings with counts.
 */
function checkIndex(config: Config, lines: string[]): boolean {
  let stateDir: SafePath;
  try {
    stateDir = ensureStateDir(config);
    if (!indexExists(stateDir)) {
      lines.push('index: not built (run `ebrain reindex` to check ids, citations, and frontmatter)');
      return true;
    }
  } catch (err) {
    lines.push(`index: FAIL ${message(err)}`);
    return false;
  }
  let h: ReturnType<typeof openIndex> | undefined;
  try {
    h = openIndex({ vaultPath: config.vaultPath, stateDir, mustExist: true });
    refreshIndex(h);
    const t = indexTotals(h.db);
    const dups = duplicateIds(h.db);
    const missing = missingIdentities(h.db);
    lines.push(`index: ${t.notes} notes (refreshed)`);
    const warn = (n: number) => (n === 0 ? '0' : `WARN ${n}`);
    let ok = true;
    if (dups.length === 0) lines.push('duplicate ids: none');
    else {
      lines.push(`duplicate ids: FAIL ${dups.length} (the later note in path order gets a provisional id)`);
      listSome(dups, lines, (d) => `duplicate id ${JSON.stringify(d.id)}: ${d.paths.map((p) => JSON.stringify(p)).join(' ')}`);
      ok = false;
    }
    lines.push(`missing identities: ${warn(missing.length)}`);
    listSome(missing, lines, (m) =>
      `missing ${m.provisional ? 'provisional ' : ''}id ${m.id} (last at ${JSON.stringify(m.lastPath)} rev ${m.lastRev}, since ${m.since})`);
    lines.push(`unknown statuses: ${warn(t.unknownStatuses)}`);
    lines.push(`malformed frontmatter: ${warn(t.malformedFrontmatter)}`);
    lines.push(`invalid dates: ${warn(t.invalidDates)}`);
    return ok;
  } catch (err) {
    lines.push(`index: FAIL ${message(err)}`);
    return false;
  } finally {
    if (h) closeIndex(h);
  }
}

/** Hosts that never leave the machine. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host);
}

/** Group/world-accessible entries anywhere below the state dir (relative names). */
function looseStateEntries(dir: SafePath, rel = '', depth = 0): string[] {
  const out: string[] = [];
  if (depth > 8) return out;
  for (const entry of readDirSafe(dir)) {
    const p = resolveInState(dir, entry.name);
    const name = rel === '' ? entry.name : `${rel}/${entry.name}`;
    const st = statSafe(p);
    if (st === undefined) continue;
    if ((st.mode & 0o077) !== 0) out.push(name);
    if (st.isDirectory()) out.push(...looseStateEntries(p, name, depth + 1));
  }
  return out;
}

/** The extra `--strict` checks. Returns false if any fails. */
function strictChecks(config: Config, lines: string[]): boolean {
  let ok = true;
  const remote = config.network.allowedHosts.filter((h) => !isLoopbackHost(h));
  if (remote.length > 0) {
    lines.push(`strict network: FAIL non-loopback hosts allowed: ${remote.join(', ')}`);
    ok = false;
  } else lines.push('strict network: ok (no non-loopback hosts)');

  try {
    const loose = looseStateEntries(ensureStateDir(config));
    if (loose.length > 0) {
      lines.push(`strict state dir: FAIL group/world-accessible: ${loose.slice(0, MAX_LISTED).join(', ')}`);
      ok = false;
    } else lines.push('strict state dir: ok (all entries private)');
  } catch (err) {
    lines.push(`strict state dir: FAIL ${message(err)}`);
    ok = false;
  }

  try {
    const scan = scanVault(config.vaultPath);
    const escaping: string[] = [];
    const broken: string[] = [];
    for (const rel of scan.skippedPaths) {
      try {
        resolveInVault(config.vaultPath, rel);
      } catch (err) {
        if (!(err instanceof SafePathError)) throw err;
        if (err.code === 'escape') escaping.push(rel);
        else if (err.code === 'symlink') broken.push(rel);
      }
    }
    if (escaping.length > 0) {
      lines.push(`strict vault symlinks: FAIL ${escaping.length} escape the vault root`);
      listSome(escaping, lines, (p) => `escaping symlink: ${JSON.stringify(p)}`);
      ok = false;
    } else lines.push('strict vault symlinks: ok (none escape the vault root)');
    if (broken.length > 0) lines.push(`strict vault symlinks: WARN ${broken.length} dangling or looping`);
  } catch (err) {
    lines.push(`strict vault symlinks: FAIL ${message(err)}`);
    ok = false;
  }
  return ok;
}

export function runDoctor(opts: EnvOptions & { strict?: boolean } = {}): DoctorReport {
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
  if (vault.ok) ok = checkIndex(config, lines) && ok;
  if (vault.ok) checkMirrors(config, lines);

  const hosts = config.network.allowedHosts;
  lines.push(hosts.length === 0 ? 'network: disabled' : `network: allowed hosts ${hosts.join(', ')}`);
  if (opts.strict === true) ok = strictChecks(config, lines) && ok;

  return { ok, lines };
}
