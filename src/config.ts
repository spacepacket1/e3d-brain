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
import { checkBaseUrl, HostPolicyError } from './net/hosts.js';
import { checkExtraPatterns } from './scrub/scrub.js';

export type PrincipalType = 'human' | 'agent';
export type Mode = 'inbox' | 'journal' | 'read-only';
export type EmbeddingsProvider = 'none' | 'ollama';
export type LlmProvider = 'none' | 'openai-compatible' | 'anthropic';
/** Where vectors live. `blob`: plain SQLite BLOBs with brute-force cosine (sqlite-vec is not a dependency). */
export type EmbeddingsStore = 'blob';

export interface Config {
  vaultPath: string;
  stateDir: string;
  principal: { id: string; type: PrincipalType };
  mode: Mode;
  limits: { maxCharsPerCall: number };
  network: { allowedHosts: string[] };
  scrub: { extraPatterns: string[] };
  embeddings: EmbeddingsConfig;
  audit: { maxSegmentMB: number };
  journal: JournalConfig;
  refs: RefsConfig;
  hooks: HooksConfig;
  llm: LlmConfig;
  recallLog: RecallLogConfig;
  inbox: InboxConfig;
  cognition: CognitionConfig;
}

/** Flood control for typed proposals (cognition Phase 2). */
export interface InboxConfig {
  /** A cognition run stops creating proposals once this many are open (`status: proposed`) in `_inbox/`. */
  maxPendingProposals: number;
}

/** Cognition run budgets (cognition Phase 2, C6); LLM caps are `llm.maxCallsPerRun` and `llm.maxInputCharsPerRun`. */
export interface CognitionConfig {
  /** Most proposals one run creates (`--max-proposals` overrides). */
  maxProposalsPerRun: number;
}

/** `<stateDir>/recalls.jsonl` (cognition Phase 1): records older than this are dropped by `ebrain recalls prune`. */
export interface RecallLogConfig {
  retentionDays: number;
}

/**
 * The shared extraction provider (Phase 14, `src/llm/`). Provider `none` (the
 * default) means `ebrain propose` refuses to run and no network code is
 * touched. API keys are never in this file: `apiKeyEnv` names an environment
 * variable.
 */
export interface LlmConfig {
  provider: LlmProvider;
  /** Required unless the provider is `none`. */
  model: string;
  /** Loopback, or a host listed in `network.allowedHosts`. Default depends on the provider. */
  baseUrl: string;
  /** Name of the environment variable holding the API key ('' = send none; `anthropic` defaults to ANTHROPIC_API_KEY). */
  apiKeyEnv: string;
  /** Per-run budget: most provider calls. */
  maxCallsPerRun: number;
  /** Per-run budget: most characters sent (prompt plus archive text). */
  maxInputCharsPerRun: number;
  /** Largest completion requested per call, in tokens. */
  maxOutputTokens: number;
  timeoutMs: number;
}

/** Optional local embeddings (Phase 12). Provider `none` (the default) means BM25 only and no network code runs. */
export interface EmbeddingsConfig {
  provider: EmbeddingsProvider;
  /** Changing it re-embeds every chunk on the next `ebrain reindex`. */
  model: string;
  /** Ollama base URL: loopback, or a host listed in `network.allowedHosts`. */
  baseUrl: string;
  store: EmbeddingsStore;
}

/** Claude Code hooks (Phase 13). Read only from the user-level config file, never from a project. */
export interface HooksConfig {
  /** Vault folders (`notes/work`) or tags (`#project`) whose recent accepted notes go in the session brief. */
  briefFolders: string[];
  /** Optional user-written text placed in the session brief. */
  focus: string;
  /** `pre-compact` writes a checkpoint proposal only when this is exactly `true`. */
  captureCheckpoints: boolean;
  /** Transcripts are read only from files under this directory. */
  claudeProjectsDir: string;
}

/** Reference-library output limits for `search` (Phase 11). */
export interface RefsConfig {
  /** Longest excerpt per reference hit, in characters. */
  excerptChars: number;
  /** Most reference hits per `search` call. */
  maxHits: number;
}

/** Journal-mode limits (Phase 9). Enforced server-side by rejecting, never truncating. */
export interface JournalConfig {
  /** Days from `created` to `expires` on a new entry. */
  ttlDays: number;
  /** Longest entry body, in characters. */
  maxEntryChars: number;
  /** Entries per principal per rolling hour. */
  maxEntriesPerHour: number;
  /** Total size of the principal's journal directory, in MB. */
  maxTotalMB: number;
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
export const DEFAULT_JOURNAL: Readonly<JournalConfig> = { ttlDays: 90, maxEntryChars: 4000, maxEntriesPerHour: 60, maxTotalMB: 100 };
export const DEFAULT_REFS: Readonly<RefsConfig> = { excerptChars: 400, maxHits: 5 };
export const DEFAULT_RECALL_RETENTION_DAYS = 180;
export const DEFAULT_MAX_PENDING_PROPOSALS = 50;
export const DEFAULT_MAX_PROPOSALS_PER_RUN = 20;
/** Upper bound for `inbox.maxPendingProposals`, `cognition.maxProposalsPerRun`, and `--max-proposals`. */
export const MAX_PROPOSALS_CEILING = 10_000;
/** Upper bounds for `refs.*`: excerpts and hits stay short so a book cannot be dumped through `search`. */
export const MAX_REF_EXCERPT_CHARS = 1000;
export const MAX_REF_HITS = 20;
export const DEFAULT_CLAUDE_PROJECTS_DIR = '~/.claude/projects';
export const MAX_HOOK_FOCUS_CHARS = 2000;
export const MAX_BRIEF_FOLDERS = 32;
export const DEFAULT_EMBEDDINGS_MODEL = 'nomic-embed-text';
export const DEFAULT_EMBEDDINGS_URL = 'http://127.0.0.1:11434';
export const DEFAULT_LLM_URLS: Readonly<Record<LlmProvider, string>> = {
  none: 'http://127.0.0.1:11434/v1',
  'openai-compatible': 'http://127.0.0.1:11434/v1',
  anthropic: 'https://api.anthropic.com',
};
/** `anthropic` runs only when this host is allowlisted (and the CLI flag is given). */
export const ANTHROPIC_HOST = 'api.anthropic.com';
export const DEFAULT_ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY';
export const DEFAULT_LLM_BUDGET = { maxCallsPerRun: 20, maxInputCharsPerRun: 200_000, maxOutputTokens: 2048, timeoutMs: 120_000 } as const;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const PRINCIPAL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MODES: readonly Mode[] = ['inbox', 'journal', 'read-only'];
const PRINCIPAL_TYPES: readonly PrincipalType[] = ['human', 'agent'];
const EMBEDDINGS_PROVIDERS: readonly EmbeddingsProvider[] = ['none', 'ollama'];
const LLM_PROVIDERS: readonly LlmProvider[] = ['none', 'openai-compatible', 'anthropic'];
const EMBEDDINGS_STORES: readonly EmbeddingsStore[] = ['blob'];
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
  checkKeys(raw, ['vaultPath', 'stateDir', 'principal', 'mode', 'limits', 'network', 'scrub', 'embeddings', 'audit', 'journal', 'refs', 'hooks', 'llm', 'recallLog', 'inbox', 'cognition'], '');

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
  // Literal strings only (no regexes), length- and count-limited (Phase 7).
  const badPatterns = checkExtraPatterns(extraPatterns);
  if (badPatterns !== undefined) throw new ConfigError(`config key "scrub.extraPatterns" ${badPatterns}`);

  const embeddingsRaw = section(raw, 'embeddings', ['provider', 'model', 'baseUrl', 'store'], false);
  const provider = oneOf(str(embeddingsRaw, 'provider', 'embeddings.provider') ?? 'none', EMBEDDINGS_PROVIDERS, 'embeddings.provider');
  const model = str(embeddingsRaw, 'model', 'embeddings.model') ?? DEFAULT_EMBEDDINGS_MODEL;
  if (model === '' || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new ConfigError('config key "embeddings.model" must be a non-empty string of at most 200 characters without control characters');
  }
  let baseUrl = str(embeddingsRaw, 'baseUrl', 'embeddings.baseUrl') ?? DEFAULT_EMBEDDINGS_URL;
  try {
    baseUrl = checkBaseUrl(baseUrl, allowedHosts);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    throw new ConfigError(`config key "embeddings.baseUrl" ${err.message}`);
  }
  const store = oneOf(str(embeddingsRaw, 'store', 'embeddings.store') ?? 'blob', EMBEDDINGS_STORES, 'embeddings.store');

  const auditRaw = section(raw, 'audit', ['maxSegmentMB'], false);
  const maxSegmentMB = auditRaw.maxSegmentMB === undefined ? DEFAULT_AUDIT_SEGMENT_MB : auditRaw.maxSegmentMB;
  // Fractions are allowed (small segments for testing); zero and negatives are not.
  if (typeof maxSegmentMB !== 'number' || !Number.isFinite(maxSegmentMB) || maxSegmentMB <= 0 || maxSegmentMB > MAX_AUDIT_SEGMENT_MB) {
    throw new ConfigError(`config key "audit.maxSegmentMB" must be a number above 0 and at most ${MAX_AUDIT_SEGMENT_MB}`);
  }

  const journalRaw = section(raw, 'journal', ['ttlDays', 'maxEntryChars', 'maxEntriesPerHour', 'maxTotalMB'], false);
  const intKey = (key: 'ttlDays' | 'maxEntryChars' | 'maxEntriesPerHour', max: number): number => {
    const v = journalRaw[key] === undefined ? DEFAULT_JOURNAL[key] : journalRaw[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw new ConfigError(`config key "journal.${key}" must be an integer from 1 to ${max}`);
    return v;
  };
  const maxTotalMB = journalRaw.maxTotalMB === undefined ? DEFAULT_JOURNAL.maxTotalMB : journalRaw.maxTotalMB;
  // Fractions are allowed (small budgets for testing), like audit.maxSegmentMB.
  if (typeof maxTotalMB !== 'number' || !Number.isFinite(maxTotalMB) || maxTotalMB <= 0 || maxTotalMB > 1_000_000) {
    throw new ConfigError('config key "journal.maxTotalMB" must be a number above 0 and at most 1000000');
  }
  const journal: JournalConfig = {
    ttlDays: intKey('ttlDays', 36_500),
    maxEntryChars: intKey('maxEntryChars', 100_000),
    maxEntriesPerHour: intKey('maxEntriesPerHour', 100_000),
    maxTotalMB,
  };

  const refsRaw = section(raw, 'refs', ['excerptChars', 'maxHits'], false);
  const refsKey = (key: keyof RefsConfig, max: number): number => {
    const v = refsRaw[key] === undefined ? DEFAULT_REFS[key] : refsRaw[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw new ConfigError(`config key "refs.${key}" must be an integer from 1 to ${max}`);
    return v;
  };
  const refs: RefsConfig = { excerptChars: refsKey('excerptChars', MAX_REF_EXCERPT_CHARS), maxHits: refsKey('maxHits', MAX_REF_HITS) };

  const hooksRaw = section(raw, 'hooks', ['briefFolders', 'focus', 'captureCheckpoints', 'claudeProjectsDir'], false);
  const briefFolders = stringArray(hooksRaw, 'briefFolders', 'hooks.briefFolders');
  if (briefFolders.length > MAX_BRIEF_FOLDERS) throw new ConfigError(`config key "hooks.briefFolders" has more than ${MAX_BRIEF_FOLDERS} entries`);
  for (const entry of briefFolders) {
    const name = entry.startsWith('#') ? entry.slice(1) : entry;
    if (name === '' || name.length > 200 || /[\u0000-\u001f\u007f\\]/.test(name) || name.startsWith('/') || name.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new ConfigError('config key "hooks.briefFolders" entries must be vault-relative folders or "#tag" names');
    }
  }
  const focus = str(hooksRaw, 'focus', 'hooks.focus') ?? '';
  if (focus.length > MAX_HOOK_FOCUS_CHARS || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(focus)) {
    throw new ConfigError(`config key "hooks.focus" must be text of at most ${MAX_HOOK_FOCUS_CHARS} characters without control characters`);
  }
  const capture = hooksRaw['captureCheckpoints'];
  if (capture !== undefined && typeof capture !== 'boolean') throw new ConfigError('config key "hooks.captureCheckpoints" must be true or false');
  const claudeProjectsDir = expandHome(str(hooksRaw, 'claudeProjectsDir', 'hooks.claudeProjectsDir') ?? DEFAULT_CLAUDE_PROJECTS_DIR, 'hooks.claudeProjectsDir', home);
  const hooks: HooksConfig = { briefFolders, focus, captureCheckpoints: capture === true, claudeProjectsDir };

  const llm = parseLlm(section(raw, 'llm', ['provider', 'model', 'baseUrl', 'apiKeyEnv', 'maxCallsPerRun', 'maxInputCharsPerRun', 'maxOutputTokens', 'timeoutMs'], false), allowedHosts);

  const recallRaw = section(raw, 'recallLog', ['retentionDays'], false);
  const retentionDays = recallRaw.retentionDays === undefined ? DEFAULT_RECALL_RETENTION_DAYS : recallRaw.retentionDays;
  if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 36_500) {
    throw new ConfigError('config key "recallLog.retentionDays" must be an integer from 1 to 36500');
  }

  const countKey = (raw: Json, label: string, key: string, def: number): number => {
    const v = raw[key] === undefined ? def : raw[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_PROPOSALS_CEILING) {
      throw new ConfigError(`config key "${label}" must be an integer from 1 to ${MAX_PROPOSALS_CEILING}`);
    }
    return v;
  };
  const inboxRaw = section(raw, 'inbox', ['maxPendingProposals'], false);
  const cognitionRaw = section(raw, 'cognition', ['maxProposalsPerRun'], false);

  return {
    vaultPath,
    stateDir,
    principal: { id, type },
    mode,
    limits: { maxCharsPerCall: maxChars },
    network: { allowedHosts },
    scrub: { extraPatterns },
    embeddings: { provider, model, baseUrl, store },
    audit: { maxSegmentMB },
    journal,
    refs,
    hooks,
    llm,
    recallLog: { retentionDays },
    inbox: { maxPendingProposals: countKey(inboxRaw, 'inbox.maxPendingProposals', 'maxPendingProposals', DEFAULT_MAX_PENDING_PROPOSALS) },
    cognition: { maxProposalsPerRun: countKey(cognitionRaw, 'cognition.maxProposalsPerRun', 'maxProposalsPerRun', DEFAULT_MAX_PROPOSALS_PER_RUN) },
  };
}

function parseLlm(llmRaw: Json, allowedHosts: readonly string[]): LlmConfig {
  const provider = oneOf(str(llmRaw, 'provider', 'llm.provider') ?? 'none', LLM_PROVIDERS, 'llm.provider');
  const model = str(llmRaw, 'model', 'llm.model') ?? '';
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new ConfigError('config key "llm.model" must be at most 200 characters without control characters');
  }
  if (provider !== 'none' && model === '') throw new ConfigError(`config key "llm.model" is required for provider ${provider}`);
  if (provider === 'anthropic' && !allowedHosts.includes(ANTHROPIC_HOST)) {
    throw new ConfigError(`config key "llm.provider": "anthropic" requires "network.allowedHosts" to include ${ANTHROPIC_HOST}`);
  }
  let baseUrl = str(llmRaw, 'baseUrl', 'llm.baseUrl') ?? DEFAULT_LLM_URLS[provider];
  try {
    baseUrl = checkBaseUrl(baseUrl, allowedHosts);
  } catch (err) {
    if (!(err instanceof HostPolicyError)) throw err;
    throw new ConfigError(`config key "llm.baseUrl" ${err.message}`);
  }
  const apiKeyEnv = str(llmRaw, 'apiKeyEnv', 'llm.apiKeyEnv') ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_KEY_ENV : '');
  if (apiKeyEnv !== '' && !ENV_NAME_RE.test(apiKeyEnv)) {
    throw new ConfigError('config key "llm.apiKeyEnv" must be an environment variable name (A-Z, 0-9, _), not a key');
  }
  if (provider === 'anthropic' && apiKeyEnv === '') throw new ConfigError('config key "llm.apiKeyEnv" is required for provider anthropic');
  const intKey = (key: keyof typeof DEFAULT_LLM_BUDGET, min: number, max: number): number => {
    const v = llmRaw[key] === undefined ? DEFAULT_LLM_BUDGET[key] : llmRaw[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`config key "llm.${key}" must be an integer from ${min} to ${max}`);
    return v;
  };
  return {
    provider,
    model,
    baseUrl,
    apiKeyEnv,
    maxCallsPerRun: intKey('maxCallsPerRun', 1, 10_000),
    maxInputCharsPerRun: intKey('maxInputCharsPerRun', 1000, 100_000_000),
    maxOutputTokens: intKey('maxOutputTokens', 64, 64_000),
    timeoutMs: intKey('timeoutMs', 1000, 600_000),
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
