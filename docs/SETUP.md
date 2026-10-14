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
| `scrub.extraPatterns` | no | `[]` | non-empty strings (regular expressions, used by the scrubber in Phase 7) |
| `embeddings.provider` | no | `none` | `none` (other providers are added in Phase 12) |
| `audit.maxSegmentMB` | no | `50` | number above 0, at most 4096; audit segment size before a new segment starts |

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

## Vault versioning

Keeping the vault in `git` is recommended for diffing and rolling back what an
agent recorded. `ebrain` never runs git itself.
