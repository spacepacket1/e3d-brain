// `ebrain propose [--since <date>] [--source <id>] [--i-understand-data-leaves-machine]`
// (Phase 14): owner CLI only, never MCP. Needs `mode: inbox`, a `human`
// principal, and a configured `llm.provider`; writes candidate notes only to
// `_inbox/`.

import { ConfigError, ensureStateDir, loadConfig, type EnvOptions } from '../config.js';
import { createProvider, DATA_LEAVES_MACHINE_FLAG, LlmRefusedError } from '../llm/provider.js';
import { isSourceFilter } from '../propose/archive-reader.js';
import { propose, type ProposeResult } from '../propose/propose.js';
import { isIsoDate } from '../vault/parse.js';
import type { CommandResult } from './index-commands.js';

export const PROPOSE_USAGE = `usage: ebrain propose [--since <date>] [--source <source|archive-id>] [${DATA_LEAVES_MACHINE_FLAG}]`;

export interface ProposeCommandOptions extends EnvOptions {
  now?: () => Date;
}

function summarize(r: ProposeResult): string {
  const lines = r.created.map((p) => `created ${p}`);
  lines.push(
    `propose: ${r.archives} archive notes, ${r.calls} provider calls (${r.inputChars} chars sent), ` +
      `${r.created.length} candidates created, ${r.duplicates} duplicates skipped`,
    `dropped: ${r.invalidItems} invalid items, ${r.unsupportedQuotes} unsupported quotes, ${r.invalidResponses} malformed responses; ` +
      `${r.malformedArchives} malformed archive files skipped, ${r.filteredArchives} outside the filter`,
    `scrub findings: ${r.findings.length === 0 ? 'none' : r.findings.map((f) => `${f.type}: ${f.count}`).join(', ')}`,
  );
  if (r.stop !== undefined) lines.push(`stopped: budget ${r.stop} reached (${r.windowsSkipped} windows not sent)`);
  return `${lines.join('\n')}\n`;
}

export async function runPropose(args: readonly string[], opts: ProposeCommandOptions = {}): Promise<CommandResult> {
  const fail = (code: number, msg: string): CommandResult => ({ code, stdout: '', stderr: `ebrain propose: ${msg}\n${code === 2 ? `${PROPOSE_USAGE}\n` : ''}` });
  let since: string | undefined;
  let source: string | undefined;
  let leaves = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === DATA_LEAVES_MACHINE_FLAG) leaves = true;
    else if (a === '--since' || a === '--source') {
      const v = args[++i];
      if (v === undefined || v === '') return fail(2, `${a} needs a value`);
      if (a === '--since') {
        if (since !== undefined) return fail(2, '--since given twice');
        if (!isIsoDate(v)) return fail(2, '--since must be an ISO 8601 date');
        since = v;
      } else {
        if (source !== undefined) return fail(2, '--source given twice');
        if (!isSourceFilter(v)) return fail(2, '--source must be claude-code, claude-export, chatgpt-export, or an archive id (raw_...)');
        source = v;
      }
    } else return fail(2, `unexpected argument ${JSON.stringify(a)}`);
  }

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(opts);
  } catch (err) {
    return fail(1, `${err instanceof ConfigError ? 'config: ' : ''}${err instanceof Error ? err.message : String(err)}`);
  }
  const { config } = loaded;
  if (config.mode !== 'inbox' || config.principal.type !== 'human') {
    return fail(1, `needs mode "inbox" and a human principal (this instance: mode "${config.mode}", principal type "${config.principal.type}"); refusing`);
  }
  let provider: ReturnType<typeof createProvider>;
  try {
    provider = createProvider(config.llm, { allowedHosts: config.network.allowedHosts, env: opts.env ?? process.env, dataLeavesMachine: leaves });
  } catch (err) {
    if (err instanceof LlmRefusedError) return fail(1, err.message);
    throw err;
  }
  if (provider === undefined) {
    return fail(1, 'no extraction provider is configured (llm.provider is "none"); set llm.provider to "openai-compatible" (a local model) in the config. See docs/SETUP.md, "Candidate notes (propose)"');
  }
  try {
    const r = await propose({
      config,
      stateDir: ensureStateDir(config),
      provider,
      filter: { ...(since === undefined ? {} : { sinceMs: Date.parse(since) }), ...(source === undefined ? {} : { source }) },
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    const out = summarize(r);
    if (r.error !== undefined) return { code: 1, stdout: out, stderr: `ebrain propose: ${r.error} (${r.windowsSkipped} windows not sent)\n` };
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return fail(1, `failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
