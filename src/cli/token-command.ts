// `ebrain token create --principal <id>`: make (or rotate) the bearer token for
// the optional HTTP transport. The plaintext is printed once; only its hash is stored.

import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { createToken } from '../net/token.js';
import type { CommandResult } from './index-commands.js';

const USAGE = 'usage: ebrain token create --principal <id>\n';

export function runToken(args: readonly string[], opts: EnvOptions = {}): CommandResult {
  const bad = (stderr: string): CommandResult => ({ code: 2, stdout: '', stderr });
  if (args[0] !== 'create') return bad(USAGE);
  if (args.length !== 3 || args[1] !== '--principal') return bad(USAGE);
  const principal = args[2]!;
  try {
    const { config } = loadConfig(opts);
    if (principal !== config.principal.id) {
      return { code: 1, stdout: '', stderr: `ebrain token: principal "${principal}" is not this instance's principal ("${config.principal.id}")\n` };
    }
    const token = createToken(ensureStateDir(config), principal);
    return {
      code: 0,
      stdout: `${token}\n`,
      stderr: 'ebrain token: shown once and stored only as a hash; running this again replaces (rotates) the token\n',
    };
  } catch (err) {
    const prefix = err instanceof ConfigError ? 'config: ' : '';
    return { code: 1, stdout: '', stderr: `ebrain token: ${prefix}${err instanceof Error ? err.message : String(err)}\n` };
  }
}
