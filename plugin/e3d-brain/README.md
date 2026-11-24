# e3d-brain plugin

Gives Claude a local memory over your own folder of Markdown notes (an Obsidian
vault), and the habit of using it: before answering a question about your past
decisions, projects, or preferences, Claude searches your notes, cites what it
finds, prefers newer notes over ones they replaced, and says so plainly when your
notes do not cover the question. When you ask Claude to remember something, it
proposes a note into a review inbox; nothing becomes permanent memory until you
accept it, and every change can be undone.

## Install

The plugin is a skill only: it does not start or bundle the server. The
`ebrain` server is a separate npm package that you install and register
yourself, once (Node 22 or later):

```bash
npm install -g e3d-brain
ebrain setup
```

`ebrain setup` creates a default config (your notes folder is `~/Brain`, in
inbox mode) and registers the server with the Claude clients it finds on your
computer, asking before it changes anything. To use another folder or run
read-only, pass `--vault <folder>` or `--mode read-only`. The
[setup guide](https://github.com/spacepacket1/e3d-brain/blob/main/docs/SETUP.md)
covers registering by hand.

Then add this repository as a marketplace and install the plugin, in Claude Code:

```
/plugin marketplace add spacepacket1/e3d-brain
/plugin install e3d-brain@e3d-brain
```

Restart Claude so it picks up the server.

## Use it

Just ask: "Which database does the orders service use?" or "What did we decide
about Friday deploys?" Claude searches your notes without being told to. To save
something: "Remember that we will revisit the database choice in Q4." That lands
in `_inbox/` as a proposal. Accept it from the CLI (`ebrain inbox accept <id>`) or
by moving the file in your notes app.

## What the plugin contains

One skill, `e3d-brain-memory`, and nothing that runs: no MCP server, no
scripts, no hooks. The skill tells Claude when to search your notes and how to
cite them. The tools it uses come from the `ebrain` server you registered
above; if that server is not connected, Claude says so instead of pretending
to have searched.

## Data

Everything stays on your computer. The plugin itself reads and sends nothing. The server reads your vault, keeps a search
index and audit log under `~/.e3d-brain/`, and makes no network requests by
default; nothing is sent to Anthropic beyond what Claude itself reads from your
notes during a conversation you start. It is tested, but it has not had a human
security audit.

Source and documentation: https://github.com/spacepacket1/e3d-brain (MIT licence).
