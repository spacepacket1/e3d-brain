# e3d-brain privacy policy

e3d-brain is software that runs on your own computer. There is no e3d-brain service:
the author does not host your notes, receives no copy of them, and the software
contains no telemetry, analytics, crash reporting, or automatic update check.

## What it reads

- The **vault folder** you choose: your Markdown notes, which may contain personal
  information.
- Only if you run the matching import command: Claude Code transcripts, a Claude.ai or
  ChatGPT data export, books you add, or an agent's workspace files. Imports are
  scrubbed for secrets first (the scrubber is a heuristic, not a guarantee).

## What it stores, and where

- **In your vault:** proposals that Claude writes with `capture` go to `_inbox/` and
  stay there until you accept or reject them. Accepted notes are ordinary Markdown
  files you own.
- **In a private state folder** (by default `~/.e3d-brain/`, permissions 0700, never
  inside the vault): a search index (derived from your notes); an audit log with one
  line per call, without note text or query text; a record of which note ids each
  search returned; an undo store holding copies of notes before a change you accepted;
  and usage events you report. A query log exists only if you turn it on.

## What leaves your computer

**Nothing, by default.** The default configuration makes no network requests.

Two things can send data, and both need your own action:

- **Your AI client.** When Claude (or another MCP client) searches your notes, the text
  it retrieves becomes part of your conversation and is sent to that AI provider under
  the provider's own terms and privacy policy. e3d-brain does not control that.
- **Optional features you configure:** local embeddings or a local model on your own
  machine (loopback) never leave it. A cloud model for the optional `propose` and
  cognition jobs is used only if you list the provider's host in your config and pass an
  explicit per-run flag, and then it receives the note text for that run.

## Retention and deletion

Everything is a file you can delete. Delete the state folder to remove the index, audit
log, undo store and records (the index can be rebuilt from your notes). `ebrain audit
prune` removes old audit segments. Your notes stay in your vault until you remove them.
Nothing is retained anywhere else, because nothing is sent anywhere else.

## Children

e3d-brain is a general-purpose tool and is not directed at children.

## Contact and changes

Questions and bug reports: https://github.com/spacepacket1/e3d-brain/issues. Security
problems, privately: see `docs/SECURITY.md` ("Reporting a vulnerability"). Changes to
this policy are made in the repository and visible in its history.

This software was written by AI and has not had a human security audit; see
`docs/SECURITY.md` for the stated guarantees and the known gaps.
