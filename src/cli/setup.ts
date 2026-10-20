// `ebrain setup`: one command from "installed" to "Claude can use it". It
// creates the config and vault (reusing a config that already exists), then
// registers the server with the clients found on this machine: Claude Code
// (`claude mcp add`), Claude Desktop (its config file), and Codex (`codex mcp
// add`). Registrations carry the absolute node and script paths, so they do
// not depend on a PATH, and never a command that downloads a package at launch.
//
// `bootstrapConfig` is also what `ebrain mcp --auto` uses, so a plugin can
// start the server with no prior setup.
//
// Registering rewrites a client's own config, so it asks first (or needs
// --yes). --dry-run prints the plan and changes nothing. Notes, the vault, and
// the audit log never leave the machine; nothing here uses the network.

import * as os from 'node:os';
import * as path from 'node:path';
import {
  CONFIG_ENV_VAR, ConfigError, configPath, expandHome, loadConfig, PRINCIPAL_ID_RE, type EnvOptions,
} from '../config.js';
import { runClientCli, type ClientCliRunner } from '../exec/clients.js';
import {
  ensureOwnerDir, readExternalFile, resolveInRoot, statSafe, writeAtomic,
} from '../safe-path.js';
import { entryPoint, MCP_SERVER_NAME, runInit, shellQuote } from './init.js';
import type { CommandResult } from './index-commands.js';

export const SETUP_USAGE = `usage: ebrain setup [--vault <dir>] [--mode inbox|read-only] [--client claude-code,claude-desktop,codex|all]
                    [--config <file>] [--yes] [--dry-run] [--force]`;

export const DEFAULT_VAULT = '~/Brain';
const CLIENTS = ['claude-code', 'claude-desktop', 'codex'] as const;
export type SetupClient = (typeof CLIENTS)[number];
const MAX_CLIENT_CONFIG_BYTES = 4 * 1024 * 1024;
const DESKTOP_CONFIG = 'claude_desktop_config.json';

export interface SetupOptions extends EnvOptions {
  /** Ask a question (default: only when stdin is a TTY). */
  prompt?: (question: string, fallback?: string) => Promise<string>;
  run?: ClientCliRunner;
  entry?: { node: string; script: string };
  platform?: NodeJS.Platform;
  username?: string;
}

export interface SetupArgs {
  vault?: string;
  mode?: string;
  client?: string;
  config?: string;
  yes: boolean;
  dryRun: boolean;
  force: boolean;
}

const VALUE_FLAGS: Record<string, 'vault' | 'mode' | 'client' | 'config'> = {
  '--vault': 'vault', '--mode': 'mode', '--client': 'client', '--config': 'config',
};
const BOOL_FLAGS: Record<string, 'yes' | 'dryRun' | 'force'> = { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun', '--force': 'force' };

export function parseSetupArgs(args: readonly string[]): SetupArgs {
  const out: SetupArgs = { yes: false, dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const boolKey = BOOL_FLAGS[flag];
    if (boolKey !== undefined && eq < 0) {
      out[boolKey] = true;
      continue;
    }
    const key = VALUE_FLAGS[flag];
    if (key === undefined) throw new ConfigError(`unknown argument ${JSON.stringify(arg)}`);
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || value === '') throw new ConfigError(`${flag} needs a value`);
    if (out[key] !== undefined) throw new ConfigError(`${flag} given twice`);
    out[key] = value;
  }
  if (out.mode !== undefined && out.mode !== 'inbox' && out.mode !== 'read-only') {
    throw new ConfigError('--mode must be inbox or read-only (journal is for agents: use `ebrain init`)');
  }
  return out;
}

function parseClients(value: string | undefined): SetupClient[] | 'detected' {
  if (value === undefined || value === 'all') return 'detected';
  const out: SetupClient[] = [];
  for (const part of value.split(',')) {
    const name = part.trim();
    if (!(CLIENTS as readonly string[]).includes(name)) throw new ConfigError(`unknown client ${JSON.stringify(name)} (use ${CLIENTS.join(', ')}, or all)`);
    if (!out.includes(name as SetupClient)) out.push(name as SetupClient);
  }
  return out;
}

/**
 * The command a client should launch: this install's node and script. A copy that is running from a temporary
 * download cache would vanish from under the registration, so it is refused (and the client is never pointed at a
 * command that would fetch a package at launch: no runtime installs).
 */
export function serverCommand(entry = entryPoint()): { command: string; args: string[] } {
  if (entry.script.split(path.sep).includes('_npx')) {
    throw new ConfigError('this copy of ebrain is running from a temporary download; install it permanently first (see the README, "Install from npm"), then run `ebrain setup` again');
  }
  return { command: entry.node, args: [entry.script, 'mcp'] };
}

function defaultPrincipal(opts: SetupOptions): string {
  const env = opts.env ?? process.env;
  const raw = (opts.username ?? env['USER'] ?? env['USERNAME'] ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '');
  const id = raw.slice(0, 64);
  return PRINCIPAL_ID_RE.test(id) ? id : 'me';
}

function configExists(cfgPath: string): boolean {
  try {
    return statSafe(resolveInRoot(path.dirname(cfgPath), path.basename(cfgPath))) !== undefined;
  } catch {
    return false;
  }
}

export interface Bootstrapped {
  cfgPath: string;
  created: boolean;
  vault: string;
  mode: string;
  log: string[];
}

/** Use the config that exists, or create one (and the vault) from the answers and defaults. */
export async function bootstrapConfig(
  want: { vault?: string; mode?: string; config?: string },
  opts: SetupOptions = {},
): Promise<Bootstrapped> {
  const env = opts.env ?? process.env;
  const cfgPath = want.config !== undefined ? expandHome(want.config, '--config', opts.homeDir) : configPath(opts);
  if (configExists(cfgPath)) {
    const loaded = loadConfig({ ...opts, path: cfgPath });
    if (want.vault !== undefined && expandHome(want.vault, '--vault', opts.homeDir) !== loaded.config.vaultPath) {
      throw new ConfigError(`${cfgPath} already exists and uses vault ${loaded.config.vaultPath}; use --config <other file> for a different vault`);
    }
    return { cfgPath, created: false, vault: loaded.config.vaultPath, mode: loaded.config.mode, log: [] };
  }
  const vault = want.vault ?? (env['EBRAIN_VAULT'] !== undefined && env['EBRAIN_VAULT'] !== '' ? env['EBRAIN_VAULT'] : undefined)
    ?? (opts.prompt !== undefined ? await opts.prompt('Vault folder (your notes, a Markdown/Obsidian folder)', DEFAULT_VAULT) : DEFAULT_VAULT);
  const mode = want.mode ?? env['EBRAIN_MODE'] ?? 'inbox';
  if (mode !== 'inbox' && mode !== 'read-only') throw new ConfigError('mode must be inbox or read-only');
  const result = await runInit(
    ['--vault', vault, '--principal', defaultPrincipal(opts), '--mode', mode, '--config', cfgPath],
    opts.homeDir === undefined ? {} : { homeDir: opts.homeDir },
  );
  if (result.code !== 0) throw new ConfigError(result.stderr.trim().replace(/^ebrain init: /, ''));
  const loaded = loadConfig({ ...opts, path: cfgPath });
  return {
    cfgPath, created: true, vault: loaded.config.vaultPath, mode: loaded.config.mode,
    log: result.stdout.split('\n').filter((l) => l.startsWith('config:') || l.startsWith('vault:')),
  };
}

function desktopDir(opts: SetupOptions): string | undefined {
  const home = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const rel = platform === 'darwin' ? 'Library/Application Support/Claude' : platform === 'linux' ? '.config/Claude' : undefined;
  if (rel === undefined) return undefined;
  const dir = path.join(home, rel);
  try {
    const st = statSafe(resolveInRoot(home, rel));
    return st?.isDirectory() === true ? dir : undefined;
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Add the server to Claude Desktop's config file. Returns a one-line outcome. */
function registerDesktop(dir: string, cfgPath: string, cmd: { command: string; args: string[] }, force: boolean): string {
  const file = path.join(dir, DESKTOP_CONFIG);
  let text = '';
  let mode: number | undefined;
  try {
    const read = readExternalFile(file, [dir]);
    if (read.data.length > MAX_CLIENT_CONFIG_BYTES) throw new ConfigError(`${file} is too large; left untouched`);
    text = read.data.toString('utf8');
    mode = read.stat.mode & 0o777;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: Json = {};
  if (text.trim() !== '') {
    try {
      const v: unknown = JSON.parse(text);
      if (!isObject(v)) throw new Error('not an object');
      parsed = v;
    } catch {
      throw new ConfigError(`${file} is not a valid JSON object; left untouched`);
    }
  }
  if (parsed['mcpServers'] !== undefined && !isObject(parsed['mcpServers'])) throw new ConfigError(`${file}: "mcpServers" is not an object; left untouched`);
  const servers: Json = isObject(parsed['mcpServers']) ? parsed['mcpServers'] : (parsed['mcpServers'] = {}) as Json;
  if (servers[MCP_SERVER_NAME] !== undefined && !force) return `Claude Desktop: already registered in ${file} (use --force to replace)`;
  servers[MCP_SERVER_NAME] = { command: cmd.command, args: cmd.args, env: { [CONFIG_ENV_VAR]: cfgPath } };
  const dirPath = ensureOwnerDir(dir);
  if (text !== '') {
    const backup = resolveInRoot(dirPath, `${DESKTOP_CONFIG}.ebrain-backup`);
    if (statSafe(backup) === undefined) writeAtomic(backup, text);
  }
  writeAtomic(resolveInRoot(dirPath, DESKTOP_CONFIG), `${JSON.stringify(parsed, null, 2)}\n`, mode === undefined ? {} : { mode });
  return `Claude Desktop: registered in ${file} (restart Claude Desktop)`;
}

function registerCli(
  cli: 'claude' | 'codex', run: ClientCliRunner, cfgPath: string, cmd: { command: string; args: string[] }, force: boolean,
): string {
  const label = cli === 'claude' ? 'Claude Code' : 'Codex';
  const exists = run(cli, ['mcp', 'get', MCP_SERVER_NAME]).ok;
  if (exists && !force) return `${label}: already registered (use --force to replace)`;
  if (exists) run(cli, cli === 'claude' ? ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME] : ['mcp', 'remove', MCP_SERVER_NAME]);
  const add = cli === 'claude'
    ? ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '-e', `${CONFIG_ENV_VAR}=${cfgPath}`, '--', cmd.command, ...cmd.args]
    : ['mcp', 'add', MCP_SERVER_NAME, '--env', `${CONFIG_ENV_VAR}=${cfgPath}`, '--', cmd.command, ...cmd.args];
  const res = run(cli, add);
  if (!res.ok) throw new ConfigError(`${label}: \`${cli} mcp add\` failed${res.stderr.trim() === '' ? '' : `: ${res.stderr.trim().split('\n')[0]}`}`);
  return `${label}: registered (${cli === 'claude' ? 'start a new session' : 'start a new codex session'})`;
}

/** Run `ebrain setup`. */
export async function runSetup(args: readonly string[], opts: SetupOptions = {}): Promise<CommandResult> {
  let parsed: SetupArgs;
  let wanted: SetupClient[] | 'detected';
  try {
    parsed = parseSetupArgs(args);
    wanted = parseClients(parsed.client);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `ebrain setup: ${err instanceof Error ? err.message : String(err)}\n${SETUP_USAGE}\n` };
  }
  const run = opts.run ?? runClientCli;
  const out: string[] = [];
  try {
    // Which clients exist here.
    const present: SetupClient[] = [];
    if (!run('claude', ['--version']).absent) present.push('claude-code');
    if (desktopDir(opts) !== undefined) present.push('claude-desktop');
    if (!run('codex', ['--version']).absent) present.push('codex');
    const targets = wanted === 'detected' ? present : wanted;
    for (const t of targets) if (!present.includes(t) && wanted !== 'detected') throw new ConfigError(`${t} was not found on this machine`);

    const cmd = serverCommand(opts.entry);
    const cfgPath = parsed.config !== undefined ? expandHome(parsed.config, '--config', opts.homeDir) : configPath(opts);
    const exists = configExists(cfgPath);
    out.push(
      exists ? `config: ${cfgPath} (exists; reused)` : `config: ${cfgPath} (will be created)`,
      `server: ${[cmd.command, ...cmd.args].map(shellQuote).join(' ')}`,
      `clients: ${targets.length === 0 ? 'none found' : targets.join(', ')}`,
    );
    if (parsed.dryRun) {
      out.push('', 'dry run: nothing changed.');
      return { code: 0, stdout: `${out.join('\n')}\n`, stderr: '' };
    }
    if (!parsed.yes) {
      if (opts.prompt === undefined) throw new ConfigError('this edits client configs; pass --yes (stdin is not a terminal), or --dry-run to preview');
      const answer = (await opts.prompt(`${out.join('\n')}\nProceed? (yes/no)`, 'yes')).toLowerCase();
      if (answer !== 'yes' && answer !== 'y') return { code: 1, stdout: '', stderr: 'ebrain setup: cancelled; nothing changed\n' };
      out.length = 0;
    }

    const boot = await bootstrapConfig(
      { ...(parsed.vault === undefined ? {} : { vault: parsed.vault }), ...(parsed.mode === undefined ? {} : { mode: parsed.mode }), config: cfgPath },
      opts,
    );
    out.push(boot.created ? `created ${boot.cfgPath} (vault ${boot.vault}, mode ${boot.mode})` : `using ${boot.cfgPath} (vault ${boot.vault}, mode ${boot.mode})`);

    const dDir = desktopDir(opts);
    for (const t of targets) {
      if (t === 'claude-code') out.push(registerCli('claude', run, boot.cfgPath, cmd, parsed.force));
      else if (t === 'codex') out.push(registerCli('codex', run, boot.cfgPath, cmd, parsed.force));
      else if (dDir !== undefined) out.push(registerDesktop(dDir, boot.cfgPath, cmd, parsed.force));
    }
    if (targets.length === 0) {
      out.push('No Claude Code, Claude Desktop, or Codex found. Register by hand with the snippets from `ebrain init`, or install a client and re-run.');
    }
    out.push(
      '',
      `Check: ${CONFIG_ENV_VAR}=${shellQuote(boot.cfgPath)} ebrain doctor --strict`,
      'Then ask Claude about your notes, for example: "What have we decided about <a topic in your vault>?"',
    );
    return { code: 0, stdout: `${out.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: out.length > 0 ? `${out.join('\n')}\n` : '', stderr: `ebrain setup: ${err instanceof Error ? err.message : String(err)}\n` };
  }
}
