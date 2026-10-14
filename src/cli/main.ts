#!/usr/bin/env node
// `ebrain` CLI entry point.

import { runAudit } from './audit-commands.js';
import { runDoctor } from './doctor.js';
import { runInbox } from './inbox-commands.js';
import { runIndexCommand, runReindex, type CommandResult } from './index-commands.js';
import { runInit, terminalPrompt } from './init.js';
import { isConversationImportSource, runConversationImport } from './import-commands.js';
import { runHook } from './hook-commands.js';
import { runImport, runJournal } from './journal-commands.js';
import { runRefs } from './refs-commands.js';
import { runScrub } from './scrub-command.js';
import { ConfigError, loadConfig } from '../config.js';
import { runMcpServer } from '../mcp/server.js';
import { VERSION } from '../version.js';

const USAGE = `usage: ebrain <command>

commands:
  init [flags]      write config.json, create the state dir and vault folders, print MCP snippets
                    (--vault, --principal, --type, --mode, --state-dir, --config; prompts on a terminal)
  mcp               run the MCP server over stdio (stdout carries protocol frames only)
  doctor [--strict] report platform, config, vault, state dir, and FTS5 status
                    (--strict: also fail on remote hosts, loose state perms, escaping vault symlinks)
  reindex [--full]  update the search index from the vault (--full: rebuild from scratch)
  index dump        print a canonical dump of the index contents
  audit tail [-n N] print the last N audit lines (all segments, oldest first)
  audit stats       summarize the audit log (segments, outcomes, tools)
  audit prune --older-than <days>
                    delete whole audit segments older than <days> (never the current one)
  inbox list        list proposals waiting in _inbox/ (owner review; not available over MCP)
  inbox show <id>   print a proposal
  inbox accept <id> [--to <folder>] [--edit]
                    move a proposal to <folder> (default notes/) with status: accepted
  inbox reject <id> [--reason <text>]
                    move a proposal to _inbox/_rejected/ with status: rejected
  journal prune [--dry-run]
                    move journal entries past their expires date to journal/_archive/<principal-id>/
                    (never deletes; --dry-run lists only)
  import agent-workspace <dir> --principal <id>
                    import MEMORY.md, memory/YYYY-MM-DD.md, GOALS.md (and SOUL.md, TOOLS.md) into
                    journal/<id>/imported/ (strict scrub; idempotent; <id> must be the configured principal)
  import claude-code [--projects-dir <dir>] [--dry-run]
                    archive Claude Code transcripts (default ~/.claude/projects) into
                    _raw/conversations/claude-code/ (scrubbed; idempotent; human principal only)
  import claude-export <file.zip|dir> [--dry-run]
  import chatgpt-export <file.zip|dir> [--dry-run]
                    archive a Claude.ai or ChatGPT data export into _raw/conversations/<source>/
                    (--dry-run: print conversation, turn, and scrub-finding counts; write nothing)
  refs add <file> [--title <t>] [--author <a>]
                    add a book (.epub, .md, .txt; .pdf needs the external pdftotext) to the reference
                    library: scrubbed text in <stateDir>/refs.db, one owner note in references/ (re-adding is a no-op)
  refs list         list the reference library
  refs remove <ref_id>
                    remove a book's rows from refs.db (your references/ note stays)
  refs reindex      rebuild refs.db from the original source files (moved sources are reported missing)
  hook session-start
                    print a session brief (Claude Code SessionStart hook; always exits 0)
  hook pre-compact  write one checkpoint proposal to _inbox/ (needs mode inbox and hooks.captureCheckpoints: true)
  hook install      add ebrain's SessionStart and PreCompact hooks to ~/.claude/settings.json
  hook remove       remove only the hooks ebrain added
  scrub <file|-> [--strict] [--entropy-threshold <bits>]
                    print the text with secrets redacted; finding counts go to stderr
                    (--strict: agent rules, reject on any credential and exit 3)
  --version         print the version
  --help            show this help

config: ~/.e3d-brain/config.json (override with EBRAIN_CONFIG)`;

function emit(r: CommandResult): number {
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.code;
}

async function runInitCommand(args: readonly string[]): Promise<number> {
  const terminal = process.stdin.isTTY ? terminalPrompt() : undefined;
  try {
    return emit(await runInit(args, terminal === undefined ? {} : { prompt: terminal.prompt }));
  } finally {
    terminal?.close();
  }
}

async function runMcp(args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(`ebrain mcp: unexpected argument ${JSON.stringify(args[0])}\n`);
    return 2;
  }
  try {
    await runMcpServer({ loaded: loadConfig() });
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ebrain mcp: ${err instanceof ConfigError ? 'config: ' : ''}${msg}\n`);
    return 1;
  }
}

export function main(argv: readonly string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return command === undefined ? 1 : 0;
    case 'doctor': {
      const strict = rest[0] === '--strict';
      const extra = strict ? rest.slice(1) : rest;
      if (extra.length > 0) {
        process.stderr.write(`ebrain doctor: unexpected argument ${JSON.stringify(extra[0])}\n`);
        return 2;
      }
      const report = runDoctor({ strict });
      process.stdout.write(`${report.lines.join('\n')}\n`);
      return report.ok ? 0 : 1;
    }
    case 'reindex':
      return runReindex(rest).then(emit);
    case 'index':
      return emit(runIndexCommand(rest));
    case 'audit':
      return emit(runAudit(rest));
    case 'scrub':
      return emit(runScrub(rest));
    case 'inbox':
      return emit(runInbox(rest));
    case 'journal':
      return emit(runJournal(rest));
    case 'import':
      return isConversationImportSource(rest[0]) ? runConversationImport(rest).then(emit) : emit(runImport(rest));
    case 'refs':
      return runRefs(rest).then(emit);
    case 'hook':
      return emit(runHook(rest));
    case 'init':
      return runInitCommand(rest);
    case 'mcp':
      return runMcp(rest);
    default:
      process.stderr.write(`ebrain: unknown command ${JSON.stringify(command)}\n${USAGE}\n`);
      return 2;
  }
}

const result = main(process.argv.slice(2));
if (typeof result === 'number') process.exitCode = result;
else {
  void result.then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
