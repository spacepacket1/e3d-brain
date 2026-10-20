// `ebrain setup`: run the owner's own Claude Code or Codex CLI to register the
// MCP server (`claude mcp add`, `codex mcp add`). I3: child_process lives in
// src/exec/ only. The program is chosen from a closed list (never a string
// from config or a tool argument), spawned by name through the OS PATH lookup
// without a shell, with an argument array, a timeout, and an output size cap.

import { spawnSync } from 'node:child_process';

export type ClientCli = 'claude' | 'codex';

export const CLIENT_CLI_TIMEOUT_MS = 60_000;
export const CLIENT_CLI_MAX_BYTES = 1024 * 1024;

export interface ClientCliResult {
  /** The program exists and exited 0. */
  ok: boolean;
  /** The program was not found on PATH. */
  absent: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export type ClientCliRunner = (cli: ClientCli, args: readonly string[], env?: NodeJS.ProcessEnv) => ClientCliResult;

/** Run `<cli> <args...>` and capture its output. */
export const runClientCli: ClientCliRunner = (cli, args, env = process.env) => {
  const res = spawnSync(cli, [...args], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLIENT_CLI_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: CLIENT_CLI_MAX_BYTES,
    env,
    encoding: 'utf8',
  });
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return { ok: false, absent: true, status: null, stdout: '', stderr: '' };
  return {
    ok: res.error === undefined && res.status === 0,
    absent: false,
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.error !== undefined ? `could not run ${cli} (${code ?? 'error'})` : (res.stderr ?? ''),
  };
};
