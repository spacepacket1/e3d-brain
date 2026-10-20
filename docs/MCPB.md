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

- **Platform-specific.** The bundle carries the native SQLite build for the machine
  that built it. A bundle built on Apple silicon will not run on an Intel Mac or
  Windows. Build one per platform.
- **Node version.** The bundle declares Node 22 or later. If the Node that Claude
  Desktop launches is older, or has a different native ABI than the one that built
  the bundle, the server will fail to start.
- **Verified so far:** the extracted bundle was driven over stdio with the MCP SDK
  (8 tools in `inbox`, 6 in `read-only`, a search returned the expected cited note,
  bad settings exit with a message). **Not yet verified:** installing it into the
  Claude Desktop app itself.
- Cowork (Claude's sandboxed agent mode) may not reach local stdio servers at all.
