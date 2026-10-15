// `ebrain init`: first-run setup (Phase 6). Writes config.json (0600, never
// overwriting an existing one), creates the state dir (0700), creates the
// vault and its `_inbox/`, `_raw/`, `references/` (and
// `journal/<principal-id>/` in journal mode) if missing, and prints the
// Claude Code and Claude Desktop MCP snippets with absolute paths.
//
// Values come from flags; missing ones are prompted for when stdin is a
// terminal, otherwise init fails naming the missing flags.

import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_ENV_VAR, ConfigError, configPath, DEFAULT_STATE_DIR, ensureStateDir, expandHome, loadConfig, parseConfig,
  type Config, type EnvOptions,
} from '../config.js';
import {
  createExclusive, ensureOwnerDir, mkdirSafe, resolveInRoot, resolveInVault, SafePathError, statSafe,
} from '../safe-path.js';
import type { CommandResult } from './index-commands.js';

/** Name the snippets register the server under. */
export const MCP_SERVER_NAME = 'e3d-brain';

export const INIT_USAGE = `usage: ebrain init [--vault <dir>] [--principal <id>] [--type human|agent]
                  [--mode inbox|journal|read-only] [--state-dir <dir>] [--config <file>]`;

const FLAGS: Record<string, keyof InitAnswers> = {
  '--vault': 'vault',
  '--principal': 'principal',
  '--type': 'type',
  '--mode': 'mode',
  '--state-dir': 'stateDir',
  '--config': 'config',
};

export interface InitAnswers {
  vault?: string;
  principal?: string;
  type?: string;
  mode?: string;
  stateDir?: string;
  config?: string;
}

export interface InitOptions extends EnvOptions {
  /** Ask for missing values (default: when stdin is a TTY). */
  prompt?: (question: string, fallback?: string) => Promise<string>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseInitArgs(args: readonly string[]): InitAnswers {
  const out: InitAnswers = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const key = FLAGS[flag];
    if (key === undefined) throw new ConfigError(`unknown argument ${JSON.stringify(arg)}`);
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || value === '') throw new ConfigError(`${flag} needs a value`);
    if (out[key] !== undefined) throw new ConfigError(`${flag} given twice`);
    out[key] = value;
  }
  return out;
}

/** Absolute node binary and absolute `ebrain` entry script, for MCP client configs. */
export function entryPoint(): { node: string; script: string } {
  return { node: process.execPath, script: fileURLToPath(new URL('./main.js', import.meta.url)) };
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The Claude Code and Claude Desktop snippets for a config file. */
export function mcpSnippets(cfgPath: string, entry = entryPoint()): string {
  const cli = ['claude', 'mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '-e', `${CONFIG_ENV_VAR}=${cfgPath}`, '--', entry.node, entry.script, 'mcp'];
  const desktop = { mcpServers: { [MCP_SERVER_NAME]: { command: entry.node, args: [entry.script, 'mcp'], env: { [CONFIG_ENV_VAR]: cfgPath } } } };
  return [
    'Claude Code:',
    `  ${cli.map(shellQuote).join(' ')}`,
    '',
    'Claude Desktop (add to claude_desktop_config.json):',
    ...JSON.stringify(desktop, null, 2).split('\n').map((l) => `  ${l}`),
    '',
    `Only approve MCP servers you wrote: mode and principal come from whichever config ${CONFIG_ENV_VAR} names.`,
  ].join('\n');
}

async function fillMissing(a: InitAnswers, prompt: InitOptions['prompt']): Promise<InitAnswers> {
  const missing = (['vault', 'principal'] as const).filter((k) => a[k] === undefined);
  if (missing.length > 0 && prompt === undefined) {
    throw new ConfigError(`missing ${missing.map((k) => (k === 'vault' ? '--vault' : '--principal')).join(', ')} (stdin is not a terminal)`);
  }
  if (prompt === undefined) return a;
  const out = { ...a };
  if (out.vault === undefined) out.vault = await prompt('Vault directory (absolute or ~/...)');
  if (out.principal === undefined) out.principal = await prompt('Principal id (lowercase, e.g. your first name)');
  if (out.mode === undefined) out.mode = await prompt('Mode (inbox, journal, read-only)', 'inbox');
  if (out.type === undefined) out.type = await prompt('Principal type (human, agent)', out.mode === 'journal' ? 'agent' : 'human');
  if (out.stateDir === undefined) out.stateDir = await prompt('State directory', DEFAULT_STATE_DIR);
  return out;
}

function ensureVaultDir(config: Config, rel: string, created: string[]): void {
  const p = resolveInVault(config.vaultPath, rel);
  const st = statSafe(p);
  if (st !== undefined) {
    if (!st.isDirectory()) throw new SafePathError('invalid', `vault entry ${rel} exists and is not a directory`);
    return;
  }
  mkdirSafe(p);
  created.push(`${rel}/`);
}

/** Run `ebrain init`. */
export async function runInit(args: readonly string[], opts: InitOptions = {}): Promise<CommandResult> {
  let answers: InitAnswers;
  try {
    answers = await fillMissing(parseInitArgs(args), opts.prompt);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `ebrain init: ${message(err)}\n${INIT_USAGE}\n` };
  }
  try {
    const mode = answers.mode ?? 'inbox';
    const raw = {
      vaultPath: answers.vault,
      stateDir: answers.stateDir ?? DEFAULT_STATE_DIR,
      principal: { id: answers.principal, type: answers.type ?? (mode === 'journal' ? 'agent' : 'human') },
      mode,
    };
    const config = parseConfig(raw, opts.homeDir === undefined ? {} : { homeDir: opts.homeDir });
    const cfgPath = answers.config !== undefined ? expandHome(answers.config, '--config', opts.homeDir) : configPath(opts);
    const cfgDir = ensureOwnerDir(path.dirname(cfgPath));
    const cfgFile = resolveInRoot(cfgDir, path.basename(cfgPath));
    if (statSafe(cfgFile) !== undefined) throw new ConfigError(`config file already exists: ${cfgFile} (refusing to overwrite)`);

    ensureOwnerDir(config.vaultPath);
    const stateDir = ensureStateDir(config);
    const created: string[] = [];
    for (const rel of ['_inbox', '_raw', 'references']) ensureVaultDir(config, rel, created);
    if (config.mode === 'journal') ensureVaultDir(config, `journal/${config.principal.id}`, created);

    const body = { vaultPath: config.vaultPath, stateDir: config.stateDir, principal: config.principal, mode: config.mode };
    createExclusive(cfgFile, `${JSON.stringify(body, null, 2)}\n`);
    // Load it back exactly as the server will (ownership, permissions, schema).
    loadConfig({ ...opts, path: cfgFile });

    const lines = [
      `config: ${cfgFile} (principal ${config.principal.id} [${config.principal.type}], mode ${config.mode})`,
      `state dir: ${stateDir} (0700)`,
      `vault: ${config.vaultPath}${created.length > 0 ? ` (created ${created.join(', ')})` : ''}`,
      '',
      mcpSnippets(cfgFile),
      '',
      `Next: EBRAIN_CONFIG=${shellQuote(cfgFile)} ebrain doctor --strict`,
    ];
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain init: ${message(err)}\n` };
  }
}

/** A readline prompt on the terminal (used when stdin is a TTY). */
export function terminalPrompt(): { prompt: NonNullable<InitOptions['prompt']>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    prompt: async (question, fallback) => {
      const answer = (await rl.question(`${question}${fallback === undefined ? '' : ` [${fallback}]`}: `)).trim();
      return answer === '' && fallback !== undefined ? fallback : answer;
    },
    close: () => rl.close(),
  };
}
