// Starts the e3d-brain MCP server for the .mcpb bundle. Claude Desktop passes
// the chosen vault folder and mode as environment variables; ebrain wants a
// config file, so write one under the home directory and then run `ebrain mcp`.
// stdout carries protocol frames only, so nothing here may print to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(os.homedir(), '.e3d-brain-desktop');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(stateDir, 0o700);

// Breadcrumbs go to stderr (Claude Desktop logs it) and to launch.log, because a
// process killed by the OS leaves nothing else behind. No note text or paths of
// notes are logged; only the runtime and how far startup got.
const logFile = path.join(stateDir, 'launch.log');
function crumb(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(`e3d-brain: ${message}\n`);
  try {
    fs.appendFileSync(logFile, line, { mode: 0o600 });
  } catch {
    // logging must never stop the server
  }
}

// A client that has already hung up must not turn a log line into a crash.
process.stderr.on('error', () => {});

crumb(`start node ${process.version} abi ${process.versions.modules} ${process.platform}/${process.arch}`);
process.on('exit', (code) => crumb(`exit code ${code}`));
process.on('uncaughtException', (err) => {
  crumb(`uncaught ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  crumb(`unhandled rejection ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

const vault = process.env.EBRAIN_VAULT;
const mode = process.env.EBRAIN_MODE || 'inbox';

if (!vault || !path.isAbsolute(vault)) {
  crumb('choose a vault folder in the extension settings.');
  process.exit(2);
}
if (mode !== 'inbox' && mode !== 'read-only') {
  crumb(`mode must be "inbox" or "read-only", got ${JSON.stringify(mode)}.`);
  process.exit(2);
}
crumb(`mode ${mode}; checking vault folder`);
try {
  fs.accessSync(vault, fs.constants.R_OK | fs.constants.W_OK);
  for (const dir of ['_inbox', '_raw', 'references']) fs.mkdirSync(path.join(vault, dir), { recursive: true });
} catch (err) {
  crumb(`cannot use the vault folder: ${err.code || err.message}. On macOS, allow Claude under Privacy & Security > Files and Folders.`);
  process.exit(2);
}

const config = {
  vaultPath: vault,
  stateDir,
  principal: { id: 'claude-desktop', type: 'human' },
  mode,
};
const configFile = path.join(stateDir, 'config.json');
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(configFile, 0o600);
crumb('config written; loading the server');

// Load SQLite first and alone, so a native-module failure is reported by name.
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(here, 'node_modules', 'e3d-brain', 'package.json'));
  const Database = req('better-sqlite3');
  new Database(':memory:').close();
  crumb('sqlite ok');
} catch (err) {
  crumb(`sqlite failed to load: ${err && err.message ? err.message : err}`);
  process.exit(3);
}

process.env.EBRAIN_CONFIG = configFile;
process.argv = [process.argv[0], 'ebrain', 'mcp'];
await import(pathToFileURL(path.join(here, 'node_modules', 'e3d-brain', 'dist', 'src', 'cli', 'main.js')).href);
