// Starts the e3d-brain server for this plugin: runs the `ebrain` command that
// `npm install -g e3d-brain` puts on PATH, as `ebrain mcp --auto`. The server
// itself is not copied into the plugin: it needs a native SQLite build, and a
// separate install keeps the code you run the published, versioned package.
// stdout carries the MCP protocol, so this file only passes it through; every
// message of its own goes to stderr. It runs nothing else and fetches nothing.
import { spawn } from 'node:child_process';

const child = spawn('ebrain', ['mcp', '--auto'], { stdio: 'inherit', shell: false });

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    process.stderr.write(
      'e3d-brain: the `ebrain` command was not found. Install it once with `npm install -g e3d-brain` (Node 22 or later), then restart Claude.\n',
    );
    process.exit(127);
  }
  process.stderr.write(`e3d-brain: could not start ebrain (${err.code ?? err.message})\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
