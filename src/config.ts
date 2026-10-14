// Instance configuration (Phase 1). The config file fixes principal and mode,
// so it is loaded fail-closed (I10): unknown keys, wrong types, and invalid
// values are errors, and the file itself must be owned by the current user
// and not group- or world-writable.
//
// Later phases extend the schema additively: add the key to `Config`, to
// `parseConfig`, and to docs/SETUP.md in the same change.

import * as os from 'node:os';
import * as path from 'node:path';
import { ensurePrivateDir, readExternalFile, SafePathError, type SafePath } from './safe-path.js';

export type PrincipalType = 'human' | 'agent';
export type Mode = 'inbox' | 'journal' | 'read-only';
export type EmbeddingsProvider = 'none';

export interface Config {
  vaultPath: string;
  stateDir: string;
  principal: { id: string; type: PrincipalType };
  mode: Mode;
  limits: { maxCharsPerCall: number };
  network: { allowedHosts: string[] };
  scrub: { extraPatterns: string[] };
  embeddings: { provider: EmbeddingsProvider };
  audit: { maxSegmentMB: number };
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file that was loaded. */
  configPath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_STATE_DIR = '~/.e3d-brain';
export const CONFIG_ENV_VAR = 'EBRAIN_CONFIG';
/** Hard ceiling for any per-call output budget (I6); config may only lower it. */
export const MAX_CHARS_CEILING = 10000;
/** Audit log segment size before a new segment starts (Phase 5). */
export const DEFAULT_AUDIT_SEGMENT_MB = 50;
const MAX_AUDIT_SEGMENT_MB = 4096;
export const PRINCIPAL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MODES: readonly Mode[] = ['inbox', 'journal', 'read-only'];
const PRINCIPAL_TYPES: readonly PrincipalType[] = ['human', 'agent'];
const EMBEDDINGS_PROVIDERS: readonly EmbeddingsProvider[] = ['none'];
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export interface EnvOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * Expand exactly a leading `~/` to the home directory (nothing else: no `~`
 * alone, no `~user`, no environment variables), then require an absolute path.
 */
export function expandHome(value: string, key: string, homeDir: string = os.homedir()): string {
  if (value.includes('\0')) throw new ConfigError(`config key "${key}" contains a NUL byte`);
  const expanded = value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) {
    throw new ConfigError(`config key "${key}" must be an absolute path or start with "~/"`);
  }
  return path.normalize(expanded);
}

/** The config file path: `$EBRAIN_CONFIG` if set, else `~/.e3d-brain/config.json`. */
export function configPath(opts: EnvOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? os.homedir();
  const override = env[CONFIG_ENV_VAR];
  if (override !== undefined && override !== '') return expandHome(override, CONFIG_ENV_VAR, home);
  return path.join(home, '.e3d-brain', 'config.json');
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Json, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ConfigError(`unknown config key "${prefix}${key}"`);
  }
}

function section(obj: Json, key: string, allowed: readonly string[], required: boolean): Json {
  const value = obj[key];
  if (value === undefined) {
    if (required) throw new ConfigError(`missing required config key "${key}"`);
    return {};
  }
  if (!isObject(value)) throw new ConfigError(`config key "${key}" must be an object`);
  checkKeys(value, allowed, `${key}.`);
  return value;
}

function str(obj: Json, key: string, label: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ConfigError(`config key "${label}" must be a string`);
  return value;
}

function requiredStr(obj: Json, key: string, label: string): string {
  const value = str(obj, key, label);
  if (value === undefined) throw new ConfigError(`missing required config key "${label}"`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`config key "${label}" must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringArray(obj: Json, key: string, label: string): string[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) {
    throw new ConfigError(`config key "${label}" must be an array of non-empty strings`);
  }
  return [...value];
}

function isInsideLexical(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Validate a parsed config object. Pure: no filesystem access. */
export function parseConfig(raw: unknown, opts: { homeDir?: string } = {}): Config {
  const home = opts.homeDir ?? os.homedir();
  if (!isObject(raw)) throw new ConfigError('config must be a JSON object');
  checkKeys(raw, ['vaultPath', 'stateDir', 'principal', 'mode', 'limits', 'network', 'scrub', 'embeddings', 'audit'], '');

  const vaultPath = expandHome(requiredStr(raw, 'vaultPath', 'vaultPath'), 'vaultPath', home);
  const stateDir = expandHome(str(raw, 'stateDir', 'stateDir') ?? DEFAULT_STATE_DIR, 'stateDir', home);
  if (isInsideLexical(vaultPath, stateDir) || isInsideLexical(stateDir, vaultPath)) {
    throw new ConfigError('config keys "vaultPath" and "stateDir" must not contain each other');
  }

  const principalRaw = section(raw, 'principal', ['id', 'type'], true);
  const id = requiredStr(principalRaw, 'id', 'principal.id');
  if (!PRINCIPAL_ID_RE.test(id)) {
    throw new ConfigError(`config key "principal.id" must match ${PRINCIPAL_ID_RE.source}`);
  }
  const type = oneOf(requiredStr(principalRaw, 'type', 'principal.type'), PRINCIPAL_TYPES, 'principal.type');

  const mode = oneOf(requiredStr(raw, 'mode', 'mode'), MODES, 'mode');
  if (mode === 'journal' && type !== 'agent') {
    throw new ConfigError('config key "mode": "journal" requires "principal.type": "agent"');
  }

  const limitsRaw = section(raw, 'limits', ['maxCharsPerCall'], false);
  const maxChars = limitsRaw.maxCharsPerCall === undefined ? MAX_CHARS_CEILING : limitsRaw.maxCharsPerCall;
  if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_CHARS_CEILING) {
    throw new ConfigError(`config key "limits.maxCharsPerCall" must be an integer from 1 to ${MAX_CHARS_CEILING}`);
  }

  const networkRaw = section(raw, 'network', ['allowedHosts'], false);
  const allowedHosts = stringArray(networkRaw, 'allowedHosts', 'network.allowedHosts');
  for (const host of allowedHosts) {
    if (!HOSTNAME_RE.test(host)) {
      throw new ConfigError('config key "network.allowedHosts" entries must be lowercase hostnames (no scheme, port, or wildcard)');
    }
  }

  const scrubRaw = section(raw, 'scrub', ['extraPatterns'], false);
  const extraPatterns = stringArray(scrubRaw, 'extraPatterns', 'scrub.extraPatterns');

  const embeddingsRaw = section(raw, 'embeddings', ['provider'], false);
  const provider = oneOf(str(embeddingsRaw, 'provider', 'embeddings.provider') ?? 'none', EMBEDDINGS_PROVIDERS, 'embeddings.provider');

  const auditRaw = section(raw, 'audit', ['maxSegmentMB'], false);
  const maxSegmentMB = auditRaw.maxSegmentMB === undefined ? DEFAULT_AUDIT_SEGMENT_MB : auditRaw.maxSegmentMB;
  // Fractions are allowed (small segments for testing); zero and negatives are not.
  if (typeof maxSegmentMB !== 'number' || !Number.isFinite(maxSegmentMB) || maxSegmentMB <= 0 || maxSegmentMB > MAX_AUDIT_SEGMENT_MB) {
    throw new ConfigError(`config key "audit.maxSegmentMB" must be a number above 0 and at most ${MAX_AUDIT_SEGMENT_MB}`);
  }

  return {
    vaultPath,
    stateDir,
    principal: { id, type },
    mode,
    limits: { maxCharsPerCall: maxChars },
    network: { allowedHosts },
    scrub: { extraPatterns },
    embeddings: { provider },
    audit: { maxSegmentMB },
  };
}

/**
 * Load and validate the config file. The file must be a regular file owned by
 * the current user and not group- or world-writable.
 */
export function loadConfig(opts: EnvOptions & { path?: string } = {}): LoadedConfig {
  const home = opts.homeDir ?? os.homedir();
  const file = opts.path !== undefined ? expandHome(opts.path, 'config path', home) : configPath(opts);
  let read: ReturnType<typeof readExternalFile>;
  try {
    read = readExternalFile(file, [path.dirname(file)]);
  } catch (err) {
    const errno = err instanceof SafePathError ? err.errno : (err as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') throw new ConfigError(`config file not found: ${file} (see docs/SETUP.md)`);
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`cannot read config file ${file}: ${reason}`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) throw new ConfigError('cannot verify config file ownership on this platform');
  if (read.stat.uid !== uid) throw new ConfigError(`config file ${file} is not owned by the current user`);
  if ((read.stat.mode & 0o022) !== 0) {
    throw new ConfigError(`config file ${file} is group- or world-writable; run: chmod 600 ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.data.toString('utf8'));
  } catch (err) {
    throw new ConfigError(`config file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { config: parseConfig(raw, { homeDir: home }), configPath: read.path };
}

/** Create (or tighten) the state directory with mode 0700 (I8). */
export function ensureStateDir(config: Config): SafePath {
  return ensurePrivateDir(config.stateDir);
}
