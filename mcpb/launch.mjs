// Starts the e3d-brain MCP server for the .mcpb bundle. Claude Desktop passes
// the chosen vault folder and mode as environment variables; ebrain wants a
// config file, so write one under the home directory and then run `ebrain mcp`.
// stdout carries protocol frames only, so nothing here may print to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const vault = process.env.EBRAIN_VAULT;
const mode = process.env.EBRAIN_MODE || 'inbox';

if (!vault || !path.isAbsolute(vault)) {
  process.stderr.write('e3d-brain: choose a vault folder in the extension settings.\n');
  process.exit(2);
}
if (mode !== 'inbox' && mode !== 'read-only') {
  process.stderr.write(`e3d-brain: mode must be "inbox" or "read-only", got ${JSON.stringify(mode)}.\n`);
  process.exit(2);
}

const stateDir = path.join(os.homedir(), '.e3d-brain-desktop');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(stateDir, 0o700);
for (const dir of ['_inbox', '_raw', 'references']) fs.mkdirSync(path.join(vault, dir), { recursive: true });

const config = {
  vaultPath: vault,
  stateDir,
  principal: { id: 'claude-desktop', type: 'human' },
  mode,
};
const configFile = path.join(stateDir, 'config.json');
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(configFile, 0o600);

process.env.EBRAIN_CONFIG = configFile;
process.argv = [process.argv[0], 'ebrain', 'mcp'];
await import(pathToFileURL(path.join(here, 'node_modules', 'e3d-brain', 'dist', 'src', 'cli', 'main.js')).href);
