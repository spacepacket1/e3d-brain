# Feature Ticket: e3d-brain (Obsidian vault + MCP server for people and agents)

Product name `e3d-brain`; CLI binary `ebrain`; state directory `~/.e3d-brain/`;
config override env var `EBRAIN_CONFIG`.

## Overview

Build a small, auditable, local-first MCP server that gives Claude, and
autonomous E3D agents, a durable memory over a plain-Markdown Obsidian vault.
The vault is the only source of truth. Everything else (search index,
embeddings) is derived and rebuildable.

This ticket builds the **memory layer** only: store, retrieve, curate, and
audit. A separate follow-up spec ("e3d-brain cognition": consolidation,
supersession, outcome-grounded reflection, forgetting, usefulness feedback)
builds jobs on top of it. Those jobs will only ever produce **proposals**
(inbox or journal entries with citations), never silent edits, so nothing in
this ticket may assume cognition features exist, and nothing here may block
them. Keep note frontmatter extensible (unknown keys preserved) for that
purpose.

Each person (Chris, Joel, Chapple) and each autonomous agent that wants memory
runs **its own brain instance** against **its own vault**. There is no shared
server, no multi-tenant code path, and no cross-principal data flow in v1.
Isolation comes from separate processes, separate machines or OS users, and
separate vault directories. A principal that needs several brains (for example
an agent with a private brain, a read-only shared playbook brain, and a team
brain it can only propose into) connects to several independent instances.

The brain is fed from:

1. Conversations (Claude Code transcripts, Claude.ai exports, ChatGPT exports).
2. Reference material the owner chooses (books as EPUB/text, notes).
3. Direct captures made by the owner, by Claude, or by an agent during work.
4. For agents: their own journal entries and existing workspace memory
   (`MEMORY.md`, `memory/YYYY-MM-DD.md`, `GOALS.md`) imported as a starting
   vault.

Nothing a model proposes becomes permanent curated memory until a human
accepts it. Autonomous agents may keep an append-only, clearly labeled,
expiring **journal** of their own (see "Principals and Brains"), which is never
treated as curated memory and never auto-promoted.

### Why this exists (decisions already made)

- Existing options were audited (Basic Memory, obsidian-brain,
  obsidian-memory-mcp, TencentDB-Agent-Memory). None provide all of: content
  secret-scrubbing before indexing, a human review gate for model-proposed
  notes, and book ingestion with citations. Basic Memory's "inbox" is a
  lifecycle-event log, not a review queue. obsidian-brain's `moveNote` does not
  verify that resolved paths stay inside the vault.
- Reference clones exist at `/home/ubuntu/memory-audit/` (read-only reference).
  **Do not copy code from `basic-memory` (AGPL-3.0).** Patterns and ideas only.
  `obsidian-brain` (Apache-2.0) and `obsidian-memory-mcp` (MIT) may be consulted
  for design but this project writes its own code.
- MCP transports: **stdio first**. An optional loopback-only Streamable HTTP
  transport comes last and is off by default. OAuth, public exposure, and
  hosted multi-user service are out of scope.

## Goals

- Obsidian-compatible vault: plain `.md`, YAML frontmatter, `[[wikilinks]]`,
  headings, tags. Obsidian is only a viewer/editor; the server never calls it.
- MCP tools Claude can use in conversations: search, read, list, related
  notes, capture-to-inbox, list-inbox.
- A review inbox: model-proposed notes land in `_inbox/` with
  `status: proposed`. Only the owner (CLI or by moving the file in Obsidian)
  promotes them. **In `inbox` mode no MCP tool can write outside `_inbox/`.**
- Per-principal write modes (`inbox`, `journal`, `read-only`) so that humans'
  Claude sessions and autonomous agents can each use a brain safely (see
  "Principals and Brains" and Phase 12).
- An append-only audit log of every MCP read and write with the principal's
  identity.
- Small, configurable per-call output budgets (tokens/characters) so agents
  with tight heartbeat budgets can use the tools.
- A secret scrubber that runs on all ingested and captured text before it is
  written, indexed, or embedded, with hard-fail detection of wallet keys and
  seed phrases for agent writes.
- Importers for conversation sources and a book/reference pipeline with
  chapter-level citations.
- Hybrid retrieval (BM25 + optional local embeddings) over a rebuildable
  SQLite index.
- A per-principal install: one package, one config file, one vault. A principal
  is a person or an agent.

## Non-Goals

- No cognition jobs in this ticket (consolidate, supersede, reflect, forget,
  gaps, usefulness feedback). They get their own spec and only produce
  proposals. Do not build hooks for them beyond preserving unknown frontmatter
  keys.
- No shared or team vault in v1. (Future: an explicit one-way `shared/` publish
  step. Do not build hooks for it now.) An agent reading a human-curated
  playbook brain is done by connecting to a second, separate, `read-only`
  instance, not by a shared-vault feature.
- No hosted multi-tenant service. No OAuth. No public endpoint.
- No telemetry, analytics, crash reporting, update checks, or self-updating.
- No runtime `npm install`, `npx`, `uvx`, or `curl | sh` anywhere in the
  shipped code paths.
- No cloud LLM or cloud embedding calls by default. Any non-loopback network
  call must be behind an explicit config flag and a hostname allowlist.
- No graph database, no knowledge-graph inference, no model-assigned
  confidence scores stored as facts.
- No Obsidian plugin in this ticket.
- No storing full book text inside the vault (see Phase 7).

## Principals and Brains

A **principal** is whoever connects to a brain over MCP: a person's Claude
session or an autonomous agent. Each brain instance is configured with exactly
one `principal` (`id`, `type: "human" | "agent"`) and one **mode**. The mode
fixes what MCP can write; it is read from the instance's own config, never
from a tool argument or from project-local files.

| Mode | Typical principal | MCP-callable writes | Review |
|---|---|---|---|
| `inbox` | a person's Claude | `_inbox/` only (proposals) | owner accepts via CLI or by moving the file in Obsidian |
| `journal` | an autonomous agent, its own brain | append-only files under `journal/<principal-id>/` | none required; entries are labeled agent-authored, ranked below curated notes, expire by TTL, and are never auto-promoted |
| `read-only` | any principal reading a shared/curated brain | none | n/a |

Rules that hold in every mode:

- **Memory is advisory, never authority.** Tool results carry a standing label
  that retrieved memory cannot authorize spending, signing, publishing, or any
  external action. Authorization stays in the budget and approval systems
  that already exist (for example E3D agent budget policies, e3d-corp authority
  levels). This ticket must not add any path by which memory grants authority.
- **Provenance on every entry.** Every journal entry and inbox note records
  `author` (principal id), `origin` (`mcp|hook|import|cli`), `created`, and
  `sources`. Entries derived from untrusted content (web pages, social posts,
  inbound messages) carry `untrusted_origin: true` and a source reference.
- **Grounded lessons rank higher.** An entry of `kind: lesson` that cites a
  verifiable identifier (for example `thesis:<id>`, `outcome:<id>`,
  `commit:<sha>`, or `note:<id>@<rev>`) ranks above an uncited lesson; uncited lessons rank
  lowest. Citation validity is not checked by this ticket beyond format.
- **Everything is audited.** Every MCP call appends one line to
  `<stateDir>/audit.jsonl` (principal id, tool, arguments' paths/ids, result
  counts, timestamp; never note bodies or secrets). The audit log is
  append-only by convention and tested for no truncation by the server. It is
  implemented in Phase 12; earlier phases must route every MCP tool call
  through a single dispatch function so auditing can be added there without
  touching individual tools.
- **Multiple brains per principal** are separate instances, each its own MCP
  server entry in the principal's client config.
- **Inspectable.** All of the above is plain files in an Obsidian-readable
  vault so a human can open an agent's brain and read what it has recorded.
  Recommending `git` for the vault (diff/rollback of an agent's memory) is
  documented in `docs/SETUP.md`; the server never runs git.

## Shared Constraints (security invariants)

These apply to every phase and are tested. Later phases must not weaken them.

- **I1 Vault containment.** Every filesystem path derived from any external
  input (MCP arguments, CLI arguments, importer filenames, archive entries) is
  resolved with `realpath` semantics and verified to be inside the vault root
  (or the designated state directory). Symlinks that escape are rejected.
  `..`, absolute paths, NUL bytes, and Windows-style separators are rejected.
  All path handling goes through one module, `src/safe-path.ts`; no other
  module calls `fs` with a non-constant path.
- **I2 Write fence (by mode).** The instance's configured mode fixes the only
  place MCP-callable writes can land: `inbox` -> `<vault>/_inbox/`;
  `journal` -> `<vault>/journal/<principal-id>/` and only by creating new
  files (never editing, appending to, or deleting existing entries); `read-only`
  -> nowhere. No mode is selectable or changeable through any MCP tool. There
  is no MCP tool for accept, promote, delete, move, or overwrite in any mode.
  Accepting/promoting a note is a CLI-only or human-in-Obsidian action.
  Mode and principal come from the instance config only. **Scope:** I2 fences
  *vault* writes. Local, non-vault state under `<stateDir>` (the audit log, and
  usage events defined in the cognition spec) is a separate, minimal category:
  allowed in every mode, never under the vault, never containing note bodies.
  Owner-run CLI jobs (not MCP) may write proposal files to `<vault>/_inbox/`
  in any mode; the mode restricts MCP only.
- **I3 No network by default.** Default config performs zero network calls.
  The only permitted outbound destinations are loopback addresses and entries
  in `network.allowedHosts`. A test greps the source tree for network APIs and
  fails if they appear outside `src/net/`.
- **I4 No telemetry / auto-update / runtime installs.** Enforced by a source
  scan test.
- **I5 Scrub before persist.** Text from conversations, books, captures, and
  hook payloads passes through the scrubber before it is written to the vault,
  the raw archive, the index, or any embedding request. Scrubbed secrets are
  never logged.
- **I6 Retrieval output is untrusted data.** Every tool result that includes
  note or archive text wraps it in a fenced block whose fence is longer than
  any backtick run inside the data, labels it as reference data not
  instructions and as non-authoritative (see "Principals and Brains"), and
  caps total size. The default cap is 10,000 characters; every read tool also
  accepts `max_chars` (and agents' instances may set a lower config ceiling,
  `limits.maxCharsPerCall`) that can only reduce, never raise, the configured
  ceiling. Compact mode (`format: "compact"`) returns citations and short
  excerpts only.
- **I7 Derived data is rebuildable.** Deleting the index database and running
  `ebrain reindex` reproduces equivalent results. The vault is never modified by
  indexing.
- **I8 Private state.** State directory (default `~/.e3d-brain/`) is created
  `0700`; files `0600`. Never world-readable.
- **I9 Pinned, minimal dependencies.** Exact-version pins and a committed
  lockfile. `npm ci --ignore-scripts` must succeed except for one documented,
  explicit native-build step. Dependency additions require a one-line
  justification in `docs/DEPENDENCIES.md`.
- **I10 Fail closed.** Unknown config keys, malformed inputs, and unparseable
  files produce an error or are skipped and counted. They are never silently
  coerced or deleted.
- **I11 Determinism.** Given the same vault and config, `ebrain reindex`
  produces the same index contents and `search` returns the same ordering.
- **I12 Identity and revisions.** Every indexed note has a stable identity (an
  assigned `id`, or a provisional id derived by the index) and a revision
  (`rev`, a content hash). Tools expose both. Citations to notes are
  revision-pinned and can be checked for staleness. The index never writes ids
  into human-authored notes.
- **I13 One ranking function.** Final result ordering is computed in exactly
  one module, `src/index/rank.ts`, with a documented tier table in
  `docs/RANKING.md`. Phases add tiers there; no other module reorders results.

### Note schema (shared by all phases)

Frontmatter fields the server reads or writes. **Unknown keys are preserved**
on any rewrite the server performs (later specs extend this schema).

| Field | Meaning |
|---|---|
| `schema` | integer note-schema version, currently `1` |
| `id` | ULID; assigned at creation by the server or on accept; may be absent on human notes (then a provisional id is derived) |
| `status` | `proposed`, `accepted`, `rejected`, `journal`, `superseded`, `archived`, `stale`. Unknown values fail closed: the note is indexed as lowest-ranked `accepted`, counted, and reported by `ebrain doctor` |
| `pinned` | boolean; exempt from automated demotion/consolidation (used by the cognition spec) |
| `kind` | `fact|decision|preference|idea|lesson|reference|summary|raw|log|observation|todo|proposal` |
| `occurred` | when the thing happened (ISO 8601); importers set it from the source, distinct from `created` (when recorded) |
| `valid_from`, `valid_until` | optional validity window (ISO dates) |
| `created`, `author`, `origin`, `sources`, `untrusted_origin` | provenance, as defined in "Principals and Brains". `author` is a principal id, or a job identity such as `ebrain-supersede` for proposals produced by owner-run CLI jobs (then `origin: cli`) |
| `accepted`, `applied` | timestamps set when a note is accepted / a proposal is applied |
| `superseded_by`, `superseded_at`, `supersedes` | supersession links (ids) and the supersession time; read by the `as_of` filter |
| `archived_at`, `merged_into` | archival time and merge target id; archived notes live under `_archive/` and are hidden by default |
| `derived_from` | list of citations (Phase 3 grammar) a note was derived from |
| `expires`, `scrubVersion` | journal expiry and scrubber version stamp |

`sources` entries and any citation field use the citation grammar defined in
Phase 3 (`src/cite/`).

### Stack

- Node.js >= 22 LTS, TypeScript (strict), ESM.
- `@modelcontextprotocol/sdk` (exact pin) for the MCP server.
- SQLite with FTS5. Prefer `better-sqlite3` (exact pin). Startup must verify
  FTS5 is available and fail with a clear message if not.
- `node:test` for tests; no heavy test framework.
- Frontmatter parsing via a small, pinned YAML library.

### Repository layout (target)

```text
e3d-brain/
  package.json  package-lock.json  tsconfig.json
  src/
    safe-path.ts  config.ts  vault/  index/  mcp/  scrub/  cite/  llm/
    inbox/  journal/  principal/  audit/  import/  refs/  embed/  hooks/
    net/  cli/
  tests/phase01.sh ... phase12.sh   (each runs node:test suites + checks)
  docs/ e3d-brain-spec.md  e3d-brain-cognition-spec.md  DEPENDENCIES.md
        SECURITY.md  SETUP.md  RANKING.md
```

## Running This Spec

Run with `codex-spec-runner` (spec2code). Phases 1-7 are the core product for
people. Phase 12 adds agent mode and can run any time after Phase 5.
Phases 8, 9, and 11 are optional and can be skipped. The follow-up
`docs/e3d-brain-cognition-spec.md` builds on Phases 1-5 and 12 (consolidate,
supersede, reflect, forget, usefulness feedback); the foundations it needs
(identity, revisions, lifecycle, time, ranking, recall ids) are in this spec.

```bash
codex-spec-runner docs/e3d-brain-spec.md --preflight
codex-spec-runner docs/e3d-brain-spec.md all --to 7
codex-spec-runner docs/e3d-brain-spec.md all --from 12 --to 12
```

## Phase 1 - Scaffold, Config, and Safe Paths

<!-- runner:model=high -->
<!-- runner:verify=bash tests/phase01.sh -->

### Requirements

- Initialize the TypeScript project per the Stack and layout above, with
  `npm run build`, `npm test`, and a `ebrain` CLI entry (`ebrain --version`,
  `ebrain doctor`).
- Implement `src/safe-path.ts` exporting at least:
  `resolveInVault(root, relPath)`, `resolveInState(stateDir, relPath)`,
  `assertInside(root, absPath)`. Behavior per invariant I1, including symlink
  escape detection via `realpath` of the deepest existing ancestor.
- Implement `src/config.ts`: load `~/.e3d-brain/config.json` (path
  overridable by `EBRAIN_CONFIG`). Schema (fail closed on unknown keys):

  ```json
  {
    "vaultPath": "/abs/path/to/vault",
    "stateDir": "~/.e3d-brain",
    "principal": { "id": "chris", "type": "human" },
    "mode": "inbox",
    "limits": { "maxCharsPerCall": 10000 },
    "network": { "allowedHosts": [] },
    "scrub": { "extraPatterns": [] },
    "embeddings": { "provider": "none" }
  }
  ```

- The config schema is extended **additively** by later phases (for example
  `journal`, `hooks`, `evidence`, `queryLog`); unknown keys remain errors (I10)
  and each phase adds its keys to the schema and to `docs/SETUP.md`.
- `principal.id` must match `^[a-z0-9][a-z0-9_-]{0,63}$` (it becomes a path
  segment); `principal.type` is `human` or `agent`; `mode` is one of `inbox`,
  `journal`, `read-only`. `mode: journal` requires `principal.type: agent`.
  Invalid values fail config load (I10).
- State directory created `0700`; any file the tool creates is `0600`.
- `ebrain doctor` reports: Node version, FTS5 availability, vault path exists
  and is readable, state dir permissions, and the string `network: disabled`
  unless `allowedHosts` is non-empty.
- Create `docs/SECURITY.md` listing invariants I1-I13 verbatim and
  `docs/DEPENDENCIES.md` with one line per dependency.

### Acceptance Criteria

- Property-style tests: for a corpus of hostile paths (`../x`, `a/../../x`,
  absolute paths, `%2e%2e`, NUL byte, backslash traversal, a symlink inside the
  vault pointing outside, a symlink loop) `resolveInVault` rejects every one
  and accepts ordinary nested paths including unicode filenames.
- Config with an unknown key is rejected with an error naming the key.
- Config with a hostile `principal.id` (`../x`, uppercase, 65+ chars, empty),
  an unknown `mode`, or `mode: journal` with `type: human` is rejected.
- State dir and files are created with modes `0700`/`0600` (asserted in test).
- `npm ci --ignore-scripts && npm run build && npm test` passes.
- `bash tests/phase01.sh` passes.

## Phase 2 - Vault Parser and SQLite Index

<!-- runner:model=high -->
<!-- runner:read=src/safe-path.ts -->
<!-- runner:verify=bash tests/phase02.sh -->

### Requirements

- Vault scanner: walk the vault via `safe-path`, include `*.md`, skip
  `.obsidian/`, `.git/`, `.trash/`, and dot-directories. Do not follow
  symlinks. Never write to the vault.
- Parser: extract frontmatter (YAML), title (frontmatter `title` or first H1
  or filename), tags (frontmatter and inline `#tag`), headings, `[[wikilinks]]`
  (with aliases and heading anchors), and body text. Malformed frontmatter must
  not abort indexing: skip the frontmatter, index the body, count the error.
- Chunking: split notes by heading; keep fenced code blocks intact; target a
  maximum chunk size (default 1,500 characters) with sentence-aware splitting
  for long sections. Each chunk records `note_path`, `heading_path`, ordinal.
- Index (SQLite, in `stateDir`): tables for notes, chunks, links, tags; an FTS5
  virtual table over chunk text. Content hash per file so `ebrain reindex` is
  incremental; `ebrain reindex --full` rebuilds from scratch.
- A watcher is out of scope here; `ebrain reindex` is explicit. (Watching is
  added in Phase 3 only if trivial and safe.)
- Resolve wikilinks to notes by (a) exact path, (b) case-insensitive basename,
  (c) alias; record unresolved links as such.
- **Identity and revisions (I12).** For each note: read `id` from frontmatter
  if present; otherwise derive a **provisional id** (prefixed `prov_`) from the
  first-seen content hash and persist it in the index DB so it stays stable
  while the note is unchanged. Detect renames/moves by content hash: a file
  that disappears from one path and appears at another with the same content
  hash keeps its identity; if both change at once, the old identity is
  reported `missing` and the new file gets a new provisional id. Compute
  `rev` (SHA-256 of normalized content, first 16 hex chars) per note and per
  chunk, and keep `note_revisions(id, rev, first_seen)` (hashes only, never
  content). Duplicate explicit `id`s across notes are an error reported by
  `ebrain doctor`; both notes are indexed and the later one gets a
  provisional id. **Provisional ids are best-effort and not durable across a
  full index rebuild** (I7): after `reindex --full` they are re-derived from
  current content. Anything meant to be cited long-term should have an
  assigned `id` (see `ebrain ids assign` in the cognition spec); tools mark
  provisional ids with `provisional: true` so callers can tell. `ebrain index
  dump` omits provisional ids and rename history, so that dump equality (I11)
  holds across full rebuilds.
- **Citation edges.** Index note-to-note citations found in `sources` and
  `derived_from` (`note:<id>@<rev>`) in a `cites(from_id, to_id, to_rev)`
  table, so "which notes cite this note?" is answerable without scanning.
- **Schema fields.** Parse `status`, `pinned`, `kind`, `occurred`,
  `valid_from`, `valid_until`, `author`, `origin`, `sources`,
  `untrusted_origin`, `schema` per the Note schema. Invalid dates and unknown
  statuses are counted, never fatal (I10).
- Deterministic ordering for all listings (I11).

### Acceptance Criteria

- A fixture vault (checked into `tests/fixtures/vault/`) covering nested
  folders, aliases, unresolved links, bad frontmatter, code fences, unicode
  names, and a symlink-to-outside indexes without error and without reading
  the symlink target.
- `ebrain reindex` twice yields byte-identical `ebrain index dump` output
  (dump excludes provisional ids and rename history).
- A note citing another via `sources: [note:<id>@<rev>]` appears in the `cites`
  table, and the cited note reports its citing notes.
- Deleting the index DB and re-running `ebrain reindex --full` reproduces the
  same dump.
- Vault checksum (all file hashes) is unchanged after indexing.
- Malformed frontmatter file is counted in the reindex summary and its body is
  still searchable.
- Renaming or moving a note without editing it keeps its id (explicit or
  provisional); editing and moving it in one step yields a new provisional id
  and reports the old id `missing`; editing a note changes its `rev` and adds
  a row to `note_revisions`.
- Two notes with the same explicit `id` are both indexed and flagged by
  `ebrain doctor`; an unknown `status` is counted and indexed lowest-ranked.
- `bash tests/phase02.sh` passes.

## Phase 3 - MCP Server (stdio) with Read Tools

<!-- runner:model=high -->
<!-- runner:read=src/index -->
<!-- runner:verify=bash tests/phase03.sh -->

### Requirements

- `ebrain mcp` starts an MCP server over **stdio** using the official SDK. It
  exposes exactly these tools in this phase (read tools are available in every
  mode; write tools are added by Phases 4 and 12 according to mode):
  - `search({ query, limit?, tags?, folder? })` -> ranked results with
    `path`, `heading_path`, an excerpt, and a `citation` (see "Result
    fields").
  - `read_note({ path })` -> note text (frontmatter + body), size-capped.
  - `list_notes({ folder?, tag?, limit? })`.
  - `related({ path, limit? })` -> backlinks, outgoing links, and notes sharing
    tags. Structural only; no similarity yet.
- **Result fields.** Every note-bearing result includes `id`, `provisional`
  (bool), `rev`, `status`, `kind`, `occurred`, `path`, and `citation`
  (`note:<id>@<rev>[#heading]`). Every `search`, `related`, and `list_notes`
  response also includes a `recall_id` (ULID) identifying that result set.
- **Filters.** `search` and `list_notes` accept `status` (one or many),
  `include_superseded` and `include_archived` (default false), and `as_of`
  (ISO date): results exclude notes whose `valid_until < as_of` or
  `valid_from > as_of`, and exclude `superseded`/`archived` notes whose
  supersession/archival date is `<= as_of`. Default `as_of` is now.
- **Citation grammar (`src/cite/`).** Pure functions `parseCitation`,
  `formatCitation`, and `checkNoteCitation(cite) -> fresh|stale|missing`.
  Grammar: `note:<id>@<rev>[#<heading>]`, `ref:<ref_id>/<chapter>/<ordinal>`
  (book passages, added in Phase 7), `thesis:<id>`, `outcome:<id>`,
  `commit:<sha>`, `url:<https-url>`. Unit tests include malformed and hostile
  inputs. Later phases and specs use this grammar wherever they say
  "citation".
- **One ranking function (I13).** Create `src/index/rank.ts` and
  `docs/RANKING.md`. Initial tiers: accepted notes (and notes outside special
  folders) first, then everything else in the order later phases register.
  Within a tier: BM25 relevance (and vector via RRF when Phase 8 is on),
  then deterministic tie-break (path, ordinal). Later phases add their tiers
  here with tests; none reorders results elsewhere.
- **Tool registry fixture.** `tests/fixtures/tools-by-mode.json` is the single
  source of truth for the expected MCP tool names per mode
  (`inbox`, `journal`, `read-only`). Every phase that adds a tool updates it in
  the same change, and every phase's tool-list assertion compares against it
  (no phase hardcodes its own list). No mode may ever list an accept, promote,
  edit, delete, move, or job-starting tool.
- Every read tool accepts optional `max_chars` and `format: "full"|"compact"`
  per I6; `max_chars` can only lower the configured ceiling
  (`limits.maxCharsPerCall`). Compact format returns citations plus excerpts
  of at most 200 characters.
- All tool inputs validated with a schema; `path` arguments go through
  `safe-path`. Tool errors are returned as structured MCP errors, never stack
  traces.
- All text returned to the model is wrapped per I6. The wrapper lives in
  `src/mcp/fence.ts` with its own unit tests (a note whose body contains runs
  of backticks of any length cannot terminate the fence).
- Search is BM25 via FTS5 in this phase. Query input is escaped so FTS syntax
  in the query cannot error or inject operators unless a documented
  `advanced: true` flag is set.
- Server writes logs to stderr only (stdout is the protocol channel) and never
  logs note contents.
- Provide `docs/SETUP.md` snippets for Claude Code
  (`claude mcp add ...`) and Claude Desktop config using an **absolute path**
  to the installed `ebrain` binary.

### Acceptance Criteria

- An integration test spawns `ebrain mcp`, performs the MCP initialize
  handshake, lists tools (matching the `read-only` entry of the tool registry
  fixture), and exercises each tool against the fixture vault.
- `read_note` with `../../etc/passwd`, an absolute path, and the escaping
  symlink all return errors and never read outside the vault.
- A fixture note containing a prompt-injection string and long backtick runs is
  returned inside a fence that cannot be closed by the content.
- Result fields are present and correct; `recall_id` is unique per call; a
  `citation` returned by `search` passes `checkNoteCitation` as `fresh`, and
  `stale` after the note is edited and reindexed.
- `as_of` fixture: a note with `valid_until` in June is returned for
  `as_of=2026-05-01` and hidden for `as_of=2026-07-01`; `superseded` and
  `archived` notes are hidden by default and shown with the include flags.
- `rank.ts` is the only module that orders results (scan test); the tier
  table test passes.
- Responses never exceed the configured size cap; `max_chars` below the cap is
  honored and `max_chars` above it is clamped (test both).
- stdout contains only protocol frames during a full session (asserted).
- `bash tests/phase03.sh` passes.

## Phase 4 - Inbox: Capture and Human Review Gate

<!-- runner:model=high -->
<!-- runner:read=src/mcp -->
<!-- runner:verify=bash tests/phase04.sh -->

### Requirements

- Add MCP tools, registered **only when `mode` is `inbox`** (they do not exist
  in `journal` or `read-only` mode; asserted by a tool-list test per mode):
  - `capture({ title, body, kind?, sources? })` -> creates
    `_inbox/<yyyymmdd-hhmmss>-<slug>.md` with frontmatter
    `status: proposed`, `kind` (`fact|decision|preference|idea|lesson|reference`),
    `created`, `origin: mcp`, `author` (the configured `principal.id`), and
    `sources` (list of source identifiers). The body passes through the scrubber (Phase 5 adds the real scrubber; in
    this phase call a `scrub()` stub that is wired in and returns text
    unchanged, with a test that the call site exists). Atomic write (tmp +
    rename), mode `0600`.
  - `list_inbox({ limit? })` -> proposed notes with citations; fenced per I6.
- **I2 enforcement:** the inbox writer takes only a validated slug and is
  structurally unable to produce a path outside `_inbox/`. Slugs are
  sanitized, length-limited, and de-duplicated by suffix. Existing files are
  never overwritten.
- CLI (owner-only, not MCP):
  - `ebrain inbox list`
  - `ebrain inbox show <id>`
  - `ebrain inbox accept <id> [--to <folder>] [--edit]` (`<id>` is the note id;
    default folder `notes/`) -> moves the note to the destination folder, sets `status: accepted`, adds `accepted: <timestamp>`.
  - `ebrain inbox reject <id> [--reason ...]` -> moves to `_inbox/_rejected/`
    (kept, not deleted) with `status: rejected`.
- Acceptance by moving a file out of `_inbox/` manually in Obsidian is also
  valid: the next `reindex` treats any note outside `_inbox/` as permanent
  regardless of its `status` field.
- Inbox notes are searchable but ranked below permanent notes (registered as
  a tier in `rank.ts`) and clearly labeled `proposed` in results so Claude
  never presents them as established facts.
- `_inbox/` exists in **every** vault regardless of mode. MCP write tools are
  mode-gated (above), but owner-run CLI commands (for example the cognition
  jobs) may create proposal files there in any mode.
- Every note the inbox creates gets an `id` (ULID) and `schema: 1`; `accept`
  preserves the `id` and sets `status: accepted`.

### Acceptance Criteria

- Static test: a scan of `src/mcp/` shows no filesystem write calls outside the
  inbox writer module.
- Test: attempt to `capture` with titles such as `../../x`, `.obsidian/app`,
  a 10k-character title, and an existing slug; all stay inside `_inbox/`, never
  overwrite, and fit length limits.
- The MCP tool list in each mode matches `tests/fixtures/tools-by-mode.json`
  (updated here: `inbox` gains `capture` and `list_inbox`). There is no
  accept/delete/move/overwrite tool in any mode (asserted).
- Accept/reject CLI commands produce the specified file moves and frontmatter
  changes and preserve the note `id`; vault files outside `_inbox/` are
  unchanged by `capture`.
- `bash tests/phase04.sh` passes.

## Phase 5 - Secret and Sensitive-Data Scrubber

<!-- runner:model=high -->
<!-- runner:read=src/inbox -->
<!-- runner:verify=bash tests/phase05.sh -->

### Requirements

- Implement `src/scrub/` as a pure library: `scrub(text, opts) ->
  { text, findings: [{type, count}] }`. Findings never contain the secret.
  Replacement token: `[REDACTED:<type>]`.
- Detectors (each with positive and negative fixtures):
  - Provider API keys and tokens: `sk-...` (OpenAI/Anthropic styles), AWS
    access key ids and secret-key-looking pairs, GitHub (`ghp_`, `github_pat_`),
    Slack (`xox[abprs]-`), Stripe (`sk_live_`, `rk_live_`), Google API keys,
    JWTs, generic `Bearer <token>`.
  - PEM / OpenSSH private key blocks (redact the full block).
  - Password assignments: `password`, `passwd`, `pwd`, `secret`, `token`,
    `api_key` followed by `=`, `:`, or "is" and a value; URLs with embedded
    `user:pass@`.
  - Crypto: 64-hex-character strings in a private-key context, WIF keys, and
    BIP39 mnemonics (sequences of 12/15/18/21/24 words that all appear in the
    bundled BIP39 English list).
  - Financial and identity: credit-card numbers (Luhn-validated), US SSN
    pattern, IBAN (mod-97 validated), US bank routing + account patterns when
    adjacent to keywords like "routing" or "account number".
  - High-entropy token heuristic (long base64/hex strings with Shannon entropy
    above a threshold, length >= 32) with a documented, tunable threshold.
- `scrub.extraPatterns` from config adds user regexes (validated; reject
  catastrophic-backtracking patterns via a length limit and a timeout guard).
- Wire the scrubber into: `capture`, and expose `ebrain scrub <file|->` for
  manual use. Remove the Phase 4 stub. Add a `scrubVersion` field to inbox
  frontmatter.
- Fail-safe: if scrubbing throws, the write is aborted (never write unscrubbed
  text).
- **Strict mode for agent principals.** When `principal.type` is `agent`,
  detections of private keys, seed phrases/mnemonics, PEM blocks, and
  provider API keys cause the **entire write to be rejected** (error returned,
  nothing stored) instead of redacting-and-continuing, and the rejection is
  recorded by detector type only (in the audit log once Phase 12 exists; until
  then as a count on stderr). Public addresses (for example
  `0x` + 40 hex) are not secrets and are preserved.

### Acceptance Criteria

- A fixture corpus of at least 60 positive cases (including synthetic,
  non-real keys formatted like real ones) and 60 negative cases (UUIDs, git
  SHAs, normal prose with the word "password", lorem ipsum, long URLs) with
  precision/recall reported by the test; all positives redacted, false
  positives on the negative set <= 2%.
- No finding output, log line, or test snapshot contains a raw fixture secret.
- A BIP39 12-word mnemonic is redacted; a 12-word ordinary sentence is not.
- Idempotent: `scrub(scrub(x)) == scrub(x)`.
- A pathological input (1 MB of `a`) scrubs within a time bound (test timeout).
- `capture` with a body containing a fake API key stores `[REDACTED:...]` in
  the inbox file (human principal).
- With `principal.type: agent`, a write containing a fake private key, a fake
  BIP39 mnemonic, or a fake API key is rejected whole, stores nothing, and a
  public `0x` address in an otherwise clean write is preserved.
- `bash tests/phase05.sh` passes.

## Phase 6 - Conversation Importers and Raw Archive

<!-- runner:model=high -->
<!-- runner:read=src/scrub -->
<!-- runner:verify=bash tests/phase06.sh -->

### Requirements

- `ebrain import claude-code [--projects-dir <dir>]` reads Claude Code JSONL
  transcripts (default `~/.claude/projects/**/*.jsonl`). Include only real
  human and assistant text; skip meta frames, tool results, and thinking
  blocks. Tolerate unknown fields and malformed lines (count and skip).
- `ebrain import claude-export <file.zip|dir>` and
  `ebrain import chatgpt-export <file.zip|dir>` for the official data exports
  (conversations JSON). Zip handling must defend against zip-slip, zip bombs
  (entry count and uncompressed size limits), and path traversal in entry
  names (I1). Prefer streaming extraction; do not extract to disk unless
  needed, and only into the state dir.
- Output: scrubbed conversation transcripts stored in the **raw archive**,
  `<vault>/_raw/conversations/<source>/<yyyy>/<id>.md`, with frontmatter
  (`id`, `schema`, `source`, `conversation_id`, `started`, `ended`,
  `occurred` (= conversation start), `turns`, `scrubVersion`).
  Raw archive notes are indexed and searchable but labeled `kind: raw` and
  ranked below curated notes (a tier registered in `rank.ts`). They are never
  treated as established facts. Archive-file `id`s are stable functions of
  source + conversation id so re-imports keep identity.
- Idempotent: re-importing the same export produces no duplicates (stable id
  derived from source + conversation id). Updated conversations replace their
  archive file atomically.
- `--dry-run` prints counts (conversations, turns, findings by scrub type)
  without writing.
- Scrubbing is mandatory and not optional via flag.

### Acceptance Criteria

- Fixture exports (small synthetic Claude Code JSONL, Claude export, ChatGPT
  export) import correctly; counts match expectations.
- Fixtures containing fake secrets produce archive files with redactions and
  the import summary reports the finding counts.
- Zip-slip entry (`../../evil.md`), oversized entry, and excessive entry-count
  archives are rejected without writing outside the state dir/vault.
- Re-running an import changes no files (checksum) and keeps every archive
  note's `id`; archive notes carry `occurred` equal to the conversation start.
- Malformed JSONL lines are skipped and counted, not fatal.
- `bash tests/phase06.sh` passes.

## Phase 7 - Reference Library (Books) with Citations

<!-- runner:model=high -->
<!-- runner:read=src/index -->
<!-- runner:verify=bash tests/phase07.sh -->

### Requirements

- `ebrain refs add <file> [--title ... --author ...]` supports `.epub`,
  `.md`, and `.txt`. PDF support is via the optional external `pdftotext`
  binary called with an argument array (never a shell string), a timeout, and
  an output size cap; if the binary is absent, PDFs are rejected with a clear
  message. No PDF parsing library in v1.
- EPUB: read the zip safely (same limits as Phase 6), follow the OPF spine
  order, convert XHTML to text (strip scripts/styles; no external fetches),
  and split into chapters by navigation/headings.
- **Book text is stored only in the derived index database**, not in the
  vault, in a `refs_chunks` table keyed by `(ref_id, chapter, ordinal)` along
  with metadata and the source file's absolute path and hash. The vault gets a
  small user-owned note per reference at `references/<slug>.md` containing
  title/author/source path and a place for the owner's own notes (created once;
  never overwritten).
- `search` gains a `scope` parameter: `notes` (default), `raw`, `refs`, `all`.
  Reference results return a **short excerpt** (default <= 400 characters per
  hit, <= 5 hits) plus a human label `Title, Chapter N (heading)` and a `citation` of the form
  `ref:<ref_id>/<chapter>/<ordinal>`.
  A new tool `read_ref_chunk({ ref_id, chapter, ordinal })` returns one
  chunk, subject to the same size cap and fencing, so the model cannot dump an
  entire book in one call.
- `ebrain refs list`, `ebrain refs remove <ref_id>` (removes index rows; leaves
  the owner's vault note), `ebrain refs reindex`.
- Chunking preserves chapter and heading metadata for citation. `read_ref_chunk`
  is a read tool and is added to every mode in the tool registry fixture.

### Acceptance Criteria

- A small public-domain EPUB fixture ingests; searching for a known phrase
  returns the right chapter citation.
- No book text appears anywhere under the vault after ingest (scan test).
- `search` with `scope: refs` never returns more than the configured excerpt
  and hit limits; `read_ref_chunk` respects the size cap and rejects
  out-of-range ids.
- Malicious EPUB fixtures (zip-slip, huge entry, XHTML referencing external
  URLs) neither write outside the state dir nor make network requests.
- Re-adding the same file (same hash) is a no-op.
- `bash tests/phase07.sh` passes.

## Phase 8 - Optional Local Embeddings and Hybrid Search

<!-- runner:model=default -->
<!-- runner:read=src/index -->
<!-- runner:verify=bash tests/phase08.sh -->

### Requirements

- Default config keeps `embeddings.provider: "none"`; everything still works
  with BM25 only.
- Add provider `ollama` (loopback `http://127.0.0.1:11434` by default) behind
  `src/net/`. Embedding requests contain only already-scrubbed chunk text (I5).
  Non-loopback base URLs require the host to be in `network.allowedHosts`.
- Store vectors in SQLite (use `sqlite-vec` with an exact pin if it can be
  loaded; otherwise a plain BLOB table with brute-force cosine similarity is
  acceptable at personal-vault scale, and must be selectable via config).
  Store `model`, `dimensions`, and a content hash per vector; changing the
  model triggers a re-embed.
- Hybrid ranking: Reciprocal Rank Fusion of BM25 and vector results. Ordering
  must be deterministic (tie-break by path, then ordinal).
- `ebrain reindex` embeds only new/changed chunks. Embedding failures degrade
  to BM25 with a warning counted in the summary; they never fail the reindex.

### Acceptance Criteria

- With a mock embedding server (loopback, in the test), hybrid search returns
  a semantically related note that BM25 alone misses on the fixture.
- With provider `none`, no code path in `src/net/` is invoked (asserted by
  spy).
- A config pointing at a non-allowlisted remote host is rejected at load time.
- Switching the model value triggers re-embedding of all chunks.
- `bash tests/phase08.sh` passes.

## Phase 9 - Claude Code Hooks: Session Brief and Checkpoints

<!-- runner:model=default -->
<!-- runner:read=src/inbox -->
<!-- runner:verify=bash tests/phase09.sh -->

### Requirements

- `ebrain hook session-start` reads the Claude Code hook JSON from stdin and
  prints a **brief** to stdout: recent accepted notes (by tag/folder
  configured as `hooks.briefFolders`), open inbox count, and optional
  user-written focus text. Output is fenced per I6, capped at 10,000
  characters, and always exits 0 (fail open: a hook must never break a
  Claude Code session).
- `ebrain hook pre-compact` reads the hook JSON, loads the transcript from
  `transcript_path` (only if it resolves to a file under the configured
  Claude projects directory), extracts the opening request and recent user
  turns, scrubs them, and writes **one proposed note to `_inbox/`**
  (`origin: hook`, `kind: raw`; it ranks as an inbox note while it is in
  `_inbox/`). Extractive only; no LLM call. No-op unless
  `hooks.captureCheckpoints` is explicitly `true`.
- `ebrain hook install` / `ebrain hook remove` modify only entries it owns in
  `~/.claude/settings.json`, tagging them so they can be identified; user
  entries are untouched. The installed command uses the **absolute path to the
  installed `ebrain` binary**. No `uvx`/`npx`/PATH search fallbacks.
- Hooks that write (`pre-compact`) require `mode: inbox`; in any other mode
  they are a no-op that exits 0. `session-start` is read-only and works in
  every mode.
- Hook configuration is read only from the user-level `config.json`, never
  from project-local files (a cloned repo must not be able to redirect
  capture).

### Acceptance Criteria

- Hooks exit 0 and print nothing harmful on malformed stdin, missing
  transcript, or a transcript path outside the allowed directory.
- A transcript fixture containing a fake secret yields an inbox note with the
  secret redacted.
- A project-local `.claude/settings.json` with an `ebrain` block has no effect
  on behavior (test).
- `install` then `remove` leaves a pre-existing user hook byte-identical.
- The generated hook command is an absolute path (asserted).
- `bash tests/phase09.sh` passes.

## Phase 10 - Candidate Note Proposals from Archives (Pluggable, Off by Default)

<!-- runner:model=high -->
<!-- runner:read=src/import -->
<!-- runner:verify=bash tests/phase10.sh -->

### Requirements

- `ebrain propose [--since <date>] [--source <id>]` reads raw archive
  conversations and produces **candidate notes in `_inbox/`** (decisions,
  preferences, lessons, ideas) with `sources` citing the archive note and turn
  range. Nothing is written outside `_inbox/`.
- Extraction provider interface lives in the **shared** `src/llm/` module (not
  inside `propose`), so later jobs reuse it, with per-run budgets, versioned
  prompt files, and strict output-schema validation:
  - `none` (default): command exits with a message explaining no provider is
    configured.
  - `openai-compatible`: any OpenAI-compatible chat endpoint, intended for a
    local model (Ollama, llama.cpp). Same network rules as Phase 8.
  - `anthropic`: allowed only if `network.allowedHosts` includes
    `api.anthropic.com` **and** the CLI is run with `--i-understand-data-leaves-machine`.
    API key read from an environment variable named in config, never stored in
    the config file.
- `propose` requires `mode: inbox` and a `human` principal; it refuses to run
  otherwise.
- Prompts instruct the model to extract only claims explicitly present, quote
  supporting text, and never invent. Candidate output is validated against a
  schema; invalid items are dropped and counted.
- Only scrubbed archive text is ever sent to a provider (I5).
- Each candidate carries `confidence: unrated` (no model-assigned scores) and
  citation(s) to source turns so the owner can verify before accepting.
- Idempotent: the same archive range does not produce duplicate candidates
  (stable candidate id from source + range + text hash).

### Acceptance Criteria

- With a mock OpenAI-compatible server, `propose` creates schema-valid inbox
  candidates that cite source ranges; malformed model output is dropped and
  counted, not crashed on.
- Without the data-leaves-machine flag, the `anthropic` provider refuses to
  run; a request body captured by the mock contains no raw fixture secrets.
- Running `propose` twice creates no duplicates.
- Nothing outside `_inbox/` changes (vault checksum excluding `_inbox/`).
- The provider code lives under `src/llm/` and is imported by `propose`
  (scan test: no provider code under `src/propose/`).
- `bash tests/phase10.sh` passes.

## Phase 11 - Optional Loopback HTTP Transport and Packaging for Multiple People

<!-- runner:model=default -->
<!-- runner:read=src/mcp -->
<!-- runner:verify=bash tests/phase11.sh -->

### Requirements

- **Packaging (required):**
  - `ebrain init` interactively (or via flags) writes `config.json`, creates the
    state dir with correct modes, creates `_inbox/`, `_raw/`, `references/` (and
    `journal/<principal-id>/` when the mode is `journal`) in the vault if
    missing, and prints the Claude Code / Claude Desktop MCP
    snippets with absolute paths.
  - `docs/SETUP.md` covers install for one person end to end, plus a short
    section "Several people, separate brains": each person installs
    independently with their own vault and state dir; no shared server; how to
    keep vaults in sync with their own tool (Obsidian Sync, git, iCloud) and why
    the state dir (index DB) must **not** be synced.
  - A `ebrain doctor --strict` mode that fails if: network is enabled with
    non-loopback hosts, state dir permissions are loose, the vault contains a
    symlink escaping the root, or auto-hooks are installed without
    `captureCheckpoints` being deliberate.
- **Optional HTTP transport (off by default):** `ebrain mcp --http` serves MCP
  over Streamable HTTP bound to `127.0.0.1` only, requiring a bearer token
  generated by `ebrain token create --principal <id>` (one token per
  principal; the token's principal must equal the instance's configured
  principal, so a token for one agent cannot be used against another agent's
  instance) (32+ bytes, stored hashed, constant-time
  comparison). Refuses to start on non-loopback binds. Documented as intended
  for tunneling by the owner (for example over a private network), with an
  explicit warning that public exposure is unsupported. No OAuth in this
  ticket.

### Acceptance Criteria

- `ebrain init` on an empty temp dir yields a working setup that passes
  `ebrain doctor --strict`.
- `ebrain mcp --http` refuses `0.0.0.0` and non-loopback hosts; rejects missing,
  wrong, and malformed tokens; accepts the valid token; the token is not stored
  in plaintext (grep test of the state dir).
- Two simultaneous instances with different `EBRAIN_CONFIG` files and vaults
  cannot read each other's data (test using two temp vaults and state dirs).
- The source-scan tests for I3 and I4 still pass over the full tree.
- `bash tests/phase11.sh` passes.

## Phase 12 - Agent Principals: Journal Mode, Audit Log, and Workspace Import

<!-- runner:model=high -->
<!-- runner:read=src/mcp -->
<!-- runner:read=src/scrub -->
<!-- runner:verify=bash tests/phase12.sh -->

Depends on Phases 1-5. Does not depend on Phase 11 (agents may use stdio, with
each agent process launching its own `ebrain mcp` with its own config).

### Requirements

- **Journal mode** (`mode: "journal"`, `principal.type: "agent"` only). Adds
  MCP tools, registered only in this mode:
  - `journal_append({ title, body, kind?, sources?, untrusted_origin? })` ->
    creates a new file `journal/<principal-id>/<yyyy>/<yyyymmdd-hhmmss>-<slug>.md`
    with frontmatter: `id`, `schema: 1`, `author`, `origin: mcp`, `created`, `kind`
    (`log|observation|lesson|decision|todo`), `sources`, `untrusted_origin`,
    `status: journal`, `expires` (from `journal.ttlDays`, default 90), and
    `scrubVersion`. Atomic create-only write; never overwrites or edits an
    existing file; mode `0600`. Daily file consolidation is not performed;
    one entry is one file.
  - `journal_list({ since?, kind?, limit? })`.
  - Strict scrubbing per Phase 5 applies to every write.
- **Rate and size limits** (configurable, enforced server-side, rejecting not
  truncating): `journal.maxEntryChars` (default 4,000), `journal.maxEntriesPerHour`
  (default 60), `journal.maxTotalMB` (default 100). Exceeding a limit returns a
  structured error and is audited.
- **Dedup:** an entry whose normalized body hash matches an entry created by
  the same principal in the last 24h is rejected as a duplicate (returns the
  existing entry's path).
- **Ranking and labeling:** journal entries are indexed and searchable but
  rank below curated notes and inbox notes; results are labeled
  `agent-journal` and, where present, `untrusted_origin`. A `kind: lesson`
  entry with at least one well-formed citation in `sources`
  (`thesis:<id>`, `outcome:<id>`, `commit:<sha>`, or `note:<id>@<rev>`)
  ranks above uncited lessons; uncited lessons rank lowest among
  journal entries. "Well-formed" means it parses with `parseCitation`
  (Phase 3). Citation *resolution* against external evidence is not verified
  by this ticket (see the cognition spec). Journal tiers are registered in
  `rank.ts`.
- **Expiry:** `ebrain journal prune` (owner CLI, not MCP) lists/archives
  entries past `expires` into `journal/_archive/`; it never deletes. Search
  ignores expired entries unless `include_expired` is set.
- **Audit log:** every MCP call in every mode appends one JSON line to
  `<stateDir>/audit.jsonl`: `{ts, principal, mode, tool, args_summary, result_count, bytes_returned, outcome, recall_id, returned}`
  where `recall_id` is the Phase 3 result-set id and `returned` is the list of
  `{id, rev}` for notes returned (ids and revisions only, never content).
  `args_summary` contains paths/ids/counts only, never note bodies, queries
  containing detected secrets, or credentials. The file is opened append-only,
  `0600`; the server never truncates or rewrites it. When the file exceeds
  `audit.maxSegmentMB` (default 50) the server starts a new segment
  (`audit.jsonl.1`, `.2`, ...), leaving earlier segments untouched; readers
  (`ebrain audit tail|stats` and derived rollups) read all segments in order.
  An owner-run `ebrain audit prune --older-than <days>` may delete whole old
  segments only.
- **Workspace import:** `ebrain import agent-workspace <dir> --principal <id>`
  imports an existing agent workspace (`MEMORY.md`, `memory/YYYY-MM-DD.md`,
  `GOALS.md`, and optionally `SOUL.md`/`TOOLS.md` as `kind: reference`) into
  `journal/<principal-id>/imported/`, scrubbed under strict agent rules
  (files that trip a strict detector are skipped whole and listed in the
  summary). Read-only on the source directory; idempotent by content hash.
- **Principal enforcement in tools:** `author` and `principal` are never
  accepted as tool arguments; they come from config only.
- `docs/SETUP.md` gains an "Agents" section: example MCP client entries giving
  an agent three servers (private `journal` brain, shared playbook
  `read-only` brain, team `inbox` brain), the per-call budget settings
  suited to a ~1,000-token heartbeat (`limits.maxCharsPerCall`, compact format),
  and the recommendation to keep each agent vault in git.

### Acceptance Criteria

- Tool-list tests per mode match `tests/fixtures/tools-by-mode.json` (updated
  here: `journal` gains `journal_append` and `journal_list`); no mode exposes
  accept, promote, edit, delete, move, or job-starting tools.
- `journal_append` cannot create files outside
  `journal/<principal-id>/` (hostile title/slug/principal-id fixtures), cannot
  overwrite or append to an existing entry, and ignores any caller-supplied
  `author`/`principal`.
- Strict scrubbing: a fake private key, fake mnemonic, or fake API key causes
  the whole append to be rejected and stores nothing; an ordinary public
  address is preserved.
- Rate, size, total-size, and duplicate limits reject as specified and are
  recorded in the audit log.
- Ranking test on a fixture: curated note > inbox note > cited journal
  lesson > uncited journal lesson > other journal entries; `untrusted_origin`
  is visible in results.
- `journal prune` archives expired entries, never deletes, and search hides
  them by default.
- Every tool call in all three modes produces exactly one audit line; audit
  lines never contain fixture secrets, query text, or note bodies; read-tool
  lines carry the call's `recall_id` and the returned `{id, rev}` list; the
  file is not truncated across server restarts.
- `import agent-workspace` on a fixture resembling `agents/workspace`
  (`MEMORY.md`, daily notes, `GOALS.md`) is idempotent, leaves the source
  directory unchanged (checksum), and skips a file containing a fake private
  key whole.
- Two agent instances with different principals and vaults cannot read each
  other's journals (two temp vaults and state dirs).
- `bash tests/phase12.sh` passes.

## Open Questions (recorded, not blocking)

- Whether to publish as an npm package or distribute as a git clone with a
  documented `npm ci` flow. Default for this ticket: git clone + `npm ci`.
- Whether to add a one-way `shared/` publish step for common material among the
  three owners (future ticket, explicit opt-in per note).
- Whether PDF support deserves a vetted library later; v1 uses `pdftotext`.
- Cognition layer (follow-up spec): `consolidate`, `supersede`, `reflect`
  (outcome-grounded, citing thesis/outcome ids), `forget`, `gaps`, and
  usefulness feedback; all produce proposals only.
- Whether agents' team-brain proposals should be reviewed by a human only or
  also by a designated reviewer agent (defer; human-only until evidence says
  otherwise).
- Remote access for web/mobile Claude (hosted per-person instances with OAuth)
  is deliberately deferred to a separate security-reviewed ticket.
