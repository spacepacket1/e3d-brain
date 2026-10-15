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
| `search` | `query`, `limit?` (default 10, max 50), `tags?` (all must match), `folder?`, `status?` (one or many), `include_superseded?`, `include_archived?`, `as_of?`, `advanced?`, `scope?` (`notes` (default), `raw`, `refs`, `all`; see Reference library), `max_chars?`, `format?` |
| `read_note` | `path`, `max_chars?`, `format?` |
| `list_notes` | `folder?`, `tag?`, `limit?` (default 50, max 200), `status?`, `include_superseded?`, `include_archived?`, `as_of?`, `max_chars?`, `format?` |
| `related` | `path`, `limit?` (default 10, max 50), `max_chars?`, `format?`: backlinks, outgoing links, notes sharing tags |
| `capture` (inbox mode) | `title`, `body`, `kind?` (`fact`, `decision`, `preference`, `idea` (default), `lesson`, `reference`), `sources?` (citations, at most 50): proposes a note in `_inbox/` (see Inbox) |
| `list_inbox` (inbox mode) | `limit?` (default 50, max 200), `max_chars?`, `format?`: proposals waiting for review, with citations |
| `read_ref_chunk` | `ref_id`, `chapter`, `ordinal` (the parts of a `ref:<ref_id>/<chapter>/<ordinal>` citation), `max_chars?`, `format?`: one passage of a reference book, with `prev`/`next` citations (see Reference library) |
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
| `embeddings.provider` | no | `none` | `none` (BM25 only, no network code runs) or `ollama` (see Optional embeddings) |
| `embeddings.model` | no | `nomic-embed-text` | non-empty, at most 200 characters; changing it re-embeds every chunk on the next `ebrain reindex` |
| `embeddings.baseUrl` | no | `http://127.0.0.1:11434` | `http(s)` URL without credentials, query, or fragment; a non-loopback host must be in `network.allowedHosts` or the config is rejected at load |
| `embeddings.store` | no | `blob` | `blob`: vectors as SQLite BLOBs with brute-force cosine (the only store; `sqlite-vec` is not a dependency) |
| `audit.maxSegmentMB` | no | `50` | number above 0, at most 4096; audit segment size before a new segment starts |
| `journal.ttlDays` | no | `90` | integer 1-36500; `expires` = `created` + this many days on new journal entries |
| `journal.maxEntryChars` | no | `4000` | integer 1-100000; longest `journal_append` body (longer is rejected, never truncated) |
| `journal.maxEntriesPerHour` | no | `60` | integer 1-100000; entries per rolling hour, counted from file names in the journal directory |
| `journal.maxTotalMB` | no | `100` | number above 0; total size of `journal/<principal-id>/` (stat sizes) |
| `refs.excerptChars` | no | `400` | integer 1-1000; longest excerpt per reference-book hit in `search` (compact format: at most 200) |
| `refs.maxHits` | no | `5` | integer 1-20; most reference-book hits per `search` call (also bounded by `limit`) |
| `hooks.briefFolders` | no | `[]` | up to 32 vault-relative folders (`notes/work`) or `#tag` names whose recent accepted notes go in the session brief; empty lists no notes |
| `hooks.focus` | no | `""` | up to 2000 characters of your own text placed in the session brief |
| `hooks.captureCheckpoints` | no | `false` | must be exactly `true` for `hook pre-compact` to write a checkpoint |
| `hooks.claudeProjectsDir` | no | `~/.claude/projects` | `pre-compact` reads a transcript only from a file under this directory |
| `llm.provider` | no | `none` | `none` (`ebrain propose` refuses; no network code runs), `openai-compatible` (a local model), or `anthropic` (see Candidate notes) |
| `llm.model` | for a provider | `""` | at most 200 characters; required unless the provider is `none` |
| `llm.baseUrl` | no | `http://127.0.0.1:11434/v1` (`anthropic`: `https://api.anthropic.com`) | same rules as `embeddings.baseUrl`: loopback, or a host in `network.allowedHosts` |
| `llm.apiKeyEnv` | no | `""` (`anthropic`: `ANTHROPIC_API_KEY`) | the **name** of an environment variable holding the API key (`[A-Z_][A-Z0-9_]*`); keys are never stored in the config, and an `apiKey` key is rejected as unknown |
| `llm.maxCallsPerRun` | no | `20` | integer 1-10000; a run stops cleanly when the next call would exceed it |
| `llm.maxInputCharsPerRun` | no | `200000` | integer 1000-100000000; characters sent per run (prompt plus archive text) |
| `llm.maxOutputTokens` | no | `2048` | integer 64-64000; completion size requested per call |
| `llm.timeoutMs` | no | `120000` | integer 1000-600000; per-call timeout |
| `recallLog.retentionDays` | no | `180` | integer 1-36500; `ebrain recalls prune` drops recall records older than this |
| `inbox.maxPendingProposals` | no | `50` | integer 1-10000; a cognition run stops creating proposals once this many typed proposals are open (`status: proposed`) in `_inbox/` |
| `cognition.supersede.minJaccard` | no | `0.5` | number above 0, at most 1; `supersede` pairs two notes of the same kind (`decision`, `preference`, `fact`) when their 3-word-shingle Jaccard similarity is at least this |
| `cognition.supersede.maxUnadjudicated` | no | `5` | integer 1-10000; without an LLM provider, at most this many `supersede` candidate pairs become `needs_review: unadjudicated` proposals per run |
| `cognition.consolidate.minJaccard` | no | `0.5` | number above 0, at most 1; `consolidate` treats two notes as near-duplicates when their 3-word-shingle Jaccard similarity is at least this |
| `cognition.consolidate.minCosine` | no | `0.95` | number above 0, at most 1; with embeddings on, notes whose mean stored chunk vectors have at least this cosine similarity are also near-duplicates |
| `cognition.consolidate.maxSummaries` | no | `5` | integer 1-10000; at most this many `summary` proposals per `consolidate` run |
| `cognition.maxProposalsPerRun` | no | `20` | integer 1-10000; most proposals one cognition run creates (`--max-proposals` overrides); LLM caps are `llm.maxCallsPerRun` and `llm.maxInputCharsPerRun` |
| `evidence.dir` | no | `<stateDir>/evidence` | absolute or `~/`; not inside the vault (or containing it) and not the state directory itself; `evidence import` writes here and every `*.jsonl` in it is loaded |
| `evidence.sources` | no | `[]` | up to 64 `.jsonl` files (absolute or `~/`, no `.`/`..` segments), outside the vault and the state directory; read-only, loaded before `evidence.dir` |
| `evidence.maxFileMB` | no | `64` | number above 0, at most 1024; larger evidence files are refused unread |
| `evidence.maxRecordBytes` | no | `8192` | integer 256-65536; longest record line, before and after scrubbing |

Later phases add keys here in the same change that adds them to the schema.

## Optional HTTP transport (loopback, off by default)

`ebrain mcp` speaks stdio. For an owner who wants to reach one instance through their own tunnel (for example
over a private network), `ebrain mcp --http [--host <loopback>] [--port <n>]` serves MCP over Streamable HTTP at
`http://127.0.0.1:8787/mcp`. It is stateless, accepts POST only, and every call goes through the same dispatcher
(mode, fencing, caps, audit) as stdio.

- **Loopback only.** `--host` must be `127.x.x.x`, `localhost`, or `::1`; `0.0.0.0` and any other host are refused
  before listening. Requests with a non-loopback `Host` or `Origin` header are refused.
- **Bearer token.** `ebrain token create --principal <id>` prints a token (`ebt_<id>.<32 random bytes, base64url>`)
  once. Only its SHA-256 is stored, in `<stateDir>/http-tokens.json` (0600); comparison is constant-time. The
  principal must equal the instance's configured principal, and a token only works against the state dir that holds
  its hash, so one agent's token cannot be used against another agent's instance. Running the command again
  rotates the token. Send it as `Authorization: Bearer <token>`.
- **Warning.** Tunneling is your responsibility. Exposing this port publicly is unsupported. There is no OAuth,
  no TLS, and no rate limiting here; hosted remote access is a separate, security-reviewed ticket.

## State directory

`stateDir` holds derived and private data (index, audit log, the recall record `recalls.jsonl`, the undo store `undo/`, the
`propose` candidate-id ledger, hashed HTTP tokens, the reference library `refs.db`, imported evidence files `evidence/` and their index `evidence.db`). It is created
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
notes; `ebrain ids assign` does, when you ask (next section).

## Assigning ids and undo

```bash
ebrain ids assign --dry-run            # list the notes that would get an id; writes nothing
ebrain ids assign [--folder notes]     # add a ULID id: (and schema: 1 if absent) to notes lacking an id
ebrain undo --list                     # undo operations, newest first
ebrain undo <operation-id>             # restore the files that operation changed
```

`ids assign` inserts `id: <ULID>` (and `schema: 1` when the note has no
`schema` key) at the top of the frontmatter, or a new frontmatter block when
there is none. No other byte changes: other keys, their order and comments,
line endings, a leading BOM, and the body are kept exactly; each edit is
checked by re-parsing before anything is written. Notes it skips (and lists):
malformed frontmatter, frontmatter that is not a block mapping, an `id` key
that is invalid or claimed by another note, and the raw archive (`_raw/`).
After the run, the index keeps each old provisional id as an alias of the new
id, so citations made with it still resolve (and report `stale`), until the
next `ebrain reindex --full` (best effort; cite assigned ids). `pinned: true`
is kept as written; nothing here acts on it.

Every owner command that rewrites, creates, or moves vault files (today
`ids assign` and `review accept`) is one **undo operation**: before
writing, the originals are saved under `<stateDir>/undo/<operation-id>/`
(`0600`, same relative paths) with a manifest of each file's raw SHA-256
before and after. `ebrain undo <operation-id>` restores every file byte for
byte, removes files the operation created, and moves moved files back. It
refuses, changing nothing, when any affected file was edited (or removed)
after the operation. The memory layer's `inbox accept/reject` do not use it.
**Undo is machine-local**: the undo store lives in the state directory, never
in the vault, so it is not in git or sync and another machine cannot undo your
operation. Only one apply/undo runs at a time (`<stateDir>/locks/apply.lock`);
an operation interrupted by a crash is rolled back by the next one.

## Recall record

Every read tool call (`search`, `read_note`, `list_notes`, `related`,
`list_inbox`, `journal_list`, `read_ref_chunk`) appends one line to
`<stateDir>/recalls.jsonl` (`0600`): `{recall_id, ts, principal, ids}`, where
`ids` is the `{id, rev}` of up to 500 returned notes in result order (never
note text or queries). The audit log is unchanged; later cognition jobs read
this file, not the audit `returned` list (which may be truncated). Old
records are dropped only when you run `ebrain recalls prune` (keeps
`recallLog.retentionDays`, default 180; `--older-than <days>` overrides).

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

## Cognition jobs and the review queue

Cognition jobs read the brain and write **typed proposals** to `_inbox/`;
nothing they produce changes curated memory until you accept it here. Jobs
start only from the owner CLI (no MCP tool starts, schedules, reviews,
accepts, or applies anything) and work in every instance mode.

```bash
ebrain cognition run <job> [--since <date>] [--max-proposals N] [--dry-run] [--reconsider]
ebrain cognition runs                  # run records, newest first
ebrain review list                     # open typed proposals: status, type, job, authentication, taint
ebrain review show <id>                # the proposal plus the exact change against current notes
ebrain review diff <id>                # only the change
ebrain review accept <id>              # apply it (revision-checked, atomic, undoable)
ebrain review edit <id>                # edit prose or new-note content in $VISUAL/$EDITOR
ebrain review reject <id> [--reason "why"]
ebrain review undo <id>                # restore what accept changed
ebrain review recover                  # finish or roll back an interrupted accept
```

Built-in jobs: `selftest` proposes demoting (`status: stale`) every curated
note tagged `#ebrain-selftest`, so you can try the whole flow; `supersede`
proposes marking older notes superseded by newer ones (see "The supersede
job" below); `consolidate` proposes merging near-duplicate notes and
summarizing clusters of related notes (see "The consolidate job" below).
Jobs only use notes with an assigned `id`; notes with only a provisional id
are skipped and counted, and the run tells you to run `ebrain ids assign`.

**Runs.** One run of a job at a time (lock `<stateDir>/locks/cognition-<job>.lock`;
a second run refuses to start). Each run writes
`<stateDir>/runs/<run-id>.json` (`0600`): job and version, prompt id and hash,
provider and model, budget settings, input note ids and revs (and a hash of
the list), counts by outcome, the stop reason, and every proposal's id, key,
and immutable-field digest. Records never hold note text, queries, prompts,
model output, or secrets; each LLM request is logged as SHA-256 hashes of its
input and output. A run stops cleanly (exit 0, a partial and well-formed
result, the reason recorded) at `--max-proposals` /
`cognition.maxProposalsPerRun`, at `inbox.maxPendingProposals` open
proposals, or when the LLM budget (`llm.maxCallsPerRun`,
`llm.maxInputCharsPerRun`) runs out. Proposals are created in each job's
documented deterministic priority order, never by model score. Model output
must match a strict schema; invalid items are dropped and counted. Prompts
are versioned files `src/cognition/prompts/<job>.v<N>.md`, never edited in
place. `--dry-run` writes nothing to the vault (the run record notes it).

**Proposals.** A proposal is a note in `_inbox/` with `kind: proposal`,
`status: proposed`, `proposal_type` (`merge`, `supersede`, `summary`,
`archive`, `demote`, `lesson`, `gap`), `job`, `job_version`, `created`,
`author: ebrain-<job>`, `origin: cli`, `targets` (`{id, rev,
path_at_proposal}`), `evidence` (citations), `untrusted_origin`,
`taint_sources`, `confidence: unrated`, and `proposal_key` (a hash of the
job, the type, and the sorted evidence: the same finding always gets the same
key). Everything a job writes is scrubbed. A proposal touching or citing an
`untrusted_origin` note carries `untrusted_origin: true` and lists those
sources; `review show` and `review list` flag it. The body holds the
rationale, one fenced `ebrain-change` block, and a preview. The change block
is JSON, `{"version": 1, "ops": [...]}`, in a closed grammar:

| Op | Fields | Notes |
|---|---|---|
| `set_frontmatter` | `target`, `key`, `value` | `key` is one of `status` (`accepted`, `superseded`, `archived`, `stale`), `superseded_by`, `merged_into` (assigned ids), `supersedes` (list of ids), `superseded_at`, `valid_until`, `archived_at` (ISO dates); only that key's lines change |
| `create_note` | `path`, `content` | a new `.md` path (never `_inbox/`, `journal/`, `_raw/`, `_archive/`, or a dot-directory; a `lesson` only under `lessons/<principal-id>/`); refused if the file exists |
| `move_note` | `target`, `to` | only the archive path (`_archive/<path>`, or `journal/_archive/<principal-id>/...` for journal entries) or `lessons/<principal-id>/<name>.md`; a taken name gets `-2`, `-3`, ... |
| `append_section` | `target`, `text` | Markdown appended to the end of the note |

Every `target` must be listed in `targets`. Types allow: `demote`
set_frontmatter; `supersede` set_frontmatter, append_section; `archive`
set_frontmatter, move_note; `merge` all four; `summary` create_note,
set_frontmatter; `lesson` create_note, set_frontmatter, move_note,
append_section; `gap` nothing (a report). Anything else (unknown ops or
fields, an op its type does not allow, an unsafe path) makes the proposal
invalid. Paths are resolved through the same safe-path rules as everything
else. No op deletes a note.

**Accept** applies a proposal only if (1) a run record lists its id with the
same immutable-field digest (frontmatter such as `origin: cli` or
`author: ebrain-*` is never trusted on its own; `capture` and
`journal_append` cannot set those fields anyway), (2) every target still has
the pinned `rev` and every cited note revision is current (otherwise the
proposal is marked `stale` and refused: edit happened between preview and
accept; reject it and re-run the job), and (3) its status is `proposed`.
The change is then one undo operation (see "Assigning ids and undo"): the
originals are saved, each file's raw SHA-256 is re-checked immediately before
it is written, and only after the operation commits is the proposal marked
`status: accepted`, `applied: <timestamp>`, and moved to `_inbox/_applied/`.
A crash in between is finished by the next `accept` or `ebrain review
recover`. Line endings and a BOM are kept. **Undo** (`ebrain review undo <id>`)
restores the originals byte for byte and moves the proposal back to
`_inbox/` (`status: proposed`, `undone: <timestamp>`); it refuses, changing
nothing, if any affected file was edited since.

**Edit** opens a copy in your editor; the result must still be a valid
proposal with `status: proposed`. `targets`, `evidence`, `proposal_key`,
`proposal_type`, `job`, `id`, and every op except `create_note` content and
`append_section` text are immutable: an edit that changes them is refused
(reject and re-run instead). **Reject** moves the proposal to
`_inbox/_rejected/` and records its `proposal_key` in
`<stateDir>/rejections.json` (key, time, job, type, id; no reason text). Later
runs skip a rejected key unless you pass `--reconsider`. `ebrain inbox
accept/reject` keep working for ordinary notes; `review` only handles
`kind: proposal` notes from recorded runs.

### The supersede job

`ebrain cognition run supersede` asks "did a newer decision or fact replace
an older one?". Candidates are found without a model: pairs of curated,
accepted notes (no status or `status: accepted`, assigned ids) that share a
topic signal (a tag other than generic ones such as `#todo` and `#ebrain-*`,
carried by at most 25 notes; a wikilink in both directions; or the same
`kind` among `decision`, `preference`, `fact` with text overlap of at least
`cognition.supersede.minJaccard`) and have different dates (`occurred`, else
`created`; undated notes are skipped). The later note is the newer one. A
`pinned: true` note is never the superseded side. Pairs are proposed newest
first (newer note's date), then by path. With `--since`, only pairs whose
newer note is dated on or after it are considered.

With an LLM provider, the model classifies each pair (`supersedes`,
`conflicts`, `compatible`, `unrelated`) and quotes the conflicting sentence
from each note. Each quote must appear word for word in its note, or the
item is dropped and counted. `supersedes` yields a `supersede` proposal;
`conflicts` yields a `gap` report (no change) asking you to decide;
`compatible` and `unrelated` yield nothing. Without a provider, up to
`cognition.supersede.maxUnadjudicated` pairs per run become `supersede`
proposals marked `needs_review: unadjudicated` (flagged by `review show`),
quoting an excerpt of each note.

Accepting a `supersede` proposal sets, on the older note, `status:
superseded`, `superseded_by: <newer id>`, and `superseded_at` and
`valid_until` (both the newer note's date); on the newer note it adds the
older id to `supersedes`. Search then hides the older note by default, and
`as_of` a date before the newer note shows it again. `ebrain review undo`
restores both notes. Pairs already proposed (open or applied) or rejected
are skipped before any model call, so re-runs create nothing new; editing
either note changes its revision, so the pair can be proposed again.

### The consolidate job

`ebrain cognition run consolidate` asks "which notes are duplicates, or one
idea in pieces?". It considers curated notes and your own journal entries
(`journal/<your principal id>/`) that are effectively accepted and have an
assigned id. It skips `pinned: true` notes, `_raw/`, `_archive/`,
`references/`, journal entries of other principals, and existing
`kind: summary` notes.

**Merge.** Near-duplicates are found without embeddings or a model: each
note body is normalized (case, punctuation, Markdown, and HTML comments do
not matter) and cut into 3-word shingles; a minhash signature with fixed
seeds and LSH buckets finds candidate pairs, and a pair is a duplicate when
its exact shingle Jaccard is at least `cognition.consolidate.minJaccard`.
Exact copies, reworded notes, and notes with reordered sentences are found
this way. With embeddings on, notes whose stored chunk vectors (mean per
note) have cosine at least `cognition.consolidate.minCosine` are also
duplicates; the job reads only vectors already in the index and never calls
the embedding server. The proposal keeps the more complete note (more
distinct shingles; on a tie the earlier `occurred`/`created`, then the
smaller path), appends the other note's lines it does not already contain
under a `## Merged from <title>` section that cites `note:<id>@<rev>`, and
archives the other note (`status: archived`, `archived_at`, `merged_into:
<kept id>`, moved to `_archive/<path>`, or `journal/_archive/...` for a
journal entry). Nothing is deleted, and `ebrain review undo` restores both
notes byte for byte. A note joins at most one merge per run.

**Summary.** Three or more notes that share a tag (generic tags excluded, at
most 25 notes) or are connected by wikilinks form a cluster. The proposal
creates `summaries/<label>-<hash>.md` with `kind: summary` and
`derived_from: [note:<id>@<rev>, ...]`; every line cites its source note.
With an LLM provider, the model writes short claims, each with a quote that
must appear word for word in the cited source, or the claim is dropped and
counted (a cluster with no supported claim yields nothing). Without a
provider the summary is an extractive link list: a link to each note, its
first line verbatim, and its citation. A cluster already covered by a
summary note (same note ids in `derived_from`) is skipped, and at most
`cognition.consolidate.maxSummaries` summaries are proposed per run. A
summary of any `untrusted_origin` note is itself marked untrusted, and so is
its proposal.

Proposals are ordered merges first (highest overlap, then path), then
summaries (largest cluster, then path). With `--since`, only pairs and
clusters with a note dated on or after it are considered. Re-runs create
nothing new; rejected proposals are not re-proposed unless `--reconsider`.

## Evidence files (thesis and outcome records)

Jobs such as `reflect` learn from real outcomes. That evidence reaches the
brain only as **local JSONL files**: e3d-brain never contacts E3D services
(or anything else) to resolve it. Each line is one record:

```json
{"kind":"thesis","id":"th_123","occurred":"2026-09-01T00:00:00Z","summary":"short text","attributes":{"agent":"0x...","status":"closed"}}
{"kind":"outcome","id":"oc_456","occurred":"2026-09-20T00:00:00Z","summary":"short text","attributes":{"thesis":"th_123","result":"win","metric":"+4.2%"}}
```

| Field | Rule |
|---|---|
| `kind` | `[a-z][a-z0-9_]{0,31}`; `thesis` and `outcome` are citable (`thesis:<id>`, `outcome:<id>`) |
| `id` | the citation id grammar, `[A-Za-z0-9_]+`, at most 128 characters |
| `occurred` | ISO 8601 UTC with `Z` (`2026-09-01T00:00:00Z`, fractional seconds allowed); real calendar dates only |
| `summary` | non-empty, at most 1000 characters, no control characters |
| `attributes` | optional object; identifier keys; strings, numbers, booleans, null, arrays, objects; at most 256 values and two levels of nesting below `attributes` |

No other top-level keys are allowed. A line longer than
`evidence.maxRecordBytes` (default 8192) or nested deeper than allowed is
skipped **before** it is parsed; a line that fails any rule is skipped. Skipped
lines are counted by reason (`malformed`, `too large`, `too deep`,
`scrub rejected`), and the rest of the file still loads. `summary` and every
attribute string are scrubbed on load (agent brains use strict rules: a
credential drops the whole record); the stored record, after scrubbing, never
exceeds the per-record limit. When two records share a kind and id, the later
one wins (file order, then line order) and the replaced one is counted as a
duplicate.

**Where evidence is read from (and nothing else).** Two places:
`evidence.sources` (a list of `.jsonl` files outside the vault and the state
directory) and every `*.jsonl` directly inside `evidence.dir` (default
`<stateDir>/evidence`). Files are opened read-only, each inside its own
configured root: a symlink that leads outside that root, any symlink inside
`evidence.dir`, a dot-file, a non-regular file, or a file larger than
`evidence.maxFileMB` (default 64) is refused unread and listed by `evidence
stats`. Loading makes no network connection.

```bash
ebrain evidence import ~/Downloads/e3d-evidence.jsonl   # validate, scrub, write into evidence.dir (atomic)
ebrain evidence import export.jsonl --name agent-a.jsonl # pick the file name in evidence.dir
ebrain evidence stats                                    # per file: records, skipped lines by reason, duplicates
ebrain evidence reindex                                  # rebuild the index from the files
```

`evidence import` writes only the validated, scrubbed records (one canonical
JSON object per line) via a temp file and an atomic rename, replacing an
earlier import of the same name; a file with no valid record is refused and
nothing is written. Records are indexed into `<stateDir>/evidence.db`, derived
data like `index.db`: it is rebuilt automatically whenever a file, a limit, or
the scrub settings change, and can be deleted at any time.

**Citation resolution.** Jobs and `review` resolve each citation to
`resolved`, `unresolved` (well-formed but not found locally; `commit:` and
`url:` citations are never fetched), `stale` (a note citation whose note has a
newer revision), or `malformed`. A status is computed per run and cached only
for that run; it is never written back as a fact. `review accept` refuses
(without marking the proposal stale) while a cited `thesis:`/`outcome:` record
is not in the local evidence.

**Exporting from E3D.** The exporter lives in the E3D repositories, not here;
`scripts/export-e3d-evidence.md` describes the fields it must produce. Run it
on a machine that holds the data, copy the file over, and `ebrain evidence
import` it (or list its path in `evidence.sources` and re-export in place).

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

## Importing conversations (raw archive)

Owner CLI commands (never MCP) that copy past conversations into the vault's
**raw archive**:

```bash
ebrain import claude-code [--projects-dir <dir>] [--dry-run]   # default ~/.claude/projects/**/*.jsonl
ebrain import claude-export <file.zip|dir> [--dry-run]         # Claude.ai data export
ebrain import chatgpt-export <file.zip|dir> [--dry-run]        # ChatGPT data export
```

- Only real human and assistant text is kept: meta frames, slash-command
  wrappers, tool calls and results, thinking/reasoning blocks, subagent
  sidechains, and hidden/system messages are dropped. Unknown fields are
  ignored; malformed JSONL lines and malformed records are skipped and
  counted in the summary.
- Each conversation becomes one file,
  `_raw/conversations/<source>/<yyyy>/<id>.md`, with frontmatter `schema`,
  `id`, `title`, `kind: raw`, `source`, `conversation_id`, `started`,
  `ended`, `occurred` (= `started`), `turns`, `origin: import`, `author`,
  `created`, and `scrubVersion`. The `id` (`raw_<hash>`) is derived from the
  source and the conversation id, so re-imports keep identity.
- Idempotent: re-running an import leaves unchanged conversations
  byte-identical; a conversation that grew replaces its file atomically.
- Scrubbing is mandatory (there is no flag to turn it off). The summary
  prints the conversation, turn, and scrub-finding counts by type;
  `--dry-run` prints the same counts and writes nothing.
- Zip exports are read in memory, never extracted to disk. Archives with
  unsafe entry names (`../`, absolute, backslashes), more than 50,000
  entries, or oversized entries are rejected whole.
- Requires a `human` principal; an agent's own history goes through
  `ebrain import agent-workspace` (see Agents).
- Raw notes are indexed and searchable, but rank in tier T6 below curated,
  inbox, and journal notes and are labeled `raw-archive`: they record what
  was said, not established facts.

**Warning:** the raw archive holds full (scrubbed) conversations inside the
vault. If the vault is synced (iCloud, Dropbox, Syncthing) or kept in git,
so are your conversations. Exclude `_raw/` from sync or git if that is not
what you want; the scrubber is heuristic and can miss secrets.

## Reference library (books)

Owner CLI commands (never MCP) that add books you choose to a searchable,
citable library:

```bash
ebrain refs add <file.epub|.md|.txt|.pdf> [--title <title>] [--author <author>]
ebrain refs list
ebrain refs remove <ref_id>      # removes the index rows; your references/ note stays
ebrain refs reindex              # rebuild refs.db from the original source files
```

- **Book text is never stored in the vault.** It goes only to
  `<stateDir>/refs.db` (a separate derived database, `0600`), table
  `refs_chunks` keyed by `(ref_id, chapter, ordinal)`, together with the
  title, author, chapter headings, and the source file's absolute path and
  SHA-256. `ebrain reindex` (the note index) never touches `refs.db`.
- The vault gets one small note per book, `references/<slug>.md`: title,
  `book_author`, `source_path`, `source_sha256`, `ref_id`, and a "My notes"
  section for your own notes. It is created once and never overwritten (a
  different book whose title gives the same slug gets `<slug>-<id8>.md`).
- `ref_id` is `ref_` plus the first 32 hex characters of the file's SHA-256:
  the same file always gets the same id, and re-adding it (from any path) is
  a no-op.
- Formats: EPUB (chapters follow the spine; chapter titles from the
  navigation document or the chapter's headings; scripts, styles, and
  external resources are ignored and nothing is fetched), Markdown (chapters
  at the shallowest repeated heading level), plain text (chapters at lines
  like `CHAPTER IV.`), and PDF through the optional external `pdftotext`
  binary (poppler-utils, found on `PATH`; 60-second timeout, 64 MiB output
  cap). Without `pdftotext`, PDFs are refused with a message.
- EPUBs are read in memory with the same zip limits as conversation exports
  (unsafe entry names, more than 50,000 entries, or oversized entries reject
  the whole file).
- All book text (title, author, headings, paragraphs) is scrubbed (redacted,
  never rejected) before it is stored; `refs add` prints the finding counts.
- Over MCP, `search` with `scope: "refs"` returns at most `refs.maxHits`
  passages (default 5) with excerpts of at most `refs.excerptChars`
  characters (default 400), each with a `label` (`Title, Chapter N
  (heading)`) and a `citation` (`ref:<ref_id>/<chapter>/<ordinal>`).
  `scope: "all"` lists notes first, then books; `scope: "raw"` searches only
  the raw conversation archive; the default `scope: "notes"` searches vault
  notes (raw archive included, ranked T6). `read_ref_chunk` returns one
  passage (about 1,200 characters) per call, fenced and capped like any note.
- `refs reindex` rebuilds every book from its source file. Sources come from
  `refs.db` and from the `references/` notes, so deleting `refs.db` and
  running `refs reindex` restores it. A source that moved is reported
  `missing` and one whose content changed is reported `changed` (its rows are
  kept); the command then exits 1. Books removed with `refs remove` are not
  brought back while `refs.db` remembers the removal.

## Claude Code hooks

```
ebrain hook install     # add the SessionStart and PreCompact hooks to ~/.claude/settings.json
ebrain hook remove      # remove only the entries ebrain added
```

- `ebrain hook session-start` prints a **brief** into the session: recent
  accepted notes from `hooks.briefFolders` (newest first, titles and
  citations only), the number of proposals waiting in `_inbox/`, and your
  `hooks.focus` text. It is read-only, works in every mode, is fenced as
  reference data, and is capped at 10,000 characters (or `limits.maxCharsPerCall`
  if lower).
- `ebrain hook pre-compact` runs before Claude Code compacts a session. Only
  when `mode` is `inbox` **and** `hooks.captureCheckpoints` is `true` it reads
  the transcript named in the hook JSON (only if it is a file under
  `hooks.claudeProjectsDir`), takes the opening request and the last five user
  turns, scrubs them, and writes one proposal to `_inbox/` (`origin: hook`,
  `kind: raw`, `untrusted_origin: true`). Extractive: no model is called. Review
  it with `ebrain inbox`.
- Both hooks always exit 0 and print nothing on bad input, so they cannot break
  a session.
- Hook settings come only from the user-level `config.json`. A project's
  `.claude/settings.json` (or any file in the working directory) cannot change
  them.
- `install` writes `<absolute node binary> <absolute path to dist/src/cli/main.js>
  hook <event> --ebrain-managed`; the trailing flag marks entries ebrain owns.
  Nothing depends on `PATH`. Re-run `install` after moving the checkout or
  upgrading node. Your own hooks and every other setting are left as they are.

## Candidate notes (propose)

`ebrain propose [--since <date>] [--source <source|archive-id>]` reads the raw
archive (`_raw/conversations/`, see Importing conversations) and writes
**candidate notes to `_inbox/` only**: decisions, preferences, lessons, and
ideas a model found stated in a conversation. Nothing else in the vault
changes. Review them like any proposal (`ebrain inbox list|show|accept|reject`).

Off by default. With `llm.provider: "none"` the command exits with a message
and touches no network code. It also refuses unless `mode` is `inbox` and the
principal is `human`. For a local model (Ollama shown; llama.cpp's server
works the same way):

```json
"llm": { "provider": "openai-compatible", "model": "llama3.1", "baseUrl": "http://127.0.0.1:11434/v1" }
```

- `--since <date>` keeps conversations that ended on or after the ISO date;
  `--source` takes `claude-code`, `claude-export`, `chatgpt-export`, or one
  archive note id (`raw_...`).
- Each candidate has `status: proposed`, `confidence: unrated` (the model
  assigns no scores), `origin: cli`, `author: ebrain-propose`,
  `candidate_id`, `extraction_prompt` (for example `propose.v1`),
  `extraction_model`, and in `sources` one citation to the archive turns it
  came from: `note:<archive-id>@<rev>#turns-<a>-<b>`. The body holds the
  statement and the supporting quote. Check the cited turns before accepting.
- The prompt tells the model to extract only explicitly stated claims, quote
  the supporting text, and never invent. Replies are validated against a
  strict schema; invalid items, and items whose quote is not found verbatim in
  the cited turns, are dropped and counted in the summary (`dropped: ...`).
  Unparseable replies are counted as malformed responses, never fatal.
- Idempotent: the candidate id is a hash of archive id, turn range, and the
  normalized statement. Ids already in `_inbox/` (including `_rejected/` and
  `_applied/`) or in `<stateDir>/propose-candidates.jsonl` (ids and paths
  only) are skipped, so re-running, accepting, rejecting, or deleting a
  candidate never brings it back. A different model or prompt may phrase a
  statement differently and so produce a new candidate.
- Budgets: `llm.maxCallsPerRun` and `llm.maxInputCharsPerRun` stop a run
  cleanly (`stopped: budget ...`). A provider error stops further calls, keeps
  the candidates already gathered, and exits 1.
- Only scrubbed text is sent: archive turns are scrubbed again (non-strict)
  before each request, so a secret pasted into an archive file by hand is
  still redacted. Model output is scrubbed before it is written.

**Cloud provider (`anthropic`).** Allowed only when `network.allowedHosts`
includes `api.anthropic.com` **and** you pass
`--i-understand-data-leaves-machine` on every run; without the flag the
command refuses before any request. The key is read from the environment
variable named by `llm.apiKeyEnv` (default `ANTHROPIC_API_KEY`):

```json
"network": { "allowedHosts": ["api.anthropic.com"] },
"llm": { "provider": "anthropic", "model": "claude-sonnet-5-5" }
```

```sh
ANTHROPIC_API_KEY=... ebrain propose --since 2026-10-01 --i-understand-data-leaves-machine
```

The scrubbed text of the selected conversations leaves your machine.

## Optional embeddings (hybrid search)

Off by default: with `embeddings.provider: "none"` everything works with BM25
only and no network code is touched. To add semantic matches, run a local
[Ollama](https://ollama.com) and set:

```json
"embeddings": { "provider": "ollama", "model": "nomic-embed-text" }
```

- `ebrain reindex` embeds only new or changed chunks and prints a line such as
  `embeddings (ollama, nomic-embed-text): embedded 12, unchanged 340, failed 0`.
  Vectors are stored in `index.db` (`chunk_vectors`) with the model, the
  dimensions, and a content hash. A chunk is re-embedded when its text changes;
  changing `embeddings.model` re-embeds all of them. Identical text elsewhere
  reuses its vector.
- A failing or unreachable server never fails the reindex: the summary counts
  `warnings` and `failed` chunks, and those chunks stay BM25-only until the
  next reindex.
- `search` embeds the query and fuses the BM25 and vector lists with
  Reciprocal Rank Fusion (see RANKING.md). Its header says
  `"embeddings":"hybrid"`, or `"unavailable"` when the server could not be
  reached (the results are then BM25 only). `advanced` queries and
  `scope: refs` are BM25 only. Vector candidates need a cosine similarity of at
  least 0.3. Chunks without a vector (not yet reindexed) are found by BM25
  only; the MCP server never embeds chunks, only the query.
- Only scrubbed text is sent: each chunk and the query pass through the
  scrubber (non-strict) first. The host must be loopback or listed in
  `network.allowedHosts`. Remote hosts are an owner decision: the scrubbed
  chunk text of your vault leaves the machine.

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
agent recorded. `ebrain` never runs git itself. Imported conversations live
in `_raw/` inside the vault, so a vault in git (or any sync tool) carries
them too; add `_raw/` to `.gitignore` if you do not want that.
