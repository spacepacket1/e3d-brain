// `ebrain mcp`: the MCP server over stdio (Phase 6). stdout is the protocol
// channel; every log line goes to stderr and never contains note text, query
// text, or tool arguments.
//
// Tools reach the SDK server only through dispatch (`attachToServer`), which
// validates, enforces mode, fences, caps, and audits every call.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLog, segmentBytes } from '../audit/audit.js';
import { closeIndex, openIndex } from '../index/indexer.js';
import { checkFts5 } from '../index/sqlite.js';
import { ensureStateDir, type LoadedConfig } from '../config.js';
import { VERSION } from '../version.js';
import { attachToServer, listTools, ToolRegistry, type DispatchContext } from './dispatch.js';
import { registerInboxTools } from './inbox-tools.js';
import { registerJournalTools } from './journal-tools.js';
import { registerReadTools } from './tools.js';

export const SERVER_NAME = 'e3d-brain';

export interface McpServerOptions {
  loaded: LoadedConfig;
  stdin?: NodeJS.ReadableStream & { on(event: string, fn: () => void): unknown };
  stdout?: NodeJS.WritableStream;
  /** Log sink (stderr by default). */
  log?: (line: string) => void;
}

/** Keep stray console output off stdout, which carries protocol frames only. */
function guardStdout(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

/** Serve until stdin closes. Throws before serving if the config, vault, index, or FTS5 is unusable. */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`ebrain mcp: ${line}\n`));
  guardStdout();
  const { config } = opts.loaded;
  const fts = checkFts5();
  if (!fts.ok) throw new Error(`${fts.error}; ${fts.hint}`);
  const stateDir = ensureStateDir(config);
  const index = openIndex({ vaultPath: config.vaultPath, stateDir });

  const registry = new ToolRegistry();
  registerReadTools({ vaultPath: config.vaultPath, index, mode: config.mode }, registry);
  // capture and list_inbox exist in inbox mode only (Phase 8, I2).
  if (config.mode === 'inbox') registerInboxTools({ vaultPath: config.vaultPath, index, extraPatterns: config.scrub.extraPatterns }, registry);
  // journal_append and journal_list exist in journal mode only (Phase 9, I2; journal mode requires an agent principal).
  if (config.mode === 'journal' && config.principal.type === 'agent') {
    registerJournalTools(
      { vaultPath: config.vaultPath, stateDir, index, limits: config.journal, extraPatterns: config.scrub.extraPatterns },
      registry,
    );
  }
  const ctx: DispatchContext = {
    mode: config.mode,
    principal: { ...config.principal },
    maxCharsPerCall: config.limits.maxCharsPerCall,
    registry,
    audit: new AuditLog(stateDir, { maxSegmentBytes: segmentBytes(config.audit.maxSegmentMB) }),
  };

  const server = new Server({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });
  attachToServer(server, ctx);
  // Protocol errors are logged by kind only: their messages can echo request content.
  server.onerror = (err) => log(`protocol error (${err.name})`);

  const stdin = opts.stdin ?? process.stdin;
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    const end = () => void server.close().catch(() => resolve());
    stdin.on('end', end);
    stdin.on('close', end);
  });
  const transport = new StdioServerTransport(
    stdin as NodeJS.ReadStream & typeof process.stdin,
    (opts.stdout ?? process.stdout) as NodeJS.WriteStream & typeof process.stdout,
  );
  await server.connect(transport);
  log(`serving ${listTools(config.mode, registry).length} tools (principal ${config.principal.id}, mode ${config.mode})`);
  try {
    await closed;
  } finally {
    closeIndex(index);
    log('stopped');
  }
}
