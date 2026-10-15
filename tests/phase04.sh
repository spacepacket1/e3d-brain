#!/usr/bin/env bash
# Phase 4 verification: fence, ranking, tool registry fixture, lock helper, and dispatch.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase04: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules ]] || npm ci --ignore-scripts

for f in src/mcp/fence.ts src/mcp/dispatch.ts src/mcp/schema.ts src/index/rank.ts src/lock.ts docs/RANKING.md \
  tests/fixtures/tools-by-mode.json tests/tool-registry.ts tests/fence.test.ts tests/rank.test.ts \
  tests/tool-registry.test.ts tests/lock.test.ts tests/lock-worker.ts tests/dispatch.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# The registry fixture is valid JSON and no tool name is forbidden.
node -e '
const tools = JSON.parse(require("fs").readFileSync("tests/fixtures/tools-by-mode.json", "utf8"));
if (!Array.isArray(tools)) process.exit(1);
const bad = tools.filter((t) => /accept|promote|edit|delete|move|overwrite|run|job|start/.test(t.name));
if (bad.length) { console.error(bad); process.exit(1); }' || fail "tools-by-mode.json invalid or has a forbidden name"

npm run build
# Full suite: Phases 1-3 plus fence, rank (tier table, ties, ordering scan),
# tool registry, two-process lock, and dispatch (including the registration scan).
npm test

echo "phase04: OK"
