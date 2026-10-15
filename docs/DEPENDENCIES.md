# Dependencies

Every direct dependency is pinned to an exact version with a committed
lockfile (I9). Each line: package, version, justification, transitive package
count from `npm ls --all`. Adding a dependency requires a line here.

## Runtime

- `better-sqlite3` 13.0.3: synchronous SQLite with FTS5 for the derived index (I7); the one native module, ships prebuilds; `npm run build:native` rebuilds it. Transitive: 1 (`node-addon-api`, build-time headers).

- `@modelcontextprotocol/sdk` 1.32.1: the official MCP SDK for the stdio server (Phase 6); only the low-level `Server` and `StdioServerTransport` are used, wired solely through `src/mcp/dispatch.ts` (its HTTP/OAuth modules are never imported). Transitive: 94 (mostly the optional HTTP transport stack: express, hono, cors, jose, ajv, zod).

- `yaml` 2.9.1: YAML 1.2 frontmatter parsing (Phase 2); used with the `core` schema (no custom tags or timestamps), alias expansion capped. Transitive: 0.

- `yauzl` 3.4.0: zip reader for the conversation exports (Phase 10; Phase 11 reuses it for EPUB). Chosen because it streams, reads the central directory first (entry count and every entry's declared sizes are known before anything is inflated), validates entry names, and rejects entries whose real size differs from the declared one. It is driven only through `fromRandomAccessReader` over positional reads of an `openExternalFile` handle (`src/import/zip.ts`), so it never opens a path itself and nothing is extracted to disk. Pure JavaScript, no install scripts. Transitive: 1 (`pend`).

## Development

- `typescript` 6.0.3: strict TypeScript compiler (last JavaScript-based release; no platform binaries). Transitive: 0.
- `@types/node` 22.20.5: Node.js type definitions matching the `engines.node >= 22` floor. Transitive: 1 (`undici-types`).
- `@types/better-sqlite3` 9.6.0: type definitions for `better-sqlite3`. Transitive: 1 (`@types/node`, shared).
- `@types/yauzl` 3.4.0: type definitions for `yauzl`. Transitive: 1 (`@types/node`, shared).

## XHTML text extraction (Phase 11): in-repo, no dependency

- EPUB XHTML, OPF, NCX, and nav documents are read by a minimal in-repo tokenizer, `src/refs/xml.ts` (about 300 lines), instead of a parser package such as `htmlparser2`. Justification: text extraction needs only tags, attributes, character references, and raw-text `<script>`/`<style>` handling; a small pure function is easy to audit, adds no transitive packages (Transitive: 0), and by construction cannot fetch URLs or expand external entities (doctypes, including internal subsets, and processing instructions are skipped; only a fixed table of named references and numeric references is decoded). Zip reading reuses `yauzl` (Phase 10). PDFs use the optional external `pdftotext` binary (not a package; see `src/exec/pdftotext.ts`).

## Vector storage (Phase 12): BLOBs, no dependency

- Vectors are stored as unit-length float32 BLOBs in `index.db` and searched by brute-force cosine similarity (exact; fine at personal-vault scale). `sqlite-vec` was not added: it is a native extension that must be loaded at runtime, and a plain table keeps the install to the existing `better-sqlite3`. Transitive: 0. `embeddings.store` selects the store; `blob` is the only value. The Ollama client uses Node's built-in `fetch`, confined to `src/net/`.
