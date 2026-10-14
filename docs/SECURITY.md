# e3d-brain Security

## Invariants

These are copied verbatim from `docs/e3d-brain-spec.md` ("Shared Constraints").
They apply to every phase and are tested. Later phases must not weaken them.

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

## Threat model and accepted residual risk (I1)

- The vault and the state directory belong to a trusted local owner and are
  not concurrently modified by an adversary.
- `src/safe-path.ts` resolves every externally derived path against an
  explicitly named root: the root is realpath'd first, the path is split into
  segments that are validated (no `..`/`.`, absolute paths, NUL or other
  control/format characters, backslashes, percent-encoded octets, drive
  prefixes, or empty segments; checks also apply after NFKC normalization),
  and each existing component is `lstat`'d. A symlink is followed only if its
  `realpath` stays inside the root; loops and dangling symlinks are rejected.
  The returned path is the realpath of the deepest existing ancestor joined
  with the not-yet-existing remainder.
- Inside the vault, any segment that is dot-prefixed after NFKC
  normalization, zero-width-joiner removal, and case folding is refused
  (`.obsidian`, `.git`, `.trash`, and tool temp files), so case and Unicode
  variants of those names cannot be addressed on case- or
  normalization-insensitive filesystems.
- **Residual race (accepted):** a symlink could be swapped into a path between
  the check and the use. Every write revalidates that the parent directory
  still realpaths to itself immediately before creating its temp file and
  again before publishing; reads open with `O_NOFOLLOW` and require a regular
  file. A swap of an ancestor between that revalidation and the system call
  remains possible and is out of scope under the threat model above.
- `createExclusive` writes a dot-prefixed temp file in the target's directory
  and publishes it with `link(tmp, final)`; `EEXIST` is a collision and the
  target is never replaced. Where hard links are unsupported it falls back to
  `open(O_CREAT|O_EXCL|O_NOFOLLOW)`. `writeAtomic` (for files that may be
  replaced) is temp file + `fsync` + `rename`. `renameSafe` without
  `overwrite` uses `link` + `unlink` for files; for directories it falls back
  to check-then-rename (same residual race).
- The vault scanner (Phase 2) never follows symlinks: it skips every entry
  `readdir` reports as a symlink, lstats each file again before reading,
  and reads with `O_NOFOLLOW`; directories are lstat'ed again just before descending. Child paths are joined with `vaultChild`
  (vault name rules, no realpath) below the realpath'd root. A directory
  swapped for a symlink between `readdir` and descending into it is the same
  accepted residual race.
- All files the tool creates get mode `0600` and directories `0700`, set with
  explicit open modes plus `fchmod`/`chmod`, never left to the umask (I8).

## Config file trust

The config file fixes principal and mode, so `loadConfig` refuses a config
file that is not owned by the current user or is group- or world-writable.
The file is realpath'd and must stay inside its own directory, so a config
path that is a symlink to another directory is refused (fail closed). Unknown
keys and invalid values are errors (I10).

## Tool dispatch and output fencing (I2, I6)

- Every MCP tool call goes through `dispatch` (`src/mcp/dispatch.ts`). It
  checks that the tool is registered for the instance's mode (a tool of
  another mode looks exactly like an unknown tool), validates the arguments
  against the tool's schema (unknown keys such as `author` or `principal` are
  always rejected, nothing is coerced, and errors never echo argument
  values), and passes the result through the fence and the size cap.
  Handlers refuse with a typed `ToolRejection`; any other exception becomes a
  generic `internal` error with no stack trace. A scan test fails if any other
  module wires tool handlers into the MCP server.
- `registerTool` refuses any name matching
  `/accept|promote|edit|delete|move|overwrite|run|job|start/`.
- `src/mcp/fence.ts` wraps untrusted text in a backtick fence one longer than
  its longest backtick run (minimum 3), after a label saying it is reference
  data, not instructions, and non-authoritative. Truncation to the cap keeps
  the closing fence. The cap is at most 10,000 characters (UTF-16 code
  units), lowered by `limits.maxCharsPerCall` and then by `max_chars`.
- Audit (Phase 5): `dispatch` writes one line per `tools/call` to
  `<stateDir>/audit.jsonl` (`src/audit/audit.ts`) in every mode, including
  rejected, invalid, and errored calls; a failed audit write turns the
  response into an error, so no result is returned unaudited. Lines hold
  paths, ids, counts, and `{id, rev}` of returned notes; argument strings are
  redacted unless the tool declared them a path or id and they have that
  shape (credential-shaped values are redacted regardless); rejection details
  and unknown tool names are never logged. Files are `O_APPEND`, `0600`,
  never truncated by the server; rotation happens under the audit lock, and
  only the owner-run `ebrain audit prune` deletes whole old segments.
  Residual: a writer that raced a rotation may add a line to the previous
  segment; a declared id or path argument is logged verbatim if it is
  id/path-shaped.
- MCP server (Phase 6): `ebrain mcp` serves over stdio with the SDK's
  low-level `Server`; `attachToServer` in `dispatch.ts` is the only place
  tools/list and tools/call are wired. stdout carries protocol frames only
  (stray `console.log` output is redirected to stderr); log lines never
  contain note text, queries, or arguments, and protocol errors are logged by
  error name only. Tool output puts all note-derived text (paths, titles,
  excerpts, bodies) inside the fence; the server-written header holds only
  the tool name, `recall_id`, and counts. Read handlers validate `path` and
  `folder` through `resolveInVault`, read only notes present in the index
  (symlinks are never indexed), and open files with `O_NOFOLLOW`. Plain search
  queries are reduced to quoted words so FTS5 operators are inert; only
  `advanced: true` passes FTS5 syntax through. Residual: a `tools/call`
  whose envelope the SDK itself rejects (for example `arguments` that is not
  an object) fails at the protocol layer before dispatch and is not audited.
- Scrubber (Phase 7, I5): `src/scrub/` is a pure library; writers call
  `scrubForWrite` (or `scrubToolInput` from MCP tools) before persisting and
  abort on any throw, so unscrubbed text is never written. Findings are
  `{type, count}`; no finding, error, rejection, CLI output, or audit line
  contains matched text. Agent principals are strict: a credential-class
  detection rejects the write (`ToolRejection` `strict-scrub`, audited by
  detector type). Every detector regex is bounded or literal-anchored, so
  scanning is linear (1 MB inputs scrub in well under a second); user
  `extraPatterns` are literal strings only. Scrubbing repeats until a pass
  finds nothing, so it is idempotent. Residuals: detection is heuristic, so
  an unusual secret format can pass (passwords in prose need a digit, symbol,
  or quotes; letters-only values are caught only on `key=value` config
  lines); base58 keys without a checksum (for example Solana) are caught only
  by the entropy heuristic; base64 of ordinary text may be redacted as
  `high-entropy`.
- Inbox (Phase 8, I2): `capture` and `list_inbox` are registered only in
  `inbox` mode. `capture` scrubs title, body, and sources before anything is
  written and has no path argument: it passes a sanitized slug
  (`[a-z0-9-]`, at most 60 characters) to `src/inbox/writer.ts`, which builds
  the file name itself, checks that the target's parent is `<vault>/_inbox/`
  (a real directory, not a symlink), and publishes with `createExclusive`
  (suffixing on collision, never overwriting). A scan test fails if any file
  in `src/mcp/` contains a filesystem write call or imports anything from
  `src/inbox/` other than the writer and the pure note renderer. Accept and
  reject (`src/inbox/review.ts`) are CLI only; `--to` goes through
  `resolveInVault` and is refused for `_inbox/`, `journal/`, `_raw/`,
  `_archive/`, and dot-directories, also after symlink resolution. Accept
  writes the destination with `createExclusive` before unlinking the source,
  so a crash can leave a duplicate (reported by `doctor`, finished by
  re-running accept) but never lose the note.
- Journal (Phase 9, I2): `journal_append` and `journal_list` are registered
  only in `journal` mode, which the config allows only for an agent
  principal. `journal_append` has no path argument; `src/journal/store.ts`
  builds `journal/<principal-id>/<yyyy>/<yyyymmdd-hhmmss>-<slug>.md` from the
  configured principal id (re-validated), a sanitized slug, and the clock,
  refuses any symlinked component of that directory chain, and publishes
  with `createExclusive` (link, never rename): a name collision is an error,
  never an overwrite or an append. Title, body, and sources are scrubbed
  under strict agent rules first (a credential rejects the whole entry).
  Size, rate, total-size, and 24-hour duplicate limits are computed from the
  journal directory (file-name stamps, `stat` sizes, file bodies), not from
  the index or audit log, and the whole check-and-create runs under
  `<stateDir>/locks/journal-<principal-id>.lock`; rejections are audited by
  limit code only. `ebrain journal prune` (CLI) moves expired entries to
  `journal/_archive/<principal-id>/` with link+unlink and never deletes.
  `ebrain import agent-workspace` reads the source only through
  `openExternalFile` (the workspace is the one allowed root; symlinks out of
  it are refused), never writes it, and skips any file that trips a strict
  detector. Residual: journal entries are agent-authored and unreviewed; they
  are labeled `agent-journal` and ranked below curated and inbox notes, but
  their content is whatever the agent wrote.
- Conversation importers (Phase 10, I1, I5): `ebrain import claude-code`,
  `claude-export`, and `chatgpt-export` are owner CLI commands (no MCP tool)
  and refuse to run for an `agent` principal. Sources are read only through
  `openExternalFile` with the caller-named root (the projects directory, the
  export directory, or the zip's own directory); symlinked transcripts are
  skipped and sources are never written. Zip exports are never extracted to
  disk: `src/import/zip.ts` feeds `yauzl` positional reads of the validated
  descriptor, rejects the whole archive on any entry name that is absolute,
  has a drive letter, backslash, control character, or a `.`/`..`/empty
  segment (zip-slip), on more than 50,000 entries, on any entry declaring
  more than 512 MiB or a declared total above 16 GiB, and on an entry whose
  inflated bytes exceed its declared size or the cap (zip bombs, lying
  headers). Every title and turn is scrubbed (mandatory, no flag) before
  rendering; output goes only to `_raw/conversations/<source>/<yyyy>/` via
  `createExclusive` (new) or `writeAtomic` (update), refusing symlinked
  directories, under `<stateDir>/locks/raw-archive.lock`. Residual: raw
  archive notes hold whole scrubbed conversations, so heuristic scrubber
  misses (Phase 7 residuals) persist in the vault, and anything that syncs
  the vault carries them.
- Hooks (Phase 13, I2, I5, I6): `session-start` is read-only and its brief is
  fenced and capped. `pre-compact` writes only when `mode` is `inbox` and
  `hooks.captureCheckpoints` is `true`, only through the inbox writer, and only
  scrubbed user turns from a transcript under `hooks.claudeProjectsDir` (realpath
  checked, symlinks refused). Hook settings are read only from the user-level
  `config.json`; the hook JSON's `cwd` and project files are ignored. Hooks
  fail open (exit 0). `install`/`remove` edit only entries ending in
  `hook <event> --ebrain-managed` and refuse a settings file that is not a
  JSON object.
- Embeddings (Phase 12, I3, I5): off by default (`provider: none` runs no
  `src/net/` code, asserted by a spy test). The Ollama client lives in
  `src/net/`; the base URL must be loopback or in `network.allowedHosts`, which
  is enforced at config load and again when the client is built. Redirects are
  refused, responses are size-capped, and requests time out. Requests carry
  only the model name and scrubbed text (chunks and search queries pass through
  the non-strict scrubber first). Vectors are derived data in `index.db`
  (rebuildable); an unreachable server degrades to BM25 with a warning.
- Reference library (Phase 11, I1, I3, I5, I7): `ebrain refs add|remove|reindex`
  are owner CLI commands; MCP only reads `refs.db` (opened read-only per
  call, from `src/mcp/` through `src/refs/db.ts` only). Source files are
  opened with `openExternalFile` and their own directory as the named root,
  and are never written. EPUBs go through the Phase 10 zip reader (same entry
  name, count, and size limits; nothing extracted to disk); XHTML becomes
  text through the in-repo tokenizer `src/refs/xml.ts`, which drops scripts,
  styles, and embedded media, skips doctypes (no entity expansion, no XXE),
  and never fetches a URL (hrefs are resolved only to archive entry names).
  Book text is scrubbed (non-strict redaction, also for agent principals)
  before it is stored, and is stored only in `<stateDir>/refs.db` (`0600`),
  never in the vault or `index.db`; the vault note per book holds metadata
  only. `search` caps book hits and excerpts (`refs.maxHits`,
  `refs.excerptChars`) and `read_ref_chunk` returns one fenced, capped chunk
  per call. Residual: book text sits in the state dir in clear (like the
  index), and heuristic scrubber misses persist there.
- `pdftotext` (`src/exec/pdftotext.ts`) is spawned by its fixed name with an
  argument array (`-enc UTF-8 -q <file> -`), `shell: false`, a minimal
  environment (`PATH` only), a 60-second timeout (SIGKILL), and a 64 MiB
  output cap. Residual: which `pdftotext` runs is decided by the owner's
  `PATH`, and the binary itself parses the (untrusted) PDF.
- `accept --edit` is a process spawn (`src/exec/editor.ts`):
  the owner's `$VISUAL`/`$EDITOR`, restricted to a single program name or
  absolute path, spawned with an argument array and `shell: false`, with the
  note path as its only argument. Residual: the editor is whatever program
  the owner's environment names.
- `ebrain doctor --strict` fails on non-loopback `allowedHosts`, any
  group/world-accessible entry under the state dir, and vault symlinks that
  escape the root.
- `src/lock.ts` is the only cross-process lock (`O_EXCL` file under
  `<stateDir>/locks/`, stale after 60 seconds, broken only under a second
  exclusive breaker file so a fresh lock is never removed).
