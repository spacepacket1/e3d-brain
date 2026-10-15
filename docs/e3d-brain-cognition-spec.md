# Feature Ticket: e3d-brain Cognition (consolidate, supersede, forget, reflect, feedback)

Follow-up to `docs/e3d-brain-spec.md` (the **memory layer**, phases 1-15).
The foundations this ticket first exposed as gaps (identity, revisions,
citations, lifecycle, time, ranking, recall ids, shared LLM layer) have been
**folded into the memory-layer spec**; the table below records where.
The memory layer stores, retrieves, curates, and audits. This ticket adds the
**cognition layer**: owner-triggered jobs that read a brain and produce
**proposals**. Nothing in this ticket silently changes curated memory.

## Overview

A filing cabinet becomes a brain when it can notice duplicates, notice that an
old decision was replaced, forget what no longer matters, learn from outcomes,
and know what it lacks. Each of those is a job in this ticket:

| Job | Question it answers | Output (always a proposal) |
|---|---|---|
| `supersede` | "Did a newer decision/fact replace an older one?" | mark-superseded proposal citing both |
| `consolidate` | "Which notes are duplicates or one idea in pieces?" | merge / summary proposal, sources kept |
| `forget` | "What has gone stale and unused?" | demote/archive proposal (never delete) |
| `reflect` | "What did outcomes teach us?" | lesson proposal with resolvable citations |
| `feedback` | "Which memories actually helped?" | observed counters (not proposals) |
| `gaps` | "What do we keep asking about and know little of?" | gap report |

This ticket also exists to **pressure-test the memory-layer spec**. Designing
these jobs exposed gaps in it (next section). Those that belong in the
memory layer were folded into `e3d-brain-spec.md`; the rest are handled here.

### Principles carried over (must not be weakened)

- Structure and provenance are earned from evidence. Model inference only
  produces **citable proposals**, never silent facts (see e3d-pilot provenance
  graph decision).
- **No model-assigned confidence or relevance scores are stored as facts.**
  Every proposal has `confidence: unrated`. Usefulness is *observed counts*.
- Memory is **advisory, never authority**. Cognition output must not create any
  path by which memory authorizes spending, signing, publishing, or external
  action.
- Everything is local-first. No network except loopback or
  `network.allowedHosts`, and cloud LLM use requires the explicit
  data-leaves-machine flag defined in the memory-layer spec (Phase 14).

## Gaps Exposed in the Memory-Layer Spec

Each gap below was found by working out what a cognition job would need.
"Where" says where it is handled. **Folded** means it now lives in the
memory-layer spec (`e3d-brain-spec.md`) and this ticket relies on it.

| # | Gap in `e3d-brain-spec.md` | Why cognition needs it | Where |
|---|---|---|---|
| G1 | **No stable note identity.** Notes are addressed by path; paths change on accept (inbox -> folder), rename, and move in Obsidian. | Proposals and citations must survive moves. | Folded: memory Phases 3, 8, 9, 10 (`ebrain ids assign` with undo stays here, Phase 1) |
| G2 | **No revision identity in tool results.** Index stores a content hash but tools don't expose it; citations rot silently when a note is edited. | Citations must pin a revision and be checkable for staleness; accept must detect "note changed since proposal". | Folded: memory Phases 3 (`src/cite/`), 6 |
| G3 | **No lifecycle states beyond proposed/accepted/rejected/journal.** | `superseded`, `archived`, `stale`, `pinned` are needed, with defined ranking effects. | Folded: memory Note schema, Phases 2, 4 |
| G4 | **No time semantics.** Only `created`. Imported conversations and human notes need *occurred* vs *recorded*; supersession needs `valid_from/valid_until` and `as_of` queries. | Temporal reasoning. | Folded: memory Note schema, Phases 2, 6, 10 |
| G5 | **Ranking is scattered** across memory Phases 4, 8, 9, and 11 with no single scoring function. Cognition adds more tiers. | One documented, tested ranking function. | Folded: memory Phase 4 (`rank.ts`), I13 |
| G6 | **Accept only moves a file.** Proposals include merge/supersede/archive, which *edit existing notes*. | Review queue with typed, previewable, undoable apply actions. | Phase 2 |
| G7 | **Inbox is described as MCP-written; CLI-produced proposals are unspecified**, and `journal`/`read-only` instances have no sanctioned place for proposals. | Cognition runs from the owner CLI in *any* mode and writes to `_inbox/`. Mode governs MCP only. | Folded: memory I2 scope note, Phase 8 |
| G8 | **LLM provider layer lives inside `propose` (memory-spec Phase 14).** | Shared `src/llm/` for all jobs; budgets; prompt versioning. | Folded: memory Phase 14 (`src/llm/`); budgets/prompt versioning extended in Phase 2 here |
| G9 | **Determinism (I11) covers only the index.** LLM jobs aren't deterministic. | Run records + idempotent proposal ids instead. | Phase 2 |
| G10 | **No rejection memory.** Rejected inbox items are kept but never used to suppress repeats. | Stop re-proposing what the owner rejected. | Phase 2 |
| G11 | **No job concept / no rule on who may trigger expensive work.** | Jobs are owner-triggered CLI only; no MCP tool may start one. | Phase 2 |
| G12 | **Citations are free strings; memory Phase 9 explicitly does not resolve them.** No external evidence concept. | `reflect` needs resolvable `thesis:`/`outcome:` evidence. | Phase 3 |
| G13 | **No near-duplicate detection without embeddings** (embeddings are optional and off by default). | Deterministic dedup that works with BM25-only brains. | Phase 5 |
| G14 | **Audit log records result *counts*, not which notes were returned**, and nothing links recall -> use -> outcome. | Recall stats (`forget`), usefulness feedback. | Folded: memory Phase 6 (`recall_id`), Phase 5 (audit `returned`) |
| G15 | **I2 fences vault writes only; local state writes (usage events) are unspecified**, and there is no feedback tool. | Define a minimal, labeled state-dir event write allowed in every mode. | Folded: memory I2 scope note; `report_use` tool in Phase 8 here |
| G16 | **Search results lack `id`, `rev`, `status`, `occurred`**, and have no `as_of`, `status`, or `include_superseded` filters. | Agents/humans must see lifecycle and time. | Folded: memory Phase 6 |
| G17 | **No revision history**, so replay evaluation ("what would the brain have proposed in March?") is impossible unless the vault is in git. | Honest evaluation. | Phase 9 |
| G18 | **No query log**, so "what do we ask about and not find?" can't be answered. | `gaps`. Opt-in, scrubbed, retention-limited. | Phase 8 |
| G19 | **No cross-brain flow.** An agent's private-brain lesson may be worth proposing to a team brain; isolation forbids direct writes. | One-way, owner-run `publish` to another brain's `_inbox/`. | Out of scope; listed under Open Questions |
| G20 | **No concurrency rules** between server writes, CLI jobs, and a human editing in Obsidian. | Revision-checked, atomic, backed-up apply. | Phase 2 |
| G21 | **No note-to-note citation index**; "not cited by any accepted note" (forget) and impact checks (supersede) would need full scans. | Cheap "who cites this?" queries. | Folded: memory Phase 3 (`cites` table) |
| G22 | **Audit log grows without bound** yet is "never truncated"; rollups depend on it. | Segment rotation; rollups read all segments. | Folded: memory Phase 5 |
| G23 | **Every phase hardcoded its own expected MCP tool list**, which breaks as phases add tools (`read_ref_chunk`, `report_use`). | One tool-registry fixture per mode. | Folded: memory Phase 4 (`tools-by-mode.json`) |

## Goals

- Six owner-triggered jobs, each producing reviewable, citation-backed
  proposals (or observed counters), never silent edits.
- A review queue where a human can preview a diff, accept (applies the change
  atomically with a revision check and an undo), edit, or reject (remembered).
- Outcome-grounded learning for agents via resolvable citations to real
  evidence records (theses, outcomes) supplied as local files.
- Measurable value: every job reports acceptance rate, and replay evaluation is
  available when the vault is git-backed.

## Non-Goals

- No autonomous application of any proposal. No auto-accept, no auto-promote.
- No MCP tool that starts a cognition job, accepts a proposal, or edits a
  curated note. (A recording tool for usage feedback is allowed; see Phase 8.)
- No model-assigned confidence, relevance, or importance scores.
- No deletion of notes by any job. Archive and supersede only.
- No cross-brain writes (see G19 / Open Questions).
- No network access to E3D services in v1; evidence arrives as local files.
- No embeddings requirement. Embedding-based features degrade to deterministic
  or LLM-adjudicated alternatives when embeddings are off.

## Shared Constraints (cognition invariants)

These are in addition to I1-I13 of the memory-layer spec and are tested.

- **C1 Proposals only.** A job's only vault writes are new files in `_inbox/`.
  Its only other writes are to `<stateDir>` (run records, counters, caches).
- **C2 Owner-triggered.** Jobs start only from the `ebrain cognition ...` CLI
  (or an owner-configured cron calling it). No MCP tool starts a job.
- **C3 Citations are revision-pinned and use assigned ids.** Every proposal
  lists `evidence` as citations in the memory-layer grammar (`note:<id>@<rev>`,
  `thesis:<id>`, `outcome:<id>`, ...) and `targets` as `{id, rev,
  path_at_proposal}`. A proposal whose cited revisions have changed is marked
  `stale` and cannot be applied without re-running the job. **Jobs only
  target or cite notes that have an assigned `id`**; notes with only a
  provisional id are skipped and counted, and the run summary tells the owner
  to run `ebrain ids assign`.
- **C4 No scores as facts.** `confidence: unrated` on every proposal. Counters
  are integers of observed events only.
- **C5 Idempotent and suppressing.** Proposal ids are stable functions of
  (job, sorted evidence ids+revs, proposal type). Re-running creates nothing
  new; previously rejected proposals are not re-proposed unless the owner
  passes `--reconsider`.
- **C6 Budgeted.** Each run has hard caps (`maxLlmCalls`, `maxInputChars`,
  `maxProposals`); exceeding a cap stops the run cleanly with a partial,
  well-formed result and a recorded reason.
- **C7 Scrub in, scrub out.** All text sent to a model and all text written
  into a proposal passes the scrubber (strict rules for agent brains).
- **C8 Taint propagates.** A proposal derived from any `untrusted_origin: true`
  source carries `untrusted_origin: true` and `taint_sources`, and the review
  UI shows it prominently.
- **C9 Safe apply.** Applying a proposal is performed by the owner CLI only,
  as a crash-safe transaction, with the previous contents saved in the Phase 1
  undo store so `ebrain review undo <proposal-id>` restores them. Protocol,
  under the `src/lock.ts` lock `<stateDir>/locks/apply.lock`: (1) validate the
  proposal (authenticated against its run record, Phase 2) and every target;
  (2) write the undo transaction manifest with status `pending` and the full
  list of planned ops; (3) for each op, re-check the target's **raw SHA-256**
  (of the file bytes; `rev` is for citation freshness only) immediately before
  publishing, then publish with `writeAtomic` / `createExclusive` /
  `renameSafe`; (4) mark the manifest `committed`; (5) only then finalize the
  proposal (status `accepted`, `applied`, move to `_inbox/_applied/`). A crash
  leaves a `pending` manifest; `ebrain review recover` (also run
  automatically at the start of the next apply) rolls back every op the
  manifest records as done. A proposal stays `proposed` until step 5.
- **C10 Never delete.** No job and no apply action removes a note; archive
  moves to `_archive/` and supersede sets frontmatter. **Archive is defined
  once:** set `status: archived` and `archived_at`, and move the file to
  `_archive/<original-relative-path>`, except journal entries, which move to
  `journal/_archive/<principal-id>/<path-after-the-principal-dir>` (the memory
  layer's journal archive, shared with `ebrain journal prune`). A destination
  name collision is resolved with `createExclusive` and a numeric suffix,
  recorded in the manifest. The note keeps its `id`. **Undo exception:** undo
  may remove a file that the same operation created (it never removes any
  other file); that is not a deletion in the sense of this rule.
- **C11 Mode-independent CLI.** Because jobs are CLI-only (C2), they work in
  any instance mode (`inbox`, `journal`, `read-only`); mode constrains MCP
  only.

### Stack additions

- Same stack as the memory-layer spec. New source dirs: `src/cognition/`,
  `src/llm/`, `src/evidence/`, `src/review/`.
- No new heavyweight dependencies. Near-duplicate detection is implemented
  in-repo (shingling + minhash/simhash). Any new dependency needs a line in
  `docs/DEPENDENCIES.md`.

## Running This Spec

Prerequisite: memory-layer Phases 1-9 and 14 implemented (they now include
identity, revisions, citations, lifecycle, time, ranking, and recall ids).
Run with `spec2code` (`--provider claude`). Phases 1-3 are required
foundations here. Phases 4, 5, and 6 are jobs built in that order (Phase 6,
`reflect`, depends on Phase 4's supersede-style proposals). Phase 7 (`forget`)
needs only Phase 1's recall record; Phase 8 adds usage signals that `forget`
then also consults. Phase numbers are the build order. Threshold defaults are
config keys with documented defaults, and every job's tests use a fixture
corpus of at least 20 positive and 20 negative cases.

```bash
spec2code docs/e3d-brain-cognition-spec.md --preflight --provider claude
spec2code docs/e3d-brain-cognition-spec.md all --from 1 --to 3 --provider claude
```

## Phase 1 - Undo Store and ID Assignment

<!-- runner:model=high -->
<!-- runner:read=src/index -->
<!-- runner:read=src/cite -->
<!-- runner:verify=bash tests/cog-phase01.sh -->

Completes G1 (the owner-run id assignment) and builds the undo mechanism (C9)
that every later phase reuses. The other foundations (identity, revisions,
citations, lifecycle, time, ranking, recall ids) already exist in the
memory-layer spec.

### Requirements

- **Undo store** (`src/undo/`): before any owner-run command rewrites existing
  vault files (memory-layer `inbox accept/reject` are exempt: they only rewrite notes the model itself proposed), it saves the originals under
  `<stateDir>/undo/<operation-id>/` (preserving relative paths, mode `0600`;
  stored in the private state directory so it never pollutes the vault, git
  history, or sync) and writes a manifest `{operation-id, created, status:
  pending|committed|rolled_back, ops:[{type: rewrite|create|move, path, from?,
  sha256_before?, sha256_after}]}`. `rewrite` saves the original bytes;
  `create` has no original; `move` records source and destination. Hashes are
  raw SHA-256 of file bytes. `restore(operation-id)` verifies every op's
  *current* state equals `sha256_after` and refuses otherwise (the note was
  edited since), then reverses the ops atomically: rewrite restores bytes,
  create removes the created file (the C10 undo exception), move moves back. Undo is therefore machine-local;
  `docs/SETUP.md` says so. All paths go through `safe-path` (I1).
- **`ebrain ids assign [--folder <f>] [--dry-run]`:** owner CLI only. Adds a
  ULID `id:` (and `schema: 1` if absent) to notes lacking an `id`, preserving
  all other frontmatter keys and body bytes exactly. The index records the
  old provisional id as an alias of the new id for as long as the index is not
  fully rebuilt (best effort; long-term citations should use assigned ids, and
  jobs only use assigned ids per C3). Each file is a `rewrite` op; the whole run is one undo operation.
- **`ebrain undo <operation-id>`** and `ebrain undo --list`.
- **Recall record.** Extend the memory-layer `dispatch` so that every read
  tool call also appends `{recall_id, ts, principal, ids: [{id, rev}]}` (at
  most 500 ids per record, newest results first) to `<stateDir>/recalls.jsonl`
  (`0600`, state dir only). The audit log is unchanged (its `returned` list may
  be truncated); `forget` (Phase 7) and `report_use` (Phase 8) read
  `recalls.jsonl`, never the truncated audit list. Retention
  (`recallLog.retentionDays`, default 180) is enforced by an owner CLI prune.
- Pinned handling: `pinned: true` is respected as a flag only (no behavior
  here); later jobs consult it.

### Acceptance Criteria

- `ids assign --dry-run` changes nothing; a real run adds ids only to notes
  lacking them, leaves body bytes and other frontmatter unchanged, and
  `undo` restores originals byte-for-byte.
- After assignment, the old provisional id resolves as an alias until a full
  rebuild.
- `undo` refuses when any affected file was edited after the operation.
- Hostile operation ids and paths (`../`, absolute, symlink escape) are
  rejected.
- Undo data lives only under `<stateDir>/undo/` (scan test: no
  `.ebrain-undo` directory is ever created in the vault).
- `bash tests/cog-phase01.sh` passes.

## Phase 2 - Job Framework, Proposal Schema, and Review Queue

<!-- runner:model=high -->
<!-- runner:read=src/inbox -->
<!-- runner:read=src/cite -->
<!-- runner:verify=bash tests/cog-phase02.sh -->

Fixes G6, G9, G10, G11, G20 (G7 and G8 are folded into the memory layer).

### Requirements

- **Shared LLM layer (G8, partly folded).** The memory-layer spec already
  places providers in `src/llm/` (`none`, `openai-compatible` loopback by
  default, `anthropic` behind the allowlist and
  `--i-understand-data-leaves-machine`). Extend it with: run-level budgets
  (C6), versioned prompt files under
  `src/cognition/prompts/<job>.<version>.md`, strict output schemas with
  validation (invalid items dropped and counted), and request inputs recorded
  as hashes. `propose` keeps working unchanged.
- **Run framework (G9, G11).** `ebrain cognition run <job> [--since ...]
  [--max-proposals N] [--dry-run] [--reconsider]` and `ebrain cognition runs`.
  Each run writes `<stateDir>/runs/<run-id>.json`: job, versions, provider and
  model (if any), budget settings, input note ids+revs (hashes), counts by
  outcome, stop reason, and proposal ids with each proposal's immutable-field digest. Runs refuse to start if another run
  of the same job holds a lock (`src/lock.ts`). Writes to `rejections.json` and
  `usage.jsonl` also go through that helper. No MCP tool starts or schedules jobs; a
  test asserts no MCP tool starts a job, reviews, accepts, or applies a proposal
  in any mode (the only cognition-related MCP tool is the read-side
  `report_use` added in Phase 8).
- **Proposal schema (G6).** Proposals are Markdown files in `_inbox/` with
  frontmatter:

  ```yaml
  id: <ULID>
  status: proposed
  kind: proposal
  proposal_type: merge | supersede | summary | archive | demote | lesson | gap
  job: supersede
  job_version: 1
  created: <ts>
  author: ebrain-<job>        # job identity; origin below marks CLI-produced
  origin: cli
  targets: [{id: ..., rev: ..., path_at_proposal: ...}]
  evidence: [<citation>, ...]
  untrusted_origin: false
  taint_sources: []
  confidence: unrated
  proposal_key: <stable hash per C5>
  ```

  The body holds a human-readable rationale, a **machine-applicable change
  block** written in a **closed grammar of typed ops**, each referencing a
  `target` listed in the proposal's `targets`: `set_frontmatter {target, key,
  value}` (key from an allowlist: `status`, `superseded_by`, `superseded_at`,
  `supersedes`, `valid_until`, `archived_at`, `merged_into`), `create_note
  {path, content}`, `move_note {target, to}` (destination only per the C10
  archive rule or `lessons/<principal-id>/`), and `append_section {target,
  text}`. Paths go through `safe-path`; an op outside the grammar or outside
  its proposal type's allowed ops invalidates the proposal. The change block
  is documented and
  schema-validated; it is also (exact frontmatter edits and/or new-file content), and a rendered
  preview. Proposals are written by the CLI in **any mode** (G7); the existing
  rule "MCP writes only per mode" is unchanged.
- **Review queue (G6, G20).** `ebrain review list|show|diff|accept|edit|
  reject|undo`:
  - `show`/`diff` render the exact change against current note contents.
  - `accept` applies the change block per C9: check every target's `rev`
    still matches (else mark proposal `stale` and refuse), save originals in
    the undo store (Phase 1), apply atomically, set proposal `status: accepted` and
    `applied: <ts>`, and move it to `_inbox/_applied/`.
    - `edit` opens `$EDITOR` on the proposal body/change block, re-validates the
    schema, and keeps it proposed. `targets`, `evidence`, `proposal_key`,
    `proposal_type`, `job`, and the op targets are **immutable**: their digest
    is recorded in the run record, and `accept` refuses a proposal whose
    immutable fields differ (reject and re-run instead). Prose and
    `create_note` content may be edited.
  - **Authentication.** `accept` applies only proposals whose id and immutable
    digest appear in a run record under `<stateDir>/runs/`; frontmatter
    claims (`origin: cli`, `author: ebrain-*`, `kind: proposal`) are never
    trusted on their own. `capture` and `journal_append` reject any attempt to
    set those fields (tests).
  - `reject --reason` moves to `_inbox/_rejected/` and records the
    `proposal_key` in `<stateDir>/rejections.json`.
  - `undo <id>` restores the saved originals if the current revs match what
    apply produced; otherwise refuses and explains.
  - Memory-layer `ebrain inbox accept/reject` for ordinary notes keep working
    unchanged; `review` is the superset for typed proposals.
- **Rejection memory (G10).** Jobs consult `rejections.json` and skip proposals
  whose `proposal_key` was rejected, unless `--reconsider`. Counted in the run
  record.
- **Flood control.** `inbox.maxPendingProposals` (default 50): a job stops
  creating proposals once the pending count is reached and reports it.
  Proposals are ordered by a deterministic priority (job-specific rule
  documented in each phase), not by model score.
- **Apply safety (C9, G20).** Concurrent-edit test: if a target note is
  modified between `show` and `accept`, accept refuses.

### Acceptance Criteria

- A fixture job (a trivial built-in `selftest` job) creates proposals,
  re-running creates none, rejecting one then re-running does not recreate it,
  and `--reconsider` does.
- `accept` of a `selftest` edit proposal applies the change atomically; `undo`
  restores byte-identical originals; editing the target between preview and
  accept makes accept refuse with a `stale` result.
- Run records contain no note bodies, no query text, and no secrets (scan
  test); LLM request logs contain hashes only.
- With a mock OpenAI-compatible server, an invalid-schema model response is
  dropped and counted, not fatal. Budget caps stop a run cleanly.
- MCP tool-list tests per mode (against `tests/fixtures/tools-by-mode.json`)
  show no job, review, or accept tools.
- `propose` regression tests from the memory-layer spec still pass.
- Apply/undo reuse the Phase 1 undo store (no second implementation; scan test).
- `bash tests/cog-phase02.sh` passes.

## Phase 3 - Evidence Sources and Citation Resolution

<!-- runner:model=high -->
<!-- runner:read=src/cite -->
<!-- runner:verify=bash tests/cog-phase03.sh -->

Fixes G12.

### Requirements

- `src/evidence/` defines `EvidenceSource`: `kinds()`, `resolve(kind, id) ->
  {found, summary, occurred, attributes} | notfound`, and `list(kind, since)`.
  Resolution is **local only**.
- File adapter: `evidence.sources` in config lists JSONL files. Format, one
  record per line:

  ```json
  {"kind":"thesis","id":"th_123","occurred":"2026-09-01T00:00:00Z",
   "summary":"short text","attributes":{"agent":"0x...","status":"closed"}}
  {"kind":"outcome","id":"oc_456","occurred":"2026-09-20T00:00:00Z",
   "summary":"short text","attributes":{"thesis":"th_123","result":"win",
   "metric":"+4.2%"}}
  ```

  Files are read-only, size-limited, line-validated (bad lines skipped and
  counted), and indexed into a derived table in the state DB (rebuildable).
  Record `summary`/`attributes` are scrubbed on load and never exceed the
  per-record size limit.
- `ebrain evidence import <file>` copies/validates an export into the
  configured evidence directory (atomic); `ebrain evidence stats`.
- Citation resolver: `resolveCitation(cite) -> resolved|unresolved|stale|
  malformed` combining note citations (memory-layer Phase 3 citation grammar) and evidence citations.
  Resolution status is cached per run, never persisted as truth.
- Document (in `docs/SETUP.md`) how E3D exports thesis/outcome records to
  such a file (a stub `scripts/export-e3d-evidence.md` describes the fields;
  the exporter itself lives in the E3D repos and is out of scope here).

### Acceptance Criteria

- A fixture evidence file resolves known ids, returns `unresolved` for unknown
  ids, skips malformed lines (counted), and never reads outside the configured
  evidence paths (I1 hostile-path tests).
- No network call is made by evidence loading (I3 spy test).
- Large or deeply nested records are rejected within limits.
- `bash tests/cog-phase03.sh` passes.

## Phase 4 - `supersede`: Temporal Conflict Proposals

<!-- runner:model=high -->
<!-- runner:read=src/cognition -->
<!-- runner:verify=bash tests/cog-phase04.sh -->

### Requirements

- Candidate generation (deterministic, no LLM): pairs of notes (both
  `accepted`, both with assigned ids per C3; a `pinned` note is never the
  superseded side) that share a topic signal: same non-trivial tag, mutual
  wikilink, same `kind` in `{decision, preference, fact}` plus high text
  overlap (shingle Jaccard above a configurable threshold), and differing
  `occurred`/`created` dates. Pair order: newer-first, then path.
- Adjudication: with an LLM provider configured, ask the model to classify each
  candidate pair as `supersedes | conflicts | compatible | unrelated`, quoting
  the exact conflicting sentences from each note. The quotes are verified to
  appear verbatim in the notes; otherwise the item is dropped. Without a
  provider, candidates are emitted as `proposal_type: supersede` marked
  `needs_review: unadjudicated`, up to a small cap.
- Proposal change block: set on the older note `status: superseded`,
  `superseded_by: <newer id>`, `superseded_at`, and `valid_until` (the newer
  note's `occurred`); set on the newer note `supersedes: [<older id>]`. Both
  notes are cited with revs and verbatim quotes. `conflicts` (neither
  clearly newer) yields a `kind: proposal`, `proposal_type: gap`-style item
  asking the owner to decide, not a change block.
- Search honors superseded status via the memory-layer ranking tiers
  (Phase 4 `rank.ts`) and `as_of`, using the `superseded_at` field set by this
  change block.

### Acceptance Criteria

- Fixture: "we use Postgres" (March) and "we moved to SQLite" (June) yield a
  supersede proposal whose accept sets the specified fields on both notes and
  whose `undo` restores them; `search` default hides the old note, `as_of`
  March shows it.
- Quotes that do not appear verbatim cause the item to be dropped (counted).
- Unrelated and compatible pairs produce no proposals.
- Pinned notes are never marked superseded by a proposal.
- Re-run is idempotent; a rejected pair is not re-proposed.
- `bash tests/cog-phase04.sh` passes.

## Phase 5 - `consolidate`: Duplicates and Summaries

<!-- runner:model=high -->
<!-- runner:read=src/cognition -->
<!-- runner:verify=bash tests/cog-phase05.sh -->

Fixes G13.

### Requirements

- Deterministic near-duplicate detection in `src/cognition/dedup.ts`:
  normalized text, word shingles, minhash (fixed seeds) with an LSH-style
  bucket search; threshold configurable. Works with embeddings off. When
  embeddings are on, optionally add cosine neighbors to the candidate set.
- `merge` proposals for near-duplicates: change block keeps the more complete or
  earlier note (documented rule), appends unique content from the other under a
  clearly marked section with a citation, and archives the other (C10
  definition: `status: archived`, `archived_at`, moved to `_archive/`) with
  `merged_into: <id>`; both originals are preserved by C9 undo and remain on
  disk.
- `summary` proposals for clusters of 3+ related notes (shared tags/links): a
  new `kind: summary` note with `derived_from: [note:<id>@<rev>, ...]`, each claim
  line carrying a citation to the source note; with an LLM, claims are
  verified to be supported by a quoted span from a cited source (dropped
  otherwise); without an LLM, only an extractive link-list summary is produced.
- Skip `pinned`, `raw` archive, and journal entries from other principals.
  Taint propagates (C8).
- Deterministic proposal priority: highest overlap first, then path.

### Acceptance Criteria

- Fixtures with exact duplicates, near duplicates (reworded, reordered), and
  unrelated notes: duplicates found with embeddings off; unrelated not
  flagged; false-positive rate on the negative fixtures <= 2%.
- Accepting a merge leaves both original contents recoverable via `undo` and
  never deletes a file.
- A summary claim without a supporting verbatim span is dropped.
- Taint from an `untrusted_origin` source carries into the summary proposal.
- `bash tests/cog-phase05.sh` passes.

## Phase 6 - `reflect`: Outcome-Grounded Lessons

<!-- runner:model=high -->
<!-- runner:read=src/evidence -->
<!-- runner:read=src/cognition -->
<!-- runner:verify=bash tests/cog-phase06.sh -->

### Requirements

- Inputs: an agent's `journal/<id>/` entries (and curated notes), plus
  evidence records (Phase 3). Primary pairing is **structural**: an evidence
  `outcome` whose `attributes.thesis` equals a thesis id cited by journal
  entries ("what we expected" vs "what happened"). No timestamp-proximity
  causal claims.
- For each closed thesis with at least one cited journal entry and a resolved
  outcome, the job asks the LLM to propose **at most N lessons** (default 3)
  as `proposal_type: lesson` with: the lesson text, `applies_when`, the
  expected-vs-actual comparison, and mandatory `evidence` citations
  (the journal entries `note:<id>@<rev>` and the `thesis:`/`outcome:` ids).
  Every cited id must resolve (Phase 3) or the lesson is dropped and counted.
  The lesson text must not introduce numbers absent from cited records
  (numeric tokens in the lesson are checked against the cited records).
- Contradiction check: before proposing, compare to existing accepted lessons
  (same tags/entities); if a proposed lesson conflicts, it is emitted as a
  `supersede`-style proposal against the existing lesson per Phase 4 rules
  rather than a duplicate.
- Output goes to `_inbox/` (C1). On accept, the lesson is written to
  `lessons/<principal-id>/` as `status: accepted`, `kind: lesson`,
  `derived_from` (citations in the memory-layer grammar), and, as a curated note, is
  tier T1 under the memory-layer `effectiveTier` function, above all journal
  lessons; no new tiers are added and `rank.ts` is untouched.
- Taint propagation (C8): lessons derived from `untrusted_origin` journal
  entries are flagged.
- Guardrails: a lesson is limited to the structured fields (lesson text,
  `applies_when`, the expected-vs-actual comparison). Lesson text containing a
  URL, a wallet-style `0x` address, a code fence, or a documented deny-list of
  action verbs (for example transfer, sign, approve, send, withdraw, execute) is
  dropped and counted, and `review show` prints a standing "advisory,
  unverified" banner on every lesson. Lesson text is scrubbed (strict mode); the job refuses to run if no evidence source is
  configured, rather than reflecting without ground truth.
- Optional human-brain variant: with a `decision` note and a later note whose
  `sources` cite it and records an outcome, propose a lesson using the same
  citation rules. Off unless configured.

### Acceptance Criteria

- Fixture agent vault + evidence file (one winning and one losing thesis)
  yields lessons whose citations all resolve; a lesson citing an unknown
  `outcome:` id is dropped; a lesson containing an unsupported number is
  dropped.
- Running with no evidence source configured exits with a clear message and
  creates nothing.
- Accepting a lesson writes it with structured `derived_from`; `undo` removes
  only what accept created.
- A contradicting existing lesson yields a supersede-style proposal, not a
  second lesson.
- Taint test: lesson derived from an `untrusted_origin` entry is flagged.
- `bash tests/cog-phase06.sh` passes.

## Phase 7 - `forget`: Demote and Archive Proposals

<!-- runner:model=default -->
<!-- runner:read=src/cognition -->
<!-- runner:verify=bash tests/cog-phase07.sh -->

### Requirements

- Staleness signals (deterministic): age since last `occurred`/modified,
  `recall_count` and `last_recalled` (from the Phase 1 recall record,
  `recalls.jsonl`, rolled up into a derived `note_stats` table, rebuildable
  from it),
  superseded/archived status of linked notes, and journal `expires`.
- Candidates: notes with no recall in `forget.windowDays` (default 180), older
  than `forget.minAgeDays` (default 90), not `pinned`, not cited by any
  accepted note (via the memory-layer `cites` table), not a `decision` that is the sole record of something
  (documented heuristic: kinds `decision` and `reference` are exempt by
  default; configurable).
- Proposals: `demote` (sets `status: stale`, ranks below normal but still
  searchable) or `archive` (moves to `_archive/`, keeps all content). Never
  delete (C10). Priority: oldest last-recall first.
- `ebrain journal prune` (memory-layer Phase 9) is reimplemented on top of the
  same mechanism: expired journal entries become archive proposals only when
  `journal.pruneRequiresReview: true`; the default remains the existing
  non-destructive archive behavior (no behavior change by default).
- Report `ebrain cognition stats forget` with counts and the top candidates
  with reasons (signal values shown, not scores).

### Acceptance Criteria

- Fixture with notes of varying age/recall/citation status: only the intended
  notes are proposed; pinned, cited, and exempt-kind notes are never proposed.
- Accepting `archive` applies the C10 archive definition (status, timestamp,
  move to `_archive/`) and `undo` restores it at the original path; search
  hides archived by default.
- Existing `journal prune` tests still pass with default settings.
- Recall stats rebuild identically from `recalls.jsonl` after deleting the
  derived table.
- `bash tests/cog-phase07.sh` passes.

## Phase 8 - Usefulness Feedback and Gaps

<!-- runner:model=default -->
<!-- runner:read=src/mcp -->
<!-- runner:read=src/cognition -->
<!-- runner:verify=bash tests/cog-phase08.sh -->

Fixes G15, G18.

### Requirements

- **`report_use` MCP tool** (available in every mode, including `read-only`):
  `report_use({ recall_id, note_ids?, outcome_ref?, helpful? })` appends one
  event to `<stateDir>/usage.jsonl` (state dir only, `0600`, never the vault).
  Validation: `recall_id` must exist in `recalls.jsonl` for this principal;
  `note_ids` must be a subset of the ids recorded for that `recall_id`;
  `outcome_ref` must be a well-formed citation. Events are labeled
  `self_reported`; an event with an `outcome_ref` that resolves via Phase 3
  evidence is additionally labeled `evidence_linked` at rollup time. Rate and
  size limited; duplicate (recall_id, note_id) events ignored.
  This is the only state write permitted to MCP outside the mode's vault
  fence (the memory-layer I2 scope note already allows state-directory events
  in every mode; they never touch the vault). Add `report_use` to every mode in
  `tests/fixtures/tools-by-mode.json` in the same change, with a namespaced
  phase id (`cog-8`): extend the `expectedTools` helper to take a memory phase
  and a cognition phase, so memory-phase assertions never include it.
- **Rollups:** derived `note_usage` table (rebuildable from `audit.jsonl` and
  `usage.jsonl`): `recalls`, `reported_used`, `evidence_linked_good`,
  `evidence_linked_bad` as integers. Exposed by `ebrain cognition stats
  usage` and consulted by `forget` (Phase 7 gains these signals here as an
  extension). A **bounded** ranking nudge is
  allowed: `rank.usageBoost` (default off) adds at most one tier-internal
  position weight based only on `evidence_linked_good` minus
  `evidence_linked_bad`, capped; self-reported events never affect ranking.
  Document why (agents can game self-reporting). With `usageBoost` on,
  result ordering also depends on the evidence-linked counters. **Amendment of
  I11** for this feature only: determinism holds for a fixed vault, config, and
  counter state; the default (off) keeps
  ordering a pure function of vault and config.
- **Query log (opt-in) for `gaps` (G18).** `queryLog.enabled` (default false).
  When enabled, scrubbed query text, `recall_id`, result count, and top-hit
  rank tier are appended to `<stateDir>/queries.jsonl` with
  `queryLog.retentionDays` (default 30) enforced by the owner CLI prune
  command. Strict scrubber rules apply; queries rejected by strict detection
  are not logged.
- **`gaps` job:** `ebrain cognition run gaps` clusters logged queries by
  deterministic text similarity, ranks clusters by frequency and
  poor-result rate (counts only), and writes `proposal_type: gap` items (no change block, `targets: []`, and
  `evidence: []`; C3's evidence requirement is waived because they change
  nothing) with `proposal_key` = hash of (job, cluster hash, type), where the
  cluster hash is the SHA-256 of the sorted normalized query token set, to
  `_inbox/`: "asked N times, best result tier T, M results" with example
  scrubbed queries. No LLM required; an optional LLM pass may only rename
  cluster labels, never change counts.

### Acceptance Criteria

- `report_use` rejects an unknown `recall_id`, note ids not in the recall, an
  oversized batch, and duplicates; accepts valid events in all three modes;
  never writes under the vault (checksum).
- Self-reported events never change ranking even with `usageBoost` on;
  evidence-linked events do, within the cap.
- With `queryLog.enabled=false` no query file exists after a session. With it
  on, a query containing a fake API key is not logged; retention prune works.
- `gaps` on a fixture query log yields the expected top clusters and a gap
  proposal citing counts.
- Rollup tables rebuild identically from their source logs.
- `bash tests/cog-phase08.sh` passes.

## Phase 9 - Evaluation, Shadow Mode, and Operations

<!-- runner:model=high -->
<!-- runner:read=src/cognition -->
<!-- runner:verify=bash tests/cog-phase09.sh -->

Fixes G17.

### Requirements

- **Online metrics (always available).** `ebrain cognition report` summarizes,
  per job and per version: proposals created, accepted, edited-then-accepted,
  rejected, stale, and median time-to-review; and `rejected_reasons` tallies.
  Acceptance rate is the primary signal that a job is worth its cost. Data
  comes from the review records, not from model output.
- **Shadow mode.** `ebrain cognition run <job> --shadow` writes proposals to
  `<stateDir>/shadow/` instead of `_inbox/`, so a job can be evaluated without
  creating review work. `report` can compare shadow proposals with what the
  owner later did by hand (best-effort structural matching on targets).
- **Replay evaluation (when the vault is a git repo).** `ebrain eval replay
  --job <job> --at <commit-or-date>` extracts the vault at that commit into a temp
  directory (using `git archive` through an argument-array subprocess, never a
  shell string, and never `git worktree`/`checkout` in the owner's repository), builds a temporary index there under a temporary state dir (never the owner's
  `stateDir`), runs the job in shadow mode, and compares its proposals with changes the owner
  actually made after that point (for example notes later superseded, archived,
  or lessons later written). Reports precision/recall-style counts against
  those later actions. Requires a clean git history; otherwise exits with a
  message that only online metrics are available.
- **Kill criteria are written down.** `docs/COGNITION-EVAL.md` states, per
  job, the threshold below which the job should be disabled (for example
  acceptance rate below 30% over the last 50 proposals), and
  `ebrain cognition report --check` exits non-zero when a job is below its
  threshold so a cron can alert.
- **Operations docs.** `docs/SETUP.md` gains a "Cognition" section: how to
  schedule jobs with cron/launchd for a person's brain and for an agent's
  brain, expected provider settings (local first), per-run budgets, and the
  rule that jobs run per-brain only.
- **Safety scan.** A test asserts: no cognition code path writes outside
  `_inbox/`, `<stateDir>`, or (for `apply` via the owner review CLI) the
  targets of an accepted proposal (the undo store lives under `<stateDir>`); no MCP registration
  references `src/cognition/`; the source scans for I3/I4 still pass.

### Acceptance Criteria

- `report` on fixture review records yields correct counts per job/version.
- Shadow runs create no files in `_inbox/` and no vault changes (checksum).
- Replay evaluation on a fixture git vault with known later actions reports
  expected counts; without git it exits with the documented message; the
  original vault working tree is unchanged.
- `report --check` returns non-zero for a fixture below threshold.
- The safety scan test passes.
- `bash tests/cog-phase09.sh` passes.

## Open Questions (recorded, not blocking)

- **Cross-brain `publish` (G19).** An owner-run, one-way command to copy a note
  (for example an agent's accepted lesson) into another brain's `_inbox/` with
  re-scrubbing and provenance. Needs its own security review because it crosses
  the vault-isolation boundary.
- **Reviewer agents.** Whether a designated agent may review another agent's
  proposals. Default remains human-only.
- **Identity migration.** `ebrain ids assign` exists (Phase 1) and jobs
  require assigned ids (C3). Whether `ebrain init` should offer to run it for
  an existing Obsidian vault, and how owners feel about `id:` frontmatter
  appearing in their notes.
- **Provider privacy for agent brains.** Agent journals may contain sensitive
  strategy; local-model-only for `reflect` may be required by policy.
- **Fold-in status.** Gaps G1-G5, G7, G8, G14-G16 were folded into
  `e3d-brain-spec.md`. Re-check this table if either spec changes.
