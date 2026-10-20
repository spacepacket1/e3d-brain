# Claude Desktop bundle (.mcpb)

`scripts/build-mcpb.sh` builds `dist-mcpb/e3d-brain.mcpb`, a one-click install for
Claude Desktop. It wraps the same `ebrain mcp` stdio server as the npm package.

```bash
npm ci --ignore-scripts && npm run build:native
bash scripts/build-mcpb.sh
```

Install it by double-clicking the file, or in Claude Desktop: **Settings >
Extensions > Advanced settings > Install Extension...**. Claude Desktop asks for
two settings:

| Setting | Meaning |
|---|---|
| Vault folder | The folder of Markdown notes to use as memory (required) |
| Mode | `inbox` (search, plus propose notes into `_inbox/` for review) or `read-only` |

The launcher (`mcpb/launch.mjs`) writes a private config under
`~/.e3d-brain-desktop/` (state dir `0700`, config `0600`), creates `_inbox/`,
`_raw/`, and `references/` in the vault if missing, and starts the server. Cognition
jobs and `review accept` stay in the CLI, as they do everywhere: no MCP tool can
accept a proposal.

## Caveats

- **Native SQLite.** better-sqlite3 ships Node-API builds for macOS (arm64, x64),
  Linux, and Windows inside the package, and Node-API binaries do not depend on the
  Node version. The bundle was run under Node 22 and Node 26. Claude Desktop's
  built-in Node was v24.22.0 on the machine that reported the first failure.
- **Spaces in paths.** Claude Desktop installs extensions under
  `~/Library/Application Support/...`. The launcher resolves its own folder with
  `fileURLToPath`; an earlier version used `URL.pathname`, which leaves `%20` in the
  path and failed to find `node_modules`.
- **Diagnostics.** The launcher appends the Node version, CPU, and each startup
  stage to `~/.e3d-brain-desktop/launch.log`. Read it first if the extension will
  not start.
- **Verified so far:** the extracted bundle, run from a folder with a space in its
  path, over stdio with the MCP SDK (8 tools in `inbox`, 6 in `read-only`, a search
  returned the expected cited note). Installed in the Claude Desktop app on
  an Apple-silicon MacBook (Desktop's built-in Node v24.22.0) and confirmed working.
  Only macOS arm64 has been exercised.
- Cowork (Claude's sandboxed agent mode) failed to start the server in the same log
  ("Couldn't start for Cowork and Code sessions"), so do not rely on it there.
