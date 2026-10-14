# e3d-brain Setup

## Requirements

- Node.js >= 22 (see `.nvmrc`). macOS (arm64) or Linux (x64/arm64).
- Obsidian is optional; `ebrain` only reads and writes plain Markdown.

## Install

The only install procedure (I9):

```bash
npm ci --ignore-scripts
npm run build:native   # the single native-build step: npm rebuild better-sqlite3
npm run build
```

`npm run build:native` is needed only if `ebrain doctor` reports that
`better-sqlite3` failed to load (it ships prebuilt binaries for common
platforms).

Then run `node dist/src/cli/main.js` (or `ebrain` once linked or installed).

```bash
ebrain --version
ebrain doctor
```

## First-time setup (one person, end to end)

1. Install as above, then create your configuration, state dir, and vault
   folders with `ebrain init` (it prompts for missing values on a terminal;
   flags make it non-interactive):

   ```bash
   ebrain init --vault ~/Brain --principal chris
   # optional: --type human|agent  --mode inbox|journal|read-only
   #           --state-dir ~/.e3d-brain  --config ~/.e3d-brain/config.json
   ```

   `init` writes `config.json` (`0600`; it refuses to overwrite an existing
   one), creates the state dir (`0700`), creates the vault if missing plus
   `_inbox/`, `_raw/`, and `references/` (and `journal/<principal-id>/` in
   `journal` mode), and prints the MCP client snippets below with absolute
   paths filled in.
2. Check the setup: `ebrain doctor --strict` (see "Doctor" below).
3. Optionally build the index now with `ebrain reindex` (the MCP server also
   builds and refreshes it on demand).
4. Register the server with your MCP client (next section) and restart the
   client.

## Connecting Claude (MCP over stdio)

`ebrain mcp` runs the MCP server over stdio: stdout carries protocol frames
only, and logs go to stderr (they never contain note text, queries, or tool
arguments). Use **absolute paths** to the node binary and to the installed
entry script (`dist/src/cli/main.js`), so the client never resolves `node` or
`ebrain` through its own `PATH`. `ebrain init` prints both snippets with your
paths.

Claude Code:

```bash
claude mcp add --scope user e3d-brain -e EBRAIN_CONFIG=/Users/chris/.e3d-brain/config.json \
  -- /usr/local/bin/node /opt/e3d-brain/dist/src/cli/main.js mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "e3d-brain": {
      "command": "/usr/local/bin/node",
      "args": ["/opt/e3d-brain/dist/src/cli/main.js", "mcp"],
      "env": { "EBRAIN_CONFIG": "/Users/chris/.e3d-brain/config.json" }
    }
  }
}
```

**Warning:** `EBRAIN_CONFIG` and the server command can also be set by a
project-level `.mcp.json` checked into a repository. Mode and principal come
from whichever config the launching client names, so only approve project MCP
servers you wrote yourself; a hostile `.mcp.json` could point `ebrain` at a
different config (another vault, another mode) or run a different command.

To connect several brains (for example a private one and a read-only shared
playbook), add one server entry per instance, each with its own name and
config file.

## MCP tools

Read tools are available in every mode; `capture` and `list_inbox` exist only
in `inbox` mode, and `journal_append` and `journal_list` only in `journal`
mode (elsewhere they are unknown tools).
There is no MCP tool to accept, edit, move, delete, or overwrite anything in
any mode.

| Tool | Arguments |
|---|---|
| `search` | `query`, `limit?` (default 10, max 50), `tags?` (all must match), `folder?`, `status?` (one or many), `include_superseded?`, `include_archived?`, `as_of?`, `advanced?`, `max_chars?`, `format?` |
| `read_note` | `path`, `max_chars?`, `format?` |
| `list_notes` | `folder?`, `tag?`, `limit?` (default 50, max 200), `status?`, `include_superseded?`, `include_archived?`, `as_of?`, `max_chars?`, `format?` |
| `related` | `path`, `limit?` (default 10, max 50), `max_chars?`, `format?`: backlinks, outgoing links, notes sharing tags |
| `capture` (inbox mode) | `title`, `body`, `kind?` (`fact`, `decision`, `preference`, `idea` (default), `lesson`, `reference`), `sources?` (citations, at most 50): proposes a note in `_inbox/` (see Inbox) |
| `list_inbox` (inbox mode) | `limit?` (default 50, max 200), `max_chars?`, `format?`: proposals waiting for review, with citations |
| `journal_append` (journal mode) | `title`, `body`, `kind?` (`log` (default), `observation`, `lesson`, `decision`, `todo`), `sources?` (citations, at most 50), `untrusted_origin?` (needs a source): creates a new entry under `journal/<principal-id>/` (see Agents) |
| `journal_list` (journal mode) | `since?` (ISO date), `kind?`, `limit?` (default 20, max 200), `max_chars?`, `format?`: your own entries, newest first within each tier |

In `journal` mode `search` and `list_notes` also accept `include_expired?`
(journal entries past `expires` are hidden by default in every mode).

- Every call refreshes the index first, so notes added or edited in the vault
  are found without a manual `reindex`.
- A response is a JSON header line (`tool`, `recall_id`, `format`, `count`,
  `omitted`, ...) followed by one fenced block of reference data: JSON Lines
  (one result per line) for lists, or the metadata line, a blank line, and the
  note text for `read_note`. Each result carries `id`, `provisional`, `rev`,
  `status` (the note's status, `accepted` for a curated or reference note
  without one, `proposed` for an inbox note without one or claiming
  `accepted`), `kind`, `occurred`, `folder_class`, `path`, and `citation`
  (`note:<id>@<rev>[#heading]`); search results add `heading_path` and an
  `excerpt`. `recall_id` (a ULID) identifies the result set and appears in the
  audit line.
- Size: output never exceeds 10,000 characters, lowered by
  `limits.maxCharsPerCall` and again by `max_chars` (a larger `max_chars` is
  clamped). Lists include only whole results that fit; `omitted` counts the
  rest. `format: "compact"` returns citations and excerpts of at most 200
  characters.
- Visibility: notes with status `rejected`, `superseded`, or `archived`, and
  notes under `_archive/`, `journal/_archive/`, `_inbox/_rejected/`, and
  `_inbox/_applied/` are hidden by default. `include_superseded` and
  `include_archived` reveal superseded and archived notes; `status` restricts
  results to the listed statuses and reveals notes hidden because of a listed
  status. `as_of` (ISO date, default now) drops notes whose `valid_until` is
  before it or `valid_from` after it, and shows a superseded/archived note if
  its `superseded_at`/`archived_at` is later than `as_of`. Dates without a
  time zone are UTC; a bare `valid_until` date includes that whole day.
- Search is BM25 (SQLite FTS5). The query is plain words (all must match);
  FTS syntax in it is inert. `advanced: true` passes the query to FTS5
  unescaped (`OR`, `NOT`, `"phrases"`, `prefix*`); invalid syntax returns an
  `invalid` error.
- `path` arguments are vault-relative and checked by `safe-path`: absolute
  paths, `..`, hidden names, and symlinks that leave the vault are refused.

## Configuration

Default location: `~/.e3d-brain/config.json`. Override with the
`EBRAIN_CONFIG` environment variable (absolute path, or starting with `~/`).

The file must be owned by you and not group- or world-writable
(`chmod 600 ~/.e3d-brain/config.json`); otherwise loading fails. It may not be
a symlink into another directory.

```json
{
  "vaultPath": "/abs/path/to/vault",
  "stateDir": "~/.e3d-brain",
  "principal": { "id": "chris", "type": "human" },
  "mode": "inbox",
  "limits": { "maxCharsPerCall": 10000 },
  "network": { "allowedHosts": [] },
  "scrub": { "extraPatterns": [] },
  "embeddings": { "provider": "none" },
  "audit": { "maxSegmentMB": 50 }
}
```

Unknown keys at any level are errors, as are wrong types and `null` values.
Optional keys may be omitted to take their defaults.

| Key | Required | Default | Rules |
|---|---|---|---|
| `vaultPath` | yes | | absolute path, or starts with `~/` (only that prefix is expanded; no environment variables) |
| `stateDir` | no | `~/.e3d-brain` | same path rules; must not be inside the vault or contain it; created `0700` |
| `principal.id` | yes | | `^[a-z0-9][a-z0-9_-]{0,63}$` (used as a path segment) |
| `principal.type` | yes | | `human` or `agent` |
| `mode` | yes | | `inbox`, `journal`, or `read-only`; `journal` requires `principal.type: agent` |
| `limits.maxCharsPerCall` | no | `10000` | integer 1-10000; can only lower the built-in ceiling |
| `network.allowedHosts` | no | `[]` | lowercase hostnames (no scheme, port, or wildcard); empty means no network |
| `scrub.extraPatterns` | no | `[]` | literal strings (not regexes), case-sensitive, 4-256 characters each, at most 64, no line breaks; redacted as `extra-pattern` (see Scrubbing) |
| `embeddings.provider` | no | `none` | `none` (other providers are added in Phase 12) |
| `audit.maxSegmentMB` | no | `50` | number above 0, at most 4096; audit segment size before a new segment starts |
| `journal.ttlDays` | no | `90` | integer 1-36500; `expires` = `created` + this many days on new journal entries |
| `journal.maxEntryChars` | no | `4000` | integer 1-100000; longest `journal_append` body (longer is rejected, never truncated) |
| `journal.maxEntriesPerHour` | no | `60` | integer 1-100000; entries per rolling hour, counted from file names in the journal directory |
| `journal.maxTotalMB` | no | `100` | number above 0; total size of `journal/<principal-id>/` (stat sizes) |

Later phases add keys here in the same change that adds them to the schema.

## State directory

`stateDir` holds derived and private data (index, audit log). It is created
with mode `0700`; files the tool creates are `0600`. It is never synced
between machines and never placed inside the vault.

## Search index

`ebrain reindex` scans the vault and updates `<stateDir>/index.db` (SQLite,
WAL mode). It is incremental: unchanged files are recognized by content hash;
`ebrain reindex --full` rebuilds every row from scratch. The index is derived
data: deleting `index.db` (with its `-wal`/`-shm` files) and running
`ebrain reindex --full` reproduces it. Indexing never writes to the vault.

```bash
ebrain reindex          # incremental; prints counts, including malformed frontmatter
ebrain reindex --full   # rebuild from scratch
ebrain index dump       # canonical text dump of the index (for comparisons)
```

The MCP server and the writers refresh the index cheaply (by file stat) before
reads and after writes, so `reindex` is only needed after bulk changes or to
force full fidelity.

What gets indexed: every `*.md` file. Skipped: dot-directories and dot-files
(`.obsidian/`, `.git/`, `.trash/`, temp files), symlinks (never followed),
names the vault path rules refuse, and notes over 8 MiB. Malformed
frontmatter, invalid dates, unknown statuses, and wrongly typed fields are
counted in the `reindex` summary; the note body is still indexed. Paths that
differ only by case or Unicode normalization (one file on macOS, two on Linux)
are both indexed and reported by `ebrain doctor` as collisions.

Note identity: a note's `id` comes from its frontmatter; without one the index
derives a provisional id (`prov_…`) from the content hash and path. A
provisional id follows a rename or move only when the content is unchanged
and no other note has the same content; editing and moving in one step gives
a new id and reports the old one as missing. Provisional ids are not durable
across `reindex --full`, so give long-lived notes an explicit `id`. Each note
also has a `rev` (16 hex characters of a SHA-256 over the whole file, with
line endings and a leading BOM normalized). `ebrain doctor` refreshes an
existing index and reports duplicate explicit ids (an error: the later note in
path order gets a provisional id), missing identities, unknown statuses,
malformed frontmatter, and invalid dates. The index never writes ids into
notes.

**The state directory must be on a local filesystem**, not NFS, EFS, SMB, or
another network filesystem: several processes (the CLI and any number of MCP
servers) share `index.db` through SQLite WAL mode, which needs working shared
memory and POSIX locks.

## Inbox (the review gate)

Nothing a model proposes becomes curated memory until you accept it.

- `capture` (MCP, `inbox` mode only) writes a new file
  `_inbox/<yyyymmdd-hhmmss>-<slug>.md` (UTC time; mode `0600`) with
  frontmatter `schema: 1`, `id` (a ULID), `title`, `status: proposed`, `kind`,
  `created`, `origin: mcp`, `author` (your `principal.id`), `sources`, and
  `scrubVersion`. Title, body, and sources go through the scrubber first: for
  a `human` principal secrets are stored as `[REDACTED:<type>]`; for an
  `agent` principal a credential (private key, seed phrase, API key, ...)
  rejects the whole capture and nothing is stored. A source that would need
  redacting is refused. The slug comes from the title (lowercase ASCII
  letters, digits, and `-`, at most 60 characters), so a title can never
  name a path; a name already taken gets `-2`, `-3`, ... and no file is ever
  overwritten. The tool takes no path argument.
- Proposals are searchable but rank below curated notes (tier T2, see
  `docs/RANKING.md`), report `status: "proposed"` (a note inside `_inbox/` is a
  proposal even if it claims `accepted`), and result headers carry a `notice`
  that they are not established facts. `_inbox/_rejected/` and
  `_inbox/_applied/` are hidden from `list_inbox` and default search.
- Review from the command line (owner only; works in every mode):

  ```bash
  ebrain inbox list                         # id, created, kind, author, path, title
  ebrain inbox show <id>
  ebrain inbox accept <id> [--to <folder>] [--edit]
  ebrain inbox reject <id> [--reason "why"]
  ```

  `accept` writes the note to `<folder>/<slug>.md` (default `notes/`; the
  timestamp prefix is dropped; a taken name gets `-2`, ...) with
  `status: accepted` and `accepted: <timestamp>`, keeping its `id` and every
  other frontmatter key, then removes the inbox copy. `--to` must be a folder
  inside the vault and may not be (or be under) `_inbox/`, `journal/`,
  `_raw/`, `_archive/`, or a dot-directory, also after symlinks are resolved.
  `--edit` then opens the note in `$VISUAL` or `$EDITOR`, which must be a
  single program (absolute path or name, no arguments); it is started
  without a shell. `reject` moves the note to `_inbox/_rejected/` (kept, not
  deleted) with `status: rejected`, `rejected: <timestamp>`, and
  `rejected_reason`. A note without an `id` (one you dropped into `_inbox/`
  by hand) is addressed by the provisional id `inbox list` shows and gets a
  ULID when accepted or rejected.
- Accepting changes the note's `rev`, so citations pinned to the proposed
  revision become `stale`, by design. Accept and reject only rewrite notes
  the model proposed, so they keep no undo copy.
- Crash safety: the destination is written first, then the inbox copy is
  removed. If both exist after a crash, `ebrain doctor` reports the duplicate
  id until you re-run the same `ebrain inbox accept <id>` (or `reject`),
  which finishes by removing the inbox copy.
- Accepting by hand is fine too: move the file out of `_inbox/` in Obsidian
  and it is curated memory from the next index refresh, whatever its
  `status` says.
- `_inbox/` exists in every vault (`ebrain init` creates it; the inbox
  commands recreate it if missing). Owner-run CLI jobs may write proposals
  there in any mode; only the MCP tools are limited to `inbox` mode.

## Scrubbing

Text that enters the vault through this tool (captures, journal entries,
imports) passes through the scrubber (`src/scrub/`) before it is written
(I5). Each detected secret is replaced by `[REDACTED:<type>]`; the writer
stamps `scrubVersion` into the note's frontmatter. If scrubbing fails, the
write is aborted. Notes you type into the vault yourself are not scrubbed.

Detectors (the `<type>` names are what findings and the audit log report):

| Class | Types |
|---|---|
| Credentials | `private-key` (PEM/OpenSSH blocks, whole block), `openai-key`, `anthropic-key`, `aws-access-key`, `aws-secret-key` (next to AWS context), `github-token`, `slack-token`, `stripe-key`, `google-api-key`, `jwt`, `bearer-token`, `password-assignment` (`password`/`passwd`/`pwd`/`secret`/`token`/`api_key` followed by `=`, `:`, or "is" and a value), `url-credentials` (`user:pass@`), `hex-private-key` (64 hex within a short window of `private`, `secret`, `priv`, `seed`, `mnemonic`, or `key=` on the same line), `wif-key` (base58check-validated), `bip39-mnemonic` (12+ consecutive words from the bundled BIP39 English list) |
| PII | `credit-card` (Luhn and card-brand checked), `us-ssn`, `iban` (mod-97 checked), `bank-routing` / `bank-account` (only after "routing", "ABA", "account number", "acct #") |
| Heuristic | `high-entropy`: base64-like strings of length >= 32 with Shannon entropy >= 4.3 bits/char, or pure hex >= 32 chars at >= 3.3 bits/char |
| Yours | `extra-pattern`: the literals in `scrub.extraPatterns` |

Never flagged by the hex and entropy detectors: `0x` hex (transaction
hashes, addresses), 40-hex git SHAs, bare 64-hex hashes, ULIDs, UUIDs,
well-formed citations (`note:`, `thesis:`, `outcome:`, `commit:`, `ref:`,
`url:`), and checksummed Bitcoin addresses. A 64-hex string in key context is
a key even with an `0x` prefix.

**Agent principals (strict mode).** When `principal.type` is `agent`, a
credential-class detection rejects the whole write: nothing is stored, the
tool returns a `strict-scrub` error naming the detector types, and the audit
line records the first detector type as its `code`. PII, the entropy
heuristic, and `extra-pattern` still redact and continue.

**Tuning.** The entropy thresholds are `DEFAULT_ENTROPY_THRESHOLD` and
`DEFAULT_HEX_ENTROPY_THRESHOLD` in `src/scrub/detectors.ts` (library option
`entropyThreshold` / `hexEntropyThreshold`). Lower values catch more and flag
more identifiers; random 32+ character keys score about 4.5-5.0 and
slugs/paths about 3.5-4.1. Arbitrary user regexes are not supported:
JavaScript regexes cannot be interrupted, so a runaway pattern could hang the
server.

**Manual use.** `ebrain scrub <file|->` prints the scrubbed text on stdout and
finding counts (`type: count`, never the matched text) on stderr. `--strict`
applies the agent rules (rejection exits 3 and prints no text);
`--entropy-threshold <bits>` overrides the threshold. `scrub.extraPatterns`
from your config applies when a config file exists.

## Auditing

Every MCP `tools/call`, in every mode (`inbox`, `journal`, `read-only`),
appends exactly one JSON line to `<stateDir>/audit.jsonl`, including calls
that were rejected (limits, strict scrubbing), invalid (bad or unknown
arguments, unknown tools), or that failed. `initialize` and `tools/list` are
not logged. A line looks like:

```json
{"ts":"2026-10-14T18:00:00.000Z","principal":"chris","mode":"inbox","tool":"search",
 "args_summary":{"query":"[redacted]","limit":5},"bytes_returned":1834,"outcome":"ok",
 "result_count":2,"recall_id":"01J...","returned":[{"id":"01J...","rev":"0123456789abcdef"}]}
```

- `outcome` is `ok`, `rejected`, `invalid`, or `error`; non-`ok` lines carry
  `error: {type, code?}`, where `code` is the scrub detector or limit type.
  Error details shown to the client are not logged.
- `args_summary` holds paths, ids, and counts only. Numbers, booleans, and
  fixed enum values are kept; strings appear only for arguments a tool
  declares as a path or id and only when they have that shape; every other
  string (query text, note text, anything credential-shaped) is
  `"[redacted]"`; lists become `{count, items?}`. An unknown tool name is
  logged as `"(unknown)"`.
- `returned` lists the `{id, rev}` of returned notes, never their content.
  Lines are capped at 8 KiB; past the cap the list is cut and
  `returned_truncated: true` is set.
- `author` and `principal` are never tool arguments: they come from config,
  and a call passing either is rejected by schema (and audited).
- If the audit line cannot be written, the call returns an `internal` error
  instead of its result.

The file is opened append-only and created `0600`; the server never truncates
or rewrites it, and several MCP processes may append to it at once (each line
is one `write`). When the current segment reaches `audit.maxSegmentMB`, a new
segment starts (`audit.jsonl.1`, `.2`, ...; the decision is taken under
`<stateDir>/locks/audit.lock`) and earlier segments are left as they are.

```sh
ebrain audit tail [-n 20]                 # last N lines across all segments, oldest first
ebrain audit stats                        # segments, line counts, outcomes, tools, principals
ebrain audit prune --older-than <days>    # delete whole segments last written before <days> ago
```

`prune` deletes only whole segments, oldest first, and never the current one.

## Doctor

`ebrain doctor` reports platform, Node, FTS5, config, vault, state dir, index
health, and network status. `ebrain doctor --strict` additionally fails if:

- `network.allowedHosts` contains a non-loopback host (anything other than
  `localhost` and `127.x.x.x`);
- any file or directory under the state dir is group- or world-accessible;
- the vault contains a symlink that resolves outside the vault root
  (dangling or looping symlinks are warnings).

Run it after `ebrain init` and after changing the config.

## Agents

An autonomous agent gets its own brain in `journal` mode (`principal.type:
"agent"`). Each agent process launches its own `ebrain mcp` over stdio with
its own config file, vault, and state dir; two agents never share a journal.

What journal mode does:

- `journal_append` creates one new file per entry,
  `journal/<principal-id>/<yyyy>/<yyyymmdd-hhmmss>-<slug>.md`, mode `0600`,
  with frontmatter `id`, `schema: 1`, `author` (from the config, never from
  the call), `origin: mcp`, `created`, `kind`, `sources`, `untrusted_origin`,
  `status: journal`, `expires`, and `scrubVersion`. It never edits, appends
  to, or overwrites an entry; a second entry with the same title in the same
  second is rejected (`exists`). The index is refreshed after each append,
  so the entry is searchable at once.
- Scrubbing is strict: a private key, seed phrase, or API key in the title,
  body, or sources rejects the whole entry and stores nothing. Public
  addresses and `0x` transaction hashes are kept.
- Limits (rejected, never truncated; audited by code `entry-size`, `rate`,
  `total-size`, `duplicate`): `journal.maxEntryChars`,
  `journal.maxEntriesPerHour`, `journal.maxTotalMB`, and a duplicate check
  (same normalized body as one of your entries in the last 24 hours; the
  error names the existing entry). They are computed from the files in the
  journal directory under the lock `<stateDir>/locks/journal-<id>.lock`, so
  they hold with several server processes.
- Ranking: journal entries come after curated and inbox notes: a `lesson`
  citing `thesis:`, `outcome:`, `commit:`, or `note:` (T3), other lessons
  (T4), then other entries (T5). Results are labeled `agent-journal` and,
  where set, `untrusted_origin`. Entries are never promoted automatically;
  to make one curated, the owner copies it into the vault by hand.
- Expiry: entries past `expires` (default 90 days) are hidden from search,
  `list_notes`, and `journal_list`; `include_expired: true` shows them.
  `ebrain journal prune` (owner CLI) moves them to
  `journal/_archive/<principal-id>/<yyyy>/`; `--dry-run` only lists. It never
  deletes anything.

Importing an existing workspace:

```sh
ebrain import agent-workspace ~/agents/workspace --principal agent-1
```

imports `MEMORY.md` (kind `observation`), `memory/YYYY-MM-DD.md` (`log`,
`occurred` set to the date), `GOALS.md` (`todo`), and `SOUL.md`/`TOOLS.md`
if present (`reference`) into `journal/agent-1/imported/`. `--principal`
must equal the configured principal. The source is only read (never
modified); every file is scrubbed under strict rules and a file that trips a
detector is skipped whole and listed. Re-running is safe: file names carry
the content hash, so unchanged files are reported `unchanged`, and a changed
file is imported as a new entry beside the old one. Imported entries do not
expire.

Three brains for one agent (one MCP server entry each; each `EBRAIN_CONFIG`
points at its own config file and vault):

```json
{
  "mcpServers": {
    "journal":  { "command": "/usr/bin/node", "args": ["/opt/e3d-brain/dist/src/cli/main.js", "mcp"],
                  "env": { "EBRAIN_CONFIG": "/home/agent1/.e3d-brain/journal.json" } },
    "playbook": { "command": "/usr/bin/node", "args": ["/opt/e3d-brain/dist/src/cli/main.js", "mcp"],
                  "env": { "EBRAIN_CONFIG": "/home/agent1/.e3d-brain/playbook.json" } },
    "team":     { "command": "/usr/bin/node", "args": ["/opt/e3d-brain/dist/src/cli/main.js", "mcp"],
                  "env": { "EBRAIN_CONFIG": "/home/agent1/.e3d-brain/team.json" } }
  }
}
```

- `journal.json`: `"mode": "journal"`, `"principal": {"id": "agent-1",
  "type": "agent"}`, the agent's private vault, its own `stateDir`.
- `playbook.json`: `"mode": "read-only"`, a copy of the shared, curated
  playbook vault.
- `team.json`: `"mode": "inbox"`, the team brain; the agent can only propose
  notes there for a person to accept.

Use a different `stateDir` per config. For a heartbeat with a budget of about
1,000 tokens, set `limits.maxCharsPerCall` low, for example
`"limits": {"maxCharsPerCall": 3000}` (about 750 tokens per call), in each config and call tools with `"format": "compact"` (citations
plus 200-character excerpts) and a small `limit` (for example
`journal_list` with `limit: 5`).

Keep each agent's vault in git (commit on a schedule) so you can diff and
roll back what it recorded. The server never runs git.

## Several people, separate brains

Each person installs `ebrain` independently, with their own vault, config,
and state dir, on their own machine or OS user. There is no shared server and
no shared index: Chris's Claude talks to Chris's brain, Joel's to Joel's.

- Keep a vault in sync between your own machines with a tool of your choice:
  Obsidian Sync, git, or iCloud Drive.
- **Never sync the state dir** (`~/.e3d-brain`). The index database is SQLite
  in WAL mode; a sync tool copying `index.db`, `-wal`, and `-shm` files
  between machines corrupts it or mixes two machines' views, and the audit log
  is per machine. Each machine rebuilds its own index from its copy of the
  vault (`ebrain reindex`), which is cheap and deterministic.
- Sharing notes with someone else is done by them connecting a separate,
  `read-only` instance to a copy of the vault, not by sharing a server.

## Running on a Linux server

For agents and headless use (for example on AWS):

1. Build prerequisites for `npm run build:native`:
   `sudo apt-get install -y build-essential python3 make`.
2. Install Node.js >= 22, then in the checkout run
   `npm ci --ignore-scripts && npm run build:native && npm run build`.
3. Create a dedicated OS user (for example `sudo useradd --system --create-home ebrain`)
   and run everything as that user; the config file must be owned by it and
   `chmod 600`.
4. Put the state dir on a **local** filesystem (not NFS/EFS), mode `0700`
   (`ebrain init` creates it so).
5. Sync the vault with git (clone it into the user's home; pull/commit on a
   schedule). The server never runs git itself.
6. Obsidian is not installed on servers; `ebrain` only reads and writes
   plain Markdown.
7. Run `ebrain doctor --strict` as that user before wiring the agent's MCP
   client to `node /abs/path/dist/src/cli/main.js mcp`.

## Vault versioning

Keeping the vault in `git` is recommended for diffing and rolling back what an
agent recorded. `ebrain` never runs git itself.
