# e3d-brain plugin

Gives Claude a local memory over your own folder of Markdown notes (an Obsidian
vault), and the habit of using it: before answering a question about your past
decisions, projects, or preferences, Claude searches your notes, cites what it
finds, prefers newer notes over ones they replaced, and says so plainly when your
notes do not cover the question. When you ask Claude to remember something, it
proposes a note into a review inbox; nothing becomes permanent memory until you
accept it, and every change can be undone.

## Install

The plugin starts the `ebrain` server on your computer, so install that first
(Node 22 or later):

```bash
npm install -g e3d-brain
```

Then add this repository as a marketplace and install the plugin, in Claude Code:

```
/plugin marketplace add spacepacket1/e3d-brain
/plugin install e3d-brain@e3d-brain
```

On first start the server creates a default config (your notes folder is
`~/Brain`, in inbox mode). To use another folder or run read-only, run
`ebrain setup --vault <folder> --mode read-only` before the first start, or set
`EBRAIN_VAULT` and `EBRAIN_MODE`.

## Use it

Just ask: "Which database does the orders service use?" or "What did we decide
about Friday deploys?" Claude searches your notes without being told to. To save
something: "Remember that we will revisit the database choice in Q4." That lands
in `_inbox/` as a proposal. Accept it from the CLI (`ebrain inbox accept <id>`) or
by moving the file in your notes app.

## How it starts

The plugin's `.mcp.json` runs `node ${CLAUDE_PLUGIN_ROOT}/launch.mjs`, a short file in this
plugin that starts the `ebrain` command from your global install as `ebrain mcp --auto`,
and prints how to install it if it is missing. It runs nothing else and downloads nothing.
The server is a separate, versioned npm package rather than a copy inside the plugin
because it uses a native SQLite build.

## Data

Everything stays on your computer. The server reads your vault, keeps a search
index and audit log under `~/.e3d-brain/`, and makes no network requests by
default; nothing is sent to Anthropic beyond what Claude itself reads from your
notes during a conversation you start. It is tested, but it has not had a human
security audit.

Source and documentation: https://github.com/spacepacket1/e3d-brain (MIT licence).
