// `ebrain scrub <file|-> [--strict] [--entropy-threshold <bits>]` (Phase 7):
// print the scrubbed text on stdout and finding counts on stderr. Nothing
// printed ever contains a matched secret. `--strict` applies the agent rules:
// a credential-class detection prints the rejection (detector types only),
// prints no text, and exits 3.

import * as path from 'node:path';
import { ConfigError, loadConfig, type EnvOptions } from '../config.js';
import { openExternalFile, readStdinSafe } from '../safe-path.js';
import { formatFindings, scrub, ScrubError } from '../scrub/index.js';
import type { CommandResult } from './index-commands.js';

/** Largest input `ebrain scrub` reads. */
export const MAX_SCRUB_INPUT_BYTES = 32 * 1024 * 1024;
export const SCRUB_USAGE = 'usage: ebrain scrub <file|-> [--strict] [--entropy-threshold <bits>]';

export interface ScrubCommandOptions extends EnvOptions {
  cwd?: string;
  readStdin?: () => Buffer;
}

function usage(msg: string): CommandResult {
  return { code: 2, stdout: '', stderr: `ebrain scrub: ${msg}\n${SCRUB_USAGE}\n` };
}

/** `scrub.extraPatterns` from the config if one exists; a missing config means none. */
function extraPatterns(opts: EnvOptions): string[] {
  try {
    return loadConfig(opts).config.scrub.extraPatterns;
  } catch (err) {
    if (err instanceof ConfigError && err.message.startsWith('config file not found')) return [];
    throw err;
  }
}

export function runScrub(args: readonly string[], opts: ScrubCommandOptions = {}): CommandResult {
  let input: string | undefined;
  let strict = false;
  let entropyThreshold: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--strict') strict = true;
    else if (a === '--entropy-threshold') {
      const v = args[++i];
      if (v === undefined || !/^[0-9]+(?:\.[0-9]+)?$/.test(v)) return usage('--entropy-threshold needs a number');
      entropyThreshold = Number(v);
    } else if (a.startsWith('--')) return usage(`unknown flag ${JSON.stringify(a)}`);
    else if (input === undefined) input = a;
    else return usage(`unexpected argument ${JSON.stringify(a)}`);
  }
  if (input === undefined) return usage('missing <file|->');

  let data: Buffer;
  try {
    if (input === '-') {
      data = (opts.readStdin ?? (() => readStdinSafe(MAX_SCRUB_INPUT_BYTES)))();
    } else {
      const abs = path.resolve(opts.cwd ?? process.cwd(), input);
      const file = openExternalFile(abs, [path.dirname(abs)]);
      try {
        if (file.stat.size > MAX_SCRUB_INPUT_BYTES) return { code: 1, stdout: '', stderr: `ebrain scrub: input exceeds ${MAX_SCRUB_INPUT_BYTES} bytes\n` };
        data = file.readBuffer();
      } finally {
        file.close();
      }
    }
  } catch (err) {
    return { code: 1, stdout: '', stderr: `ebrain scrub: cannot read input: ${err instanceof Error ? err.message : String(err)}\n` };
  }
  if (data.length > MAX_SCRUB_INPUT_BYTES) return { code: 1, stdout: '', stderr: `ebrain scrub: input exceeds ${MAX_SCRUB_INPUT_BYTES} bytes\n` };

  try {
    const r = scrub(data.toString('utf8'), { strict, extraPatterns: extraPatterns(opts), ...(entropyThreshold === undefined ? {} : { entropyThreshold }) });
    const summary = r.findings.length === 0 ? 'findings: none\n' : `findings:\n${formatFindings(r.findings)}\n`;
    if (!r.ok) {
      return { code: 3, stdout: '', stderr: `${summary}rejected (strict): ${r.rejection.detectors.join(', ')}\n` };
    }
    return { code: 0, stdout: r.text, stderr: summary };
  } catch (err) {
    const prefix = err instanceof ConfigError ? 'config: ' : '';
    const msg = err instanceof ScrubError || err instanceof ConfigError ? err.message : 'scrubbing failed';
    return { code: 1, stdout: '', stderr: `ebrain scrub: ${prefix}${msg}\n` };
  }
}
