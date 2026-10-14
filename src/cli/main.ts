#!/usr/bin/env node
// `ebrain` CLI entry point.

import { runAudit } from './audit-commands.js';
import { runDoctor } from './doctor.js';
import { runIndexCommand, runReindex, type CommandResult } from './index-commands.js';
import { VERSION } from '../version.js';

const USAGE = `usage: ebrain <command>

commands:
  doctor            report platform, config, vault, state dir, and FTS5 status
  reindex [--full]  update the search index from the vault (--full: rebuild from scratch)
  index dump        print a canonical dump of the index contents
  audit tail [-n N] print the last N audit lines (all segments, oldest first)
  audit stats       summarize the audit log (segments, outcomes, tools)
  audit prune --older-than <days>
                    delete whole audit segments older than <days> (never the current one)
  --version         print the version
  --help            show this help

config: ~/.e3d-brain/config.json (override with EBRAIN_CONFIG)`;

function emit(r: CommandResult): number {
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.code;
}

export function main(argv: readonly string[]): number {
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
      if (rest.length > 0) {
        process.stderr.write(`ebrain doctor: unexpected argument ${JSON.stringify(rest[0])}\n`);
        return 2;
      }
      const report = runDoctor();
      process.stdout.write(`${report.lines.join('\n')}\n`);
      return report.ok ? 0 : 1;
    }
    case 'reindex':
      return emit(runReindex(rest));
    case 'index':
      return emit(runIndexCommand(rest));
    case 'audit':
      return emit(runAudit(rest));
    default:
      process.stderr.write(`ebrain: unknown command ${JSON.stringify(command)}\n${USAGE}\n`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
