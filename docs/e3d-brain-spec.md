# Feature Ticket: e3d-brain (Obsidian vault + MCP server for people and agents)

Product name `e3d-brain`; CLI binary `ebrain`; state directory `~/.e3d-brain/`;
config override env var `EBRAIN_CONFIG`.

## Spec Revision (2026-10-14)

Revised after two review passes (a pre-build review and an `e3d-debate` with
two models; transcript in `docs/debates/2026-10-14-spec-review/`). Phases were
split and reordered; `spec2code` accepts only integer phase numbers, hence no
lettered sub-phases. Final order: 1 scaffold, 2 scanner/index, 3 identity and
citation grammar, 4 fence/ranking/registry/dispatch, 5 principal enforcement
and audit, 6 MCP server and packaging, 7 scrubber, 8 inbox, 9 agent journal,
10 conversation importers, 11 reference library, 12 embeddings, 13 hooks,
14 LLM layer and `propose`, 15 HTTP transport. Tests are `tests/phaseNN.sh`.

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
  "Principals and Brains" and Phase 9).
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
- No storing full book text inside the vault (see Phase 11).

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
  counts, timestamp; never note bodies, query text, or secrets). The audit log
  is append-only by convention and tested for no truncation by the server. It
  is implemented in Phase 5; the single dispatch function every MCP tool call
  goes through is built in Phase 4 (Phase 6 onward registers tools only
  through it), so auditing is added there without touching individual tools.
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
  All path handling goes through one module, `src/safe-path.ts`, which also
  exports the only filesystem wrappers the rest of the code may use for a path
  that is not a compile-time constant (`readFileSafe`, `readDirSafe`,
  `statSafe`, `createExclusive`, `writeAtomic`, `renameSafe`, and so on); a
  scan test fails if another module imports `node:fs` for non-constant paths.
  The root itself is realpath-resolved first (on macOS `/tmp` and `/var` are
  symlinks). Paths that legitimately live outside the vault and state dir (the
  Claude projects directory, import sources, `refs add` input files, evidence
  files, `transcript_path`) are accepted only through `resolveInRoot(root,
  relPath)` or `openExternalFile(absPath, allowedRoots)`, where the caller
  names the allowed root explicitly, with the same realpath and symlink rules.
  Temporary files are created in the **same directory** as their target,
  dot-prefixed (the scanner skips dot-files); `createExclusive` publishes with
  `link(tmp, final)` (EEXIST means collision) and falls back to `O_EXCL` where
  hard links are unavailable. Threat model: the vault and state dir belong to a
  trusted local owner and are not concurrently modified by an adversary; the
  residual symlink-swap race between check and use is accepted and documented
  in `docs/SECURITY.md`, and every write revalidates the parent directory's
  realpath immediately before publishing.
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
  fails if they appear outside `src/net/` (this includes the Phase 15 HTTP
  server). `child_process` may appear only in `src/exec/`, which spawns fixed
  binaries (`pdftotext`, `git`) with argument arrays, never a shell string.
- **I4 No telemetry / auto-update / runtime installs.** Enforced by a source
  scan test.
- **I5 Scrub before persist.** Text from conversations, books, captures,
  workspace imports, and hook payloads (everything the tool ingests or an
  MCP client submits) passes through the scrubber before it is written to the vault,
  the raw archive, the index, or any embedding request. Scrubbed secrets are
  never logged. Notes the owner authored directly in the vault are trusted
  and are indexed as-is; the scrubber guards what enters the vault through
  this tool, not what the owner types.
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
  indexing. Book text (Phase 11) lives in a separate `refs.db` that `reindex`
  never touches; `ebrain refs reindex` rebuilds it from the original source
  files.
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
  BM25 scores are quantized (rounded to 1e-6) before comparison, so ties break
  by the documented rules rather than float noise.
- **I12 Identity and revisions.** Every indexed note has a stable identity (an
  assigned `id`, or a provisional id derived by the index from content hash and first-seen path) and a revision
  (`rev`, a content hash, normalization defined in Phase 3). Tools expose both. Citations to notes are
  revision-pinned and can be checked for staleness. The index never writes ids
  into human-authored notes.
- **I13 One ranking function.** The final ordering of retrieval results is
  computed in exactly one module, `src/index/rank.ts`, with a documented tier table in
  `docs/RANKING.md`. Phases add tiers there; no other module reorders results.

### Note schema (shared by all phases)

Frontmatter fields the server reads or writes. **Unknown keys are preserved**
on any rewrite the server performs (later specs extend this schema).

| Field | Meaning |
|---|---|
| `schema` | integer note-schema version, currently `1` |
| `id` | ULID; assigned at creation by the server or on accept; may be absent on human notes (then a provisional id is derived) |
| `status` | `proposed`, `accepted`, `rejected`, `journal`, `superseded`, `archived`, `stale`. Unknown values fail closed: the note is indexed in the lowest tier (T8), counted, and reported by `ebrain doctor` |
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

### Folder and status semantics

The folder a note lives in sets its **folder class**, which sets its ranking
tier. The `status` field sets lifecycle and default visibility. They are
separate.

| Path | Folder class |
|---|---|
| `_inbox/` | `inbox` |
| `_inbox/_rejected/`, `_inbox/_applied/` | `inbox`, hidden by default |
| `journal/` | `journal` |
| `_raw/` | `raw` |
| `_archive/`, `journal/_archive/<principal-id>/` | `archive`, hidden by default |
| `references/` | `reference` |
| everything else | `curated` |

- A note with no `status` outside `_inbox/`, `journal/`, `_raw/`, and
  `_archive/` is treated as `accepted`. Moving a file out of `_inbox/` in
  Obsidian makes it curated regardless of its `status` field (Phase 8); a note
  in `_inbox/` is inbox-tier regardless of a `status: accepted` it may claim.
- `rejected`, `superseded`, and `archived` hide a note by default wherever it
  lives; `stale` demotes it (tier T7); an unknown value is tier T8 and is never
  treated as `accepted`.
- The tier table lives in Phase 4 and `docs/RANKING.md`.

`sources` entries and any citation field use the citation grammar defined in
Phase 3 (`src/cite/`).

### Stack

- Node.js >= 22 LTS, TypeScript (strict), ESM.
- `@modelcontextprotocol/sdk` (exact pin) for the MCP server.
- SQLite with FTS5. Prefer `better-sqlite3` (exact pin). Startup must verify
  FTS5 is available and fail with a clear message if not.
- `node:test` for tests; no heavy test framework.
- Frontmatter parsing via a small, pinned YAML library (`yaml`).
- `package.json` declares `engines.node >= 22` and the repo has an `.nvmrc`.
  `npm run build:native` is the single documented native-build step
  (`npm rebuild better-sqlite3`); `npm ci --ignore-scripts` followed by that
  step is the only install procedure. Direct dependencies are decided up front
  (MCP SDK, `better-sqlite3`, `yaml`; a zip reader in Phase 10; an XHTML text
  extractor in Phase 11) and each gets a `docs/DEPENDENCIES.md` line that
  includes its transitive package count from `npm ls --all`.

### Platforms and deployment

- Build and test on macOS (arm64) and Linux (Ubuntu, x64 or arm64). Every
  `tests/phaseNN.sh` must pass on both; tests must not assume a case-sensitive
  or case-insensitive filesystem, must create vaults under a realpath-resolved
  temp directory, and must not assume NFC or NFD filenames.
- Production runs on Linux servers (AWS). Obsidian is never required on a
  machine that runs `ebrain`: the server reads and writes plain Markdown and
  never calls Obsidian. Obsidian is only an optional desktop viewer/editor for
  the vault. Vaults are kept in sync between machines with the owner's own tool
  (git recommended); the state dir (index, audit, undo) is never synced.

### Repository layout (target)

```text
e3d-brain/
  package.json  package-lock.json  tsconfig.json
  src/
    safe-path.ts  config.ts  vault/  index/  mcp/  scrub/  cite/  llm/
    inbox/  journal/  principal/  audit/  import/  refs/  embed/  hooks/
    net/  exec/  cli/
  tests/phase01.sh ... phase15.sh   (each runs node:test suites + checks)
  docs/ e3d-brain-spec.md  e3d-brain-cognition-spec.md  DEPENDENCIES.md
        SECURITY.md  SETUP.md  RANKING.md
```

## Running This Spec

Run with `spec2code` (the successor of `codex-spec-runner`; same phase format),
using `--provider claude`. Phases 1-8 are the core memory layer for people
(index, identity, citations/ranking, MCP read tools, audit, inbox, scrubber).
Phase 9 adds agent mode and needs Phases 1-8. Phases 10 and 11 add importers and
the reference library. Phases 12, 13, and 15 are optional. Phase 14 (shared LLM
layer, `propose`) is optional for the memory layer but **required by the
cognition spec**. The follow-up `docs/e3d-brain-cognition-spec.md` builds on
Phases 1-9 and 14.

```bash
spec2code docs/e3d-brain-spec.md --preflight --provider claude
spec2code docs/e3d-brain-spec.md all --from 1 --to 8 --provider claude
spec2code docs/e3d-brain-spec.md 9 --provider claude
```

Intended pause points for human review: after Phase 1 (safe-path API), after
Phase 3 (identity, revision, and citation rules), after Phase 6 (a usable
audited read-only brain), and after Phase 8 (the human-principal product).

## Phase 1 - Scaffold, Config, and Safe Paths

<!-- runner:model=high -->
<!-- runner:verify=bash tests/phase01.sh -->

### Requirements

- Initialize the TypeScript project per the Stack and layout above, with
  `npm run build`, `npm test`, and a `ebrain` CLI entry (`ebrain --version`,
  `ebrain doctor`).
- `package.json` declares `engines.node >= 22`; add an `.nvmrc`. `npm run
  build:native` runs the single documented native-build step (`npm rebuild
  better-sqlite3`); `ebrain doctor` tells the user to run it if the module
  fails to load.
- Implement `src/safe-path.ts` exporting at least:
  `resolveInVault(root, relPath)`, `resolveInState(stateDir, relPath)`,
  `resolveInRoot(root, relPath)`, `openExternalFile(absPath, allowedRoots)`,
  `assertInside(root, absPath)`, and the safe filesystem wrappers listed under
  I1 (`readFileSafe`, `readDirSafe`, `statSafe`, `createExclusive`,
  `writeAtomic`, `renameSafe`). `createExclusive` publishes a new file without
  ever overwriting (temp file then `link`, or `O_EXCL`); `writeAtomic` is
  tmp + rename for files that are allowed to be replaced. Behavior per
  invariant I1, including realpath of the root and symlink escape detection via
  `realpath` of the deepest existing ancestor. Add a scan test that no module
  other than `src/safe-path.ts` imports `node:fs` for a non-constant path.
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

- `vaultPath` and `stateDir` may start with `~/`; `config.ts` expands exactly
  that prefix (no environment variables, nothing else) and then requires an
  absolute path.
- The config schema is extended **additively** by later phases (for example
  `journal`, `hooks`, `evidence`, `queryLog`); unknown keys remain errors (I10)
  and each phase adds its keys to the schema and to `docs/SETUP.md`.
- `principal.id` must match `^[a-z0-9][a-z0-9_-]{0,63}$` (it becomes a path
  segment); `principal.type` is `human` or `agent`; `mode` is one of `inbox`,
  `journal`, `read-only`. `mode: journal` requires `principal.type: agent`.
  Invalid values fail config load (I10).
- State directory created `0700`; any file the tool creates is `0600`. Modes
  are set with explicit `chmod`/open modes, never left to the umask.
- The config file decides mode and principal, so it is checked at load: it
  must be owned by the current user and not group- or world-writable, else
  load fails.
- `ebrain doctor` reports: platform (OS and arch), Node version, whether the vault filesystem is case-sensitive (probed with a temp file in the
  state dir, never written into the vault), FTS5 availability, vault path exists
  and is readable, state dir permissions, and the string `network: disabled`
  unless `allowedHosts` is non-empty.
- Create `docs/SECURITY.md` listing invariants I1-I13 verbatim and
  `docs/DEPENDENCIES.md` with one line per dependency.

### Acceptance Criteria

- Property-style tests: for a corpus of hostile paths (`../x`, `a/../../x`,
  absolute paths, `%2e%2e`, NUL byte, backslash traversal, a symlink inside the
  vault pointing outside, a symlink loop, case and Unicode-normalization
  variants of a protected name) `resolveInVault` rejects every one and accepts
  ordinary nested paths including unicode filenames. Tests run against a
  realpath-resolved temp dir (macOS `/var` and `/tmp` are symlinks) and the
  root is accepted whether given as the symlinked or the resolved path.
- Config with an unknown key is rejected with an error naming the key.
- Config with a hostile `principal.id` (`../x`, uppercase, 65+ chars, empty),
  an unknown `mode`, or `mode: journal` with `type: human` is rejected.
- State dir and files are created with modes `0700`/`0600` (asserted in test).
- `npm ci --ignore-scripts && npm run build && npm test` passes.
- The scan test for `node:fs` use outside `src/safe-path.ts` passes.
- The suite passes on macOS and Linux.
- `bash tests/phase01.sh` passes.

## Phase 2 - Vault Scanner, Parser, and SQLite Index

<!-- runner:model=high -->
<!-- runner:read=src/safe-path.ts -->
<!-- runner:verify=bash tests/phase02.sh -->

### Requirements

- Vault scanner: walk the vault via `safe-path`, include `*.md`, skip
  `.obsidian/`, `.git/`, `.trash/`, dot-directories, and dot-files (these
  include the writers' temporary files). Do not follow
  symlinks. Never write to the vault.
- Parser: extract frontmatter (YAML), title (frontmatter `title` or first H1
  or filename), tags (frontmatter and inline `#tag`), headings, `[[wikilinks]]`
  (with aliases and heading anchors), and body text. Malformed frontmatter must
  not abort indexing: skip the frontmatter, index the body, count the error.
- Chunking: split notes by heading; keep fenced code blocks intact; target a
  maximum chunk size (default 1,500 characters) with sentence-aware splitting
  for long sections. Each chunk records `note_path`, `heading_path`, ordinal.
- Index (SQLite, `<stateDir>/index.db`, WAL mode, `busy_timeout` set; the state dir must be on a local filesystem,
  not NFS or EFS, which `docs/SETUP.md` states): tables
  for notes, chunks, links, tags; an FTS5 virtual table over chunk text.
  Per-file stat key (size, `mtime_ns`, inode, `ctime_ns`) plus content hash
  so `ebrain reindex` is incremental; `ebrain reindex
  --full` rebuilds from scratch.
- **Index freshness.** Expose `refreshIndex()` (stat-based: the stat key above
  first, content hash only when it changed) that is cheap enough to call
  before every read and after every MCP write. `ebrain reindex` is the explicit
  full-fidelity command; `refreshIndex()` is what the MCP server (Phase 6) and
  the writers (Phases 8 and 9) call so that new captures and journal entries
  are searchable immediately. The CLI and any number of MCP processes may use
  the same `index.db` concurrently (WAL plus busy timeout); a test runs a
  reindex while a second process queries. A watcher is out of scope.
- Resolve wikilinks to notes by (a) exact path, (b) case-insensitive basename,
  (c) alias; record unresolved links as such. Basename and alias matching
  compares Unicode NFC-normalized, case-folded names (APFS and ext4 differ on
  both; results must be identical on macOS and Linux). Two vault paths that
  differ only by case or normalization are both indexed and reported by
  `ebrain doctor` as a collision.
- **Schema fields.** Parse `status`, `pinned`, `kind`, `occurred`,
  `valid_from`, `valid_until`, `author`, `origin`, `sources`,
  `untrusted_origin`, `schema` per the Note schema, and compute each note's
  **folder class** (`curated`, `inbox`, `journal`, `raw`, `archive`,
  `reference`) from its path per "Folder and status semantics". Invalid dates
  and unknown statuses are counted, never fatal (I10). Unknown frontmatter keys
  are kept in the index as an opaque JSON blob and never dropped.
- Deterministic ordering for all listings (I11): paths sort bytewise on their
  NFC-normalized UTF-8 form (never locale-dependent).
- `ebrain index dump` prints a canonical text dump of index contents
  (excluding provisional ids and rename history, see Phase 3) for equality
  tests.

### Acceptance Criteria

- A fixture vault (checked into `tests/fixtures/vault/`) covering nested
  folders, aliases, unresolved links, bad frontmatter, code fences, unicode
  names (NFC and NFD variants), a case-colliding pair, and a symlink-to-outside
  indexes without error and without reading the symlink target.
- `ebrain reindex` twice yields byte-identical `ebrain index dump` output.
- Deleting the index DB and re-running `ebrain reindex --full` reproduces the
  same dump.
- Vault checksum (all file hashes) is unchanged after indexing.
- Malformed frontmatter file is counted in the reindex summary and its body is
  still searchable.
- A note created or edited after the last reindex becomes visible after
  `refreshIndex()` without a full reindex; a concurrent reindex and query do
  not corrupt or lock out each other.
- The same fixture produces the same dump on macOS and Linux (CI runs both, or
  the test records the platform and the dump is compared across platforms).
- `bash tests/phase02.sh` passes.

## Phase 3 - Note Identity, Revisions, Citation Grammar, and Edges

<!-- runner:model=high -->
<!-- runner:read=src/index -->
<!-- runner:verify=bash tests/phase03.sh -->

### Requirements

- **Identity (I12).** For each note: read `id` from frontmatter if present;
  otherwise derive a **provisional id** (prefixed `prov_`) from the SHA-256 of
  the first-seen content hash **plus the first-seen vault path**, so two notes
  with identical content get distinct provisional ids. Persist it in the index
  DB so it stays stable while the note is unchanged.
- **Rename and move detection.** Match by content hash only when the hash is
  unambiguous: exactly one file disappeared and exactly one appeared with that
  hash. A file that disappears from one path and appears at another with the
  same content hash keeps its identity. If several disappeared or appeared files
  share a hash (duplicates, empty notes), no rename is inferred: old identities
  are reported `missing` and new files get new provisional ids. If both content
  and path change at once, the old identity is reported `missing` and the new
  file gets a new provisional id.
- **Revision normalization.** `rev` is the first 16 hex characters of the
  SHA-256 of the whole file (frontmatter plus body) after normalization: decode
  as UTF-8, strip a leading BOM, convert CRLF and CR to LF, and nothing else.
  A separate `chunk_rev` (same procedure over the chunk text) is computed per chunk; `rev` always means the note revision. Any byte change that survives normalization
  (including a frontmatter edit such as `status: accepted` or an added `id`)
  changes `rev`. Keep `note_revisions(id, rev, first_seen)` (hashes only, never
  content).
- Duplicate explicit `id`s across notes are an error reported by `ebrain
  doctor`; both notes are indexed and the later one (by path order) gets a
  provisional id. **Provisional ids are best-effort and not durable across a
  full index rebuild** (I7): after `reindex --full` they are re-derived from
  current content. Anything meant to be cited long-term should have an assigned
  `id` (see `ebrain ids assign` in the cognition spec); tools mark provisional
  ids with `provisional: true` so callers can tell. `ebrain index dump` omits
  provisional ids and rename history, so that dump equality (I11) holds across
  full rebuilds.
- **Citation grammar (`src/cite/`).** Pure functions `parseCitation`,
  `formatCitation`, and `checkNoteCitation(cite) -> fresh|stale|missing`.
  Grammar: `note:<id>@<rev>[#<heading>]`, `ref:<ref_id>/<chapter>/<ordinal>`
  (book passages, added in Phase 11), `thesis:<id>`, `outcome:<id>`,
  `commit:<sha>`, `url:<https-url>`. `<id>` matches `[A-Za-z0-9_]+`; `<rev>` is
  16 lowercase hex; `<heading>` and `<https-url>` are percent-encoded so that
  `@`, `#`, whitespace, commas, and brackets cannot appear raw; `format` always
  emits the canonical encoding and `parse(format(x))` round-trips. Citations are
  never resolved over the network. Unit tests include malformed and hostile
  inputs. Later phases and specs use this grammar wherever they say "citation".
- **Citation edges.** Index note-to-note citations found in `sources` and
  `derived_from` (`note:<id>@<rev>`) in a `cites(from_id, to_id, to_rev)`
  table, so "which notes cite this note?" is answerable without scanning.
- `ebrain doctor` additionally reports: duplicate ids, `missing` identities,
  unknown statuses, path collisions (case or normalization), and counts of
  malformed frontmatter and invalid dates.

### Acceptance Criteria

- A note citing another via `sources: [note:<id>@<rev>]` appears in the `cites`
  table, and the cited note reports its citing notes.
- Renaming or moving a note without editing it keeps its id (explicit or
  provisional); editing and moving it in one step yields a new provisional id
  and reports the old id `missing`; editing a note changes its `rev` and adds
  a row to `note_revisions`.
- Two byte-identical notes get distinct provisional ids; moving one of two
  identical notes does not transfer identity by guesswork (reported `missing`
  plus new id, not a silent swap).
- CRLF vs LF versions of the same note have the same `rev`; adding a
  frontmatter key changes `rev`.
- Two notes with the same explicit `id` are both indexed and flagged by
  `ebrain doctor`; an unknown `status` is counted and indexed lowest-ranked.
- Vault checksum is unchanged after indexing (the index never writes ids into
  notes).
- Citation grammar tests: round-trip for all kinds, hostile and malformed
  inputs rejected, headings containing `@`, `#`, spaces, and commas survive
  round-trip.
- `bash tests/phase03.sh` passes.

## Phase 4 - Fencing, Ranking, Tool Registry, and Dispatch

<!-- runner:model=high -->
<!-- runner:read=src/index -->
<!-- runner:verify=bash tests/phase04.sh -->

This phase builds the shared machinery that every MCP tool depends on, before
any tool exists.

### Requirements

- **Fence (`src/mcp/fence.ts`).** The wrapper for all text returned to the model
  per I6, with its own unit tests (a note whose body contains runs of backticks
  of any length cannot terminate the fence; the label states reference data,
  non-authoritative).
- **One ranking function (I13).** Create `src/index/rank.ts` and
  `docs/RANKING.md`. The tier table, highest first, with the phase that
  registers each row:

  | Tier | Contents | Registered |
  |---|---|---|
  | T1 curated | folder class `curated` and `reference`, status `accepted` (or absent), including accepted lessons | Phase 4 |
  | T2 inbox | folder class `inbox`, status `proposed` | Phase 8 |
  | T3 cited journal lesson | journal, `kind: lesson`, at least one well-formed citation in `sources` | Phase 9 |
  | T4 uncited journal lesson | journal, `kind: lesson`, no well-formed citation | Phase 9 |
  | T5 other journal | other `journal` entries | Phase 9 |
  | T6 raw | folder class `raw` (`_raw/`) | Phase 10 |
  | T7 stale | status `stale`, in any folder class (ordered after T6) | Phase 4 |
  | T8 unknown | unknown `status` value | Phase 4 |

  The tier is a **total function** `effectiveTier(folder_class, status)`,
  evaluated in this order: (1) status `rejected`, `superseded`, or
  `archived`, or folder class `archive`: hidden by default (not in the table);
  (2) unknown status: T8; (3) status `stale`: T7; (4) otherwise by folder
  class: `curated`/`reference` T1, `inbox` T2, `journal` T3 to T5, `raw` T6.
  A note moved out of `_inbox/` by hand is `curated` and therefore T1
  whatever its `status` says (including `proposed`); the T1 row's status
  column is descriptive, the function above is normative. Notes with status
  `rejected`, `superseded`, or `archived`, and everything
  under `_archive/`, `_inbox/_rejected/`, `_inbox/_applied/`, and
  `journal/_archive/`, are hidden by default and are not in the table; filters
  in Phase 6 reveal them. Reference books (`scope: refs`) are ordered among
  themselves by the same function and always come after note tiers under
  `scope: all`. Within a tier: BM25 relevance (and vector via RRF when Phase 12
  is on), quantized to 1e-6, then deterministic tie-break (path, ordinal).
  Later phases add rows with tests; none reorders results elsewhere. The tier
  table has a test that asserts the exact order above.
- **Tool registry fixture.** `tests/fixtures/tools-by-mode.json` is the single
  source of truth for MCP tool names. Each entry is `{name, modes, phase}`
  (`phase` is the phase that introduces it); a test helper
  `expectedTools(mode, upToPhase)` returns the expected set, and every phase's
  tool-list assertion calls it with that phase's own number (no phase hardcodes
  a list). Every phase that adds a tool updates the fixture in the same change.
  A test asserts that no tool name in any mode matches
  `/accept|promote|edit|delete|move|overwrite|run|job|start/`.
- **Dispatch (`src/mcp/dispatch.ts`).** Every MCP tool call, in every mode,
  goes through one function that validates arguments against the tool's schema,
  checks that the tool is registered for the instance's mode, calls the tool,
  and passes the result through the fence and size cap. Phase 5 adds the audit
  line in this function. A scan test asserts that no tool handler is registered
  with the server except through `dispatch`.
- `docs/RANKING.md` documents the table above and the ordering rules.

### Acceptance Criteria

- Fence tests: backtick runs of every length (including 0 and 100) cannot close
  the fence; the label is present.
- `rank.ts` is the only module that orders results (scan test); the tier table
  test passes, including ties and quantization.
- The tool registry helper returns the expected sets for each mode and phase;
  the forbidden-name test passes.
- A scan test shows tool handlers can only be registered through `dispatch`.
- `bash tests/phase04.sh` passes.

## Phase 5 - Principal Enforcement and Audit Log (All Modes)

<!-- runner:model=high -->
<!-- runner:read=src/mcp -->
<!-- runner:verify=bash tests/phase05.sh -->

Depends on Phases 1-4 (it lives in `dispatch`, built in Phase 4, so it exists
before the first runnable MCP server in Phase 6). Applies to every mode, including human `inbox` instances
and `read-only` instances; it is not agent-specific.

### Requirements

- **Principal enforcement in tools:** `author` and `principal` are never
  accepted as tool arguments (the schema validator rejects them as unknown
  keys); they come from config only.
- **Audit log:** every MCP `tools/call` request in every mode appends exactly
  one JSON line to `<stateDir>/audit.jsonl`, written from `dispatch` (testable in this phase with a fake registered tool; the
  real tools arrive in Phase 6):
  `{ts, principal, mode, tool, args_summary, result_count, bytes_returned, outcome, recall_id, returned}`
  where `recall_id` is the Phase 6 result-set id (absent until the tools exist) and `returned` is the list of
  `{id, rev}` for notes returned (ids and revisions only, never content).
  Rejected, invalid, and errored calls are logged too (`outcome` says which);
  `initialize` and `tools/list` are not tool calls and are not logged.
  `args_summary` contains paths, ids, and counts only: never note bodies, never
  query text, never credentials. The file is opened append-only (`O_APPEND`),
  `0600`; the server never truncates or rewrites it. When the file exceeds
  `audit.maxSegmentMB` (default 50) the server starts a new segment (the
  rotation decision is taken under a short-lived cross-process lockfile,
  `<stateDir>/locks/audit.lock`, using the same lock helper as Phase 9)
  (`audit.jsonl.1`, `.2`, ...), leaving earlier segments untouched; readers
  (`ebrain audit tail|stats` and derived rollups) read all segments in
  numeric order. An owner-run `ebrain audit prune --older-than <days>` may
  delete whole old segments only. Several MCP processes may append to the same
  log; each line is written with a single `write` call and is capped in size
  (the `returned` list is truncated with a `returned_truncated: true` marker
  past the cap).
- Strict-scrub rejections (Phase 7) and limit rejections (Phase 9) are logged
  here by detector or limit type only.
- `docs/SETUP.md` gains an "Auditing" section.

### Acceptance Criteria

- Every call through `dispatch` for a fake tool in all three modes produces
  exactly one audit line (including one rejected for bad arguments); lines never contain fixture secrets, query
  text, or note bodies; read-tool lines carry the call's `recall_id` and the
  returned `{id, rev}` list; the file is not truncated across server restarts.
- A call passing `author` or `principal` is rejected by schema and still
  audited.
- Segment rotation: past the size threshold a new segment starts and `audit
  tail` and `audit stats` read both in order; `audit prune` deletes only whole
  old segments.
- Two concurrent processes appending past the segment threshold produce no
  torn lines and exactly one new segment.
- `bash tests/phase05.sh` passes.

## Phase 6 - MCP Server (stdio) with Read Tools

<!-- runner:model=high -->
<!-- runner:read=src/index -->
<!-- runner:read=src/mcp -->
<!-- runner:verify=bash tests/phase06.sh -->

### Requirements

- `ebrain mcp` starts an MCP server over **stdio** using the official SDK. It
  exposes exactly these tools in this phase (read tools are available in every
  mode; write tools are added by Phases 8 and 9 according to mode). Every
  handler is registered through `dispatch` (Phase 4) and calls `refreshIndex()`
  before reading.

  | Tool | Arguments |
  |---|---|
  | `search` | `query`, `limit?`, `tags?`, `folder?`, `status?` (one or many), `include_superseded?`, `include_archived?`, `as_of?`, `advanced?`, `max_chars?`, `format?` (`scope` is added in Phase 11) |
  | `read_note` | `path`, `max_chars?`, `format?` |
  | `list_notes` | `folder?`, `tag?`, `limit?`, `status?`, `include_superseded?`, `include_archived?`, `as_of?`, `max_chars?`, `format?` |
  | `related` | `path`, `limit?`, `max_chars?`, `format?` (backlinks, outgoing links, notes sharing tags; structural only) |

  `search` returns ranked results with `path`, `heading_path`, an excerpt, and a
  `citation`. Default visibility follows Phase 4 (rejected, superseded,
  archived hidden).
- **Result fields.** Every note-bearing result includes `id`, `provisional`
  (bool), `rev`, `status`, `kind`, `occurred`, `folder_class`, `path`, and
  `citation` (`note:<id>@<rev>[#heading]`). Every `search`, `related`, and
  `list_notes` response also includes a `recall_id` (ULID) identifying that
  result set.
- **Filters.** `as_of` (ISO date) evaluates **lifecycle at that time**:
  results exclude notes whose `valid_until < as_of` or `valid_from > as_of`;
  a `superseded` or `archived` note is visible at `as_of` if its
  `superseded_at`/`archived_at` is later than `as_of` (the status-based
  default hiding does not apply when `as_of` is given) and hidden otherwise.
  Without `as_of`, `superseded`/`archived` notes are hidden unless the include
  flags are set. Default `as_of` is now. `status` overrides the default
  visibility for the listed statuses. `include_expired` is added by Phase 9.
- Every read tool accepts optional `max_chars` and `format: "full"|"compact"`
  per I6; `max_chars` can only lower the configured ceiling
  (`limits.maxCharsPerCall`). Compact format returns citations plus excerpts of
  at most 200 characters.
- All tool inputs validated with a schema; `path` arguments go through
  `safe-path`. Tool errors are returned as structured MCP errors, never stack
  traces.
- Search is BM25 via FTS5 in this phase. Query input is escaped so FTS syntax
  in the query cannot error or inject operators unless a documented
  `advanced: true` flag is set.
- Server writes logs to stderr only (stdout is the protocol channel) and never
  logs note contents.
- **Packaging (required, first usable product):**
  - `ebrain init` interactively (or via flags) writes `config.json`, creates the
    state dir with correct modes, creates `_inbox/`, `_raw/`, `references/` (and
    `journal/<principal-id>/` when the mode is `journal`) in the vault if
    missing, and prints the Claude Code / Claude Desktop MCP
    snippets with absolute paths.
  - `docs/SETUP.md` covers install for one person end to end, plus a short
    section "Several people, separate brains": each person installs
    independently with their own vault and state dir; no shared server; how to
    keep vaults in sync with their own tool (Obsidian Sync, git, iCloud) and why
    the state dir (index DB) must **not** be synced. It also has a "Running on a
    Linux server" section: build toolchain prerequisites (`build-essential`,
    `python3`, `make`) for `npm run build:native`, Node plus `npm ci
    --ignore-scripts`, a dedicated OS user, state dir `0700` on a local
    filesystem (not NFS/EFS), the vault synced via git, and a note that
    Obsidian is not installed on servers.
  - A `ebrain doctor --strict` mode that fails if: network is enabled with
    non-loopback hosts, state dir permissions are loose, the vault contains a
    symlink escaping the root, or (once Phase 13 exists) auto-hooks are
    installed without `captureCheckpoints` being deliberate.
- Provide `docs/SETUP.md` snippets for Claude Code (`claude mcp add ...`) and
  Claude Desktop config using an **absolute path** to the installed `ebrain`
  entry point (absolute node binary plus absolute script path), and a warning:
  `EBRAIN_CONFIG` and the server command can be set by a project-level
  `.mcp.json`; owners should only approve project MCP servers they wrote, since
  mode and principal come from whichever config the launching client names.

### Acceptance Criteria

- An integration test spawns `ebrain mcp`, performs the MCP initialize
  handshake, lists tools (matching `expectedTools(<mode>, 6)` from the registry
  fixture for each of the three modes), and exercises each tool against the
  fixture vault.
- `read_note` with `../../etc/passwd`, an absolute path, and the escaping
  symlink all return errors and never read outside the vault.
- A fixture note containing a prompt-injection string and long backtick runs is
  returned inside a fence that cannot be closed by the content.
- Result fields are present and correct; `recall_id` is unique per call; a
  `citation` returned by `search` passes `checkNoteCitation` as `fresh`, and
  `stale` after the note is edited and refreshed.
- `as_of` fixture: a note with `valid_until` in June is returned for
  `as_of=2026-05-01` and hidden for `as_of=2026-07-01`; `superseded` and
  `archived` notes are hidden by default and shown with the include flags.
- Responses never exceed the configured size cap; `max_chars` below the cap is
  honored and `max_chars` above it is clamped (test both).
- A note added to the vault while the server is running is found by the next
  `search` without a manual reindex.
- stdout contains only protocol frames during a full session (asserted).
- With the real tools, every `tools/call` in all three modes yields exactly
  one audit line carrying the call's `recall_id` and returned `{id, rev}`
  list, and no line contains query text or note bodies.
- `ebrain init` on an empty temp dir yields a working setup that passes
  `ebrain doctor --strict`.
- `bash tests/phase06.sh` passes.

## Phase 7 - Secret and Sensitive-Data Scrubber

<!-- runner:model=high -->
<!-- runner:read=src/inbox -->
<!-- runner:verify=bash tests/phase07.sh -->

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
    above a threshold, length >= 32) with a documented, tunable threshold. The hex and entropy detectors never
    flag `0x` + 64-hex transaction hashes, 40-hex git SHAs, ULIDs, or
    well-formed citations (`thesis:`, `outcome:`, `commit:`, `note:`); a 64-hex
    string counts as a private key only within a short window of a key-context
    word (`private`, `secret`, `priv`, `seed`, `mnemonic`, `key=`).
- `scrub.extraPatterns` from config adds user **literal strings** (case-
  sensitive, length-limited, count-limited). Arbitrary user regexes are out of
  scope for v1: synchronous JavaScript regexes cannot be interrupted, so a
  timeout guard is not implementable without a worker or an RE2 dependency.
- Expose `ebrain scrub <file|->` for manual use and export a `scrub` entry
  point plus a `scrubVersion` constant. Writers (Phase 8 `capture`, Phase 9
  journal, Phases 10 and 13) call it before persisting and stamp
  `scrubVersion` into frontmatter.
- Fail-safe: if scrubbing throws, the write is aborted (never write unscrubbed
  text).
- **Strict mode for agent principals.** When `principal.type` is `agent`,
  detections from any credential-class detector (PEM/OpenSSH private keys,
  WIF keys, 64-hex keys in private-key context, BIP39 mnemonics, provider API
  keys and tokens, JWTs, `Bearer` tokens, password assignments, and URLs with
  embedded credentials) cause the **entire write to be rejected** (error returned,
  nothing stored) instead of redacting-and-continuing, and the rejection is
  recorded by detector type only (in the audit log, Phase 5; callers pass the rejection to `dispatch`). Public addresses (for example
  `0x` + 40 hex) are not secrets and are preserved. PII-class detectors (cards,
  SSN, IBAN, routing/account) and the high-entropy heuristic redact and
  continue even for agents.

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
- In strict mode (`principal.type: agent`), `scrub` rejects a fake private
  key, a fake BIP39 mnemonic, or a fake API key whole and returns a rejection
  naming only the detector type; a public `0x` address in an otherwise clean
  text is preserved. (End-to-end write tests are in Phases 8 and 9.)
- `ebrain scrub` on a fixture file redacts fake secrets and prints finding
  counts only.

- Transaction hashes, git SHAs, ULIDs, and citation strings in agent journal
  text are preserved; a 64-hex string next to the word `private key` is not.
- `bash tests/phase07.sh` passes.

## Phase 8 - Inbox: Capture and Human Review Gate

<!-- runner:model=high -->
<!-- runner:read=src/mcp -->
<!-- runner:verify=bash tests/phase08.sh -->

### Requirements

- Add MCP tools, registered **only when `mode` is `inbox`** (they do not exist
  in `journal` or `read-only` mode; asserted by a tool-list test per mode):
  - `capture({ title, body, kind?, sources? })` -> creates
    `_inbox/<yyyymmdd-hhmmss>-<slug>.md` with frontmatter
    `status: proposed`, `kind` (`fact|decision|preference|idea|lesson|reference`),
    `created`, `origin: mcp`, `author` (the configured `principal.id`), and
    `sources` (list of source identifiers). The body passes through the Phase 7 scrubber (strict rules when the
    principal is an agent) before anything is written, and `scrubVersion` is
    stamped into the frontmatter. Atomic create-only write (temp file, then `link` to the final name or `O_EXCL`; never `rename` over an existing name), mode `0600`, followed by `refreshIndex()`.
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
    Destination rules: `--to` is resolved through `safe-path` and must be
    inside the vault; it may not be (or be under) `_inbox/`, `journal/`,
    `_raw/`, `_archive/`, or a dot-directory. The destination file is created
    with `createExclusive` (never overwrites; on a name collision the slug gets
    a numeric suffix). Crash ordering: write the destination first, then
    unlink the source; if both exist after a crash, re-running `accept` (same
    id) completes by unlinking the source, and `ebrain doctor` reports the
    duplicate id until then. `accept` and `reject` rewrite only a note the
    model itself proposed, so they are exempt from the undo store (the
    cognition spec's Phase 1 covers rewrites of curated notes). Accepting
    changes the note's `rev`, so citations pinned to the proposed rev become
    `stale` by design.
  - `ebrain inbox reject <id> [--reason ...]` -> moves to `_inbox/_rejected/`
    (kept, not deleted) with `status: rejected`.
- Acceptance by moving a file out of `_inbox/` manually in Obsidian is also
  valid: the next `reindex` treats any note outside `_inbox/` as permanent
  regardless of its `status` field.
- Inbox notes are searchable but ranked below permanent notes (tier T2 in
  `rank.ts`, registered here; `_inbox/_rejected/` and `_inbox/_applied/` are
  hidden from `list_inbox` and default search) and clearly labeled `proposed` in results so Claude
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
- The MCP tool list in each mode matches `expectedTools(<mode>, 8)` from
  `tests/fixtures/tools-by-mode.json` (updated here: `inbox` gains `capture` and `list_inbox`). There is no
  accept/delete/move/overwrite tool in any mode (asserted).
- Accept/reject CLI commands produce the specified file moves and frontmatter
  changes and preserve the note `id`; vault files outside `_inbox/` are
  unchanged by `capture`.
- `accept --to` with `_inbox/`, `journal/x`, `../x`, and an existing
  destination name is refused or suffixed per the rules; a simulated crash
  between destination write and source unlink is recovered by re-running
  `accept`.
- `capture` with a body containing a fake API key stores `[REDACTED:...]` in
  the inbox file (human principal); with `principal.type: agent` (inbox mode)
  a fake private key, mnemonic, or API key rejects the whole `capture` and
  stores nothing.
- `bash tests/phase08.sh` passes.

## Phase 9 - Agent Principals: Journal Mode and Workspace Import

<!-- runner:model=high -->
<!-- runner:read=src/mcp -->
<!-- runner:read=src/scrub -->
<!-- runner:verify=bash tests/phase09.sh -->

Depends on Phases 1-8 (strict agent scrubbing from Phase 7, audit from Phase
5). Does not depend on Phase 15 (agents may use stdio, with each agent process
launching its own `ebrain mcp` with its own config).

### Requirements

- **Journal mode** (`mode: "journal"`, `principal.type: "agent"` only). Adds
  MCP tools, registered only in this mode:
  - `journal_append({ title, body, kind?, sources?, untrusted_origin? })` ->
    creates a new file `journal/<principal-id>/<yyyy>/<yyyymmdd-hhmmss>-<slug>.md`
    with frontmatter: `id`, `schema: 1`, `author`, `origin: mcp`, `created`, `kind`
    (`log|observation|lesson|decision|todo`), `sources`, `untrusted_origin`,
    `status: journal`, `expires` (from `journal.ttlDays`, default 90), and
    `scrubVersion`. **Create-only is enforced by the filesystem:** write a temp
    file, then publish it with `link(tmp, final)` (fails with EEXIST rather than
    overwriting) and unlink the temp, or open the final name with `O_EXCL`;
    never `rename` over an existing name. Never overwrites or edits an existing
    file; mode `0600`. Daily file consolidation is not performed; one entry is
    one file. After a successful create, call `refreshIndex()`.
  - `journal_list({ since?, kind?, limit?, max_chars?, format? })`.
  - `include_expired` is added to `search` and `list_notes` in this mode.
  - Strict scrubbing per Phase 7 applies to every write.
- **Rate and size limits** (configurable, enforced server-side, rejecting not
  truncating): `journal.maxEntryChars` (default 4,000), `journal.maxEntriesPerHour`
  (default 60), `journal.maxTotalMB` (default 100). Counts and sizes are
  computed from the journal directory on the filesystem (timestamps in file
  names and `stat` sizes), not from the index or the audit log. The whole
  check-and-create sequence (limits, dedup, create) runs under one
  cross-process lock, `<stateDir>/locks/journal-<principal-id>.lock` (an
  `O_EXCL` lockfile holding pid and timestamp, with stale-lock recovery after
  60 seconds and a bounded wait), so limits hold exactly with several MCP
  processes and a stale index. Exceeding a limit returns
  a structured error and is audited.
- **Dedup:** an entry whose normalized body hash matches an entry created by
  the same principal in the last 24h (found by reading the last 24h of that
  principal's journal files, not the index) is rejected as a duplicate
  (returns the existing entry's path).
- **Ranking and labeling:** journal entries are indexed and searchable; they
  occupy tiers T3 to T5 of the Phase 4 table (cited lesson > uncited lesson >
  other journal entries), below curated notes and inbox notes. Results are
  labeled `agent-journal` and, where present, `untrusted_origin`. "Well-formed
  citation" means a `sources` entry of kind `thesis`, `outcome`, `commit`, or
  `note` that parses with `parseCitation` (Phase 3). Citation *resolution*
  against external evidence is not verified by this ticket (see the cognition
  spec). Register the T3 to T5 rows in `rank.ts` with tests.
- **Expiry:** `ebrain journal prune` (owner CLI, not MCP) lists/archives
  entries past `expires` into `journal/_archive/<principal-id>/` (keeping the `<yyyy>/` subpath, so
  principals never mix and names never collide); it never deletes. Search
  ignores expired entries unless `include_expired` is set.
- **Workspace import:** `ebrain import agent-workspace <dir> --principal <id>` (the id must equal the
  configured principal, else refuse)
  imports an existing agent workspace (`MEMORY.md`, `memory/YYYY-MM-DD.md`,
  `GOALS.md`, and optionally `SOUL.md`/`TOOLS.md` as `kind: reference`) into
  `journal/<principal-id>/imported/`, scrubbed under strict agent rules
  (files that trip a strict detector are skipped whole and listed in the
  summary). The source directory is read through `openExternalFile`
  (read-only, never modified); idempotent by content hash.
- `docs/SETUP.md` gains an "Agents" section: example MCP client entries giving
  an agent three servers (private `journal` brain, shared playbook
  `read-only` brain, team `inbox` brain), the per-call budget settings
  suited to a ~1,000-token heartbeat (`limits.maxCharsPerCall`, compact format),
  and the recommendation to keep each agent vault in git.

### Acceptance Criteria

- Tool-list tests per mode match `expectedTools(<mode>, 9)` from the registry
  fixture (`journal` gains `journal_append` and `journal_list`); no mode exposes
  accept, promote, edit, delete, move, or job-starting tools.
- `journal_append` cannot create files outside
  `journal/<principal-id>/` (hostile title/slug/principal-id fixtures), cannot
  overwrite or append to an existing entry (including under a race: two
  concurrent appends to the same target name produce one file and one error),
  and ignores any caller-supplied `author`/`principal`.
- Strict scrubbing: a fake private key, fake mnemonic, or fake API key causes
  the whole append to be rejected and stores nothing; an ordinary public
  address and a `0x` transaction hash are preserved.
- Rate, size, total-size, and duplicate limits reject as specified, hold with
  two concurrent server processes on one journal, and are recorded in the audit
  log.
- A freshly appended entry is returned by `search` immediately (no manual
  reindex).
- Ranking test on a fixture: curated note > inbox note > cited journal
  lesson > uncited journal lesson > other journal entries; `untrusted_origin`
  is visible in results.
- `journal prune` archives expired entries, never deletes, and search hides
  them by default.
- `import agent-workspace` on a fixture resembling `agents/workspace`
  (`MEMORY.md`, daily notes, `GOALS.md`) is idempotent, leaves the source
  directory unchanged (checksum), and skips a file containing a fake private
  key whole.
- Two agent instances with different principals and vaults cannot read each
  other's journals (two temp vaults and state dirs).
- `bash tests/phase09.sh` passes.

## Phase 10 - Conversation Importers and Raw Archive

<!-- runner:model=high -->
<!-- runner:read=src/scrub -->
<!-- runner:verify=bash tests/phase10.sh -->

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
  ranked below curated notes (tier T6 in `rank.ts`, registered here). They are never
  treated as established facts. Archive-file `id`s are stable functions of
  source + conversation id so re-imports keep identity.
- Idempotent: re-importing the same export produces no duplicates (stable id
  derived from source + conversation id). Updated conversations replace their
  archive file atomically.
- `--dry-run` prints counts (conversations, turns, findings by scrub type)
  without writing.
- Scrubbing is mandatory and not optional via flag. Conversation importers
  require a `human` principal and refuse to run for an `agent` principal
  (agent history goes through `import agent-workspace`). Source directories
  and archives are read through `openExternalFile` / `resolveInRoot` with the
  named root.
- Dependencies: choose the zip reader here (candidate: `yauzl`, which streams
  and exposes per-entry sizes), pinned and justified in `docs/DEPENDENCIES.md`
  with its transitive count. Phase 11 reuses it. Raw archives hold full
  scrubbed conversations inside the vault; `docs/SETUP.md` warns that if the
  vault is synced or in git, so are they.

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
- `bash tests/phase10.sh` passes.

## Phase 11 - Reference Library (Books) with Citations

<!-- runner:model=high -->
<!-- runner:read=src/index -->
<!-- runner:verify=bash tests/phase11.sh -->

### Requirements

- `ebrain refs add <file> [--title ... --author ...]` supports `.epub`,
  `.md`, and `.txt`. PDF support is via the optional external `pdftotext`
  binary called with an argument array (never a shell string), a timeout, and
  an output size cap; if the binary is absent, PDFs are rejected with a clear
  message. No PDF parsing library in v1.
- EPUB: read the zip safely (same limits as Phase 10), follow the OPF spine
  order, convert XHTML to text (strip scripts/styles; no external fetches),
  and split into chapters by navigation/headings.
- **Book text is stored only in a separate derived database,
  `<stateDir>/refs.db`** (not `index.db`, so I7 holds for the note index), not
  in the vault, in a `refs_chunks` table keyed by `(ref_id, chapter, ordinal)` along
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
  the owner's vault note), `ebrain refs reindex` (rebuilds `refs.db` from the original source files; sources that moved are reported missing; `ebrain reindex` never touches `refs.db`).
- Chunking preserves chapter and heading metadata for citation. `read_ref_chunk`
  is a read tool and is added to every mode in the tool registry fixture (`phase: 11`). `ref_id` is a stable function of the source file's SHA-256. Source files are read through `openExternalFile`.
- Dependencies: choose the XHTML text extractor here (a small pinned parser such as `htmlparser2`, or a minimal in-repo tokenizer), justified in `docs/DEPENDENCIES.md`.

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
- Deleting `index.db` and running `reindex --full` leaves `refs.db` intact; deleting `refs.db` and running `ebrain refs reindex` restores it.
- `bash tests/phase11.sh` passes.

## Phase 12 - Optional Local Embeddings and Hybrid Search

<!-- runner:model=default -->
<!-- runner:read=src/index -->
<!-- runner:verify=bash tests/phase12.sh -->

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
- `bash tests/phase12.sh` passes.

## Phase 13 - Claude Code Hooks: Session Brief and Checkpoints

<!-- runner:model=default -->
<!-- runner:read=src/inbox -->
<!-- runner:verify=bash tests/phase13.sh -->

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
  entries are untouched. The installed command is `<absolute node binary> <absolute path to the built ebrain entry script>`, so nothing depends on PATH or on a shebang's `env`. No `uvx`/`npx`/PATH search fallbacks.
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
- The generated hook command has an absolute node path and an absolute script path (asserted).
- `bash tests/phase13.sh` passes.

## Phase 14 - Candidate Note Proposals from Archives (Pluggable, Off by Default)

<!-- runner:model=high -->
<!-- runner:read=src/import -->
<!-- runner:verify=bash tests/phase14.sh -->

### Requirements

The cognition spec requires this phase (its `src/llm/` layer).

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
    local model (Ollama, llama.cpp). Same network rules as Phase 12.
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
- `bash tests/phase14.sh` passes.

## Phase 15 - Optional Loopback HTTP Transport

<!-- runner:model=default -->
<!-- runner:read=src/mcp -->
<!-- runner:verify=bash tests/phase15.sh -->

### Requirements

- **Optional HTTP transport (off by default):** `ebrain mcp --http` (server code in `src/net/`) serves MCP
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

- `ebrain mcp --http` refuses `0.0.0.0` and non-loopback hosts; rejects missing,
  wrong, and malformed tokens; accepts the valid token; the token is not stored
  in plaintext (grep test of the state dir).
- Two simultaneous instances with different `EBRAIN_CONFIG` files and vaults
  cannot read each other's data (test using two temp vaults and state dirs).
- The source-scan tests for I3 and I4 still pass over the full tree.
- `bash tests/phase15.sh` passes.

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
- Whether to replace `better-sqlite3` with built-in `node:sqlite` (requires
  Node >= 24 for no-flag use) to drop the native-build step. Default: keep
  `better-sqlite3`.
- Remote access for web/mobile Claude (hosted per-person instances with OAuth)
  is deliberately deferred to a separate security-reviewed ticket.
