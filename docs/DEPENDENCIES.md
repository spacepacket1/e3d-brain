# Dependencies

Every direct dependency is pinned to an exact version with a committed
lockfile (I9). Each line: package, version, justification, transitive package
count from `npm ls --all`. Adding a dependency requires a line here.

## Runtime

- `better-sqlite3` 13.0.3: synchronous SQLite with FTS5 for the derived index (I7); the one native module, ships prebuilds; `npm run build:native` rebuilds it. Transitive: 1 (`node-addon-api`, build-time headers).

- `yaml` 2.9.1: YAML 1.2 frontmatter parsing (Phase 2); used with the `core` schema (no custom tags or timestamps), alias expansion capped. Transitive: 0.

## Development

- `typescript` 6.0.3: strict TypeScript compiler (last JavaScript-based release; no platform binaries). Transitive: 0.
- `@types/node` 22.20.5: Node.js type definitions matching the `engines.node >= 22` floor. Transitive: 1 (`undici-types`).
- `@types/better-sqlite3` 9.6.0: type definitions for `better-sqlite3`. Transitive: 1 (`@types/node`, shared).

## Planned (added by the phase that first uses them)

- `@modelcontextprotocol/sdk` (Phase 6), a zip reader (Phase 10), an XHTML text extractor (Phase 11).
