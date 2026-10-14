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
