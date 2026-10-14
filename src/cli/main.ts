#!/usr/bin/env node
// `ebrain` CLI entry point.

import { runDoctor } from './doctor.js';
import { VERSION } from '../version.js';

const USAGE = `usage: ebrain <command>

commands:
  doctor       report platform, config, vault, state dir, and FTS5 status
  --version    print the version
  --help       show this help

config: ~/.e3d-brain/config.json (override with EBRAIN_CONFIG)`;

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
    default:
      process.stderr.write(`ebrain: unknown command ${JSON.stringify(command)}\n${USAGE}\n`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
