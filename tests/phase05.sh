#!/usr/bin/env bash
# Phase 5 verification: principal enforcement and the audit log (all modes).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase05: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules ]] || npm ci --ignore-scripts

for f in src/audit/audit.ts src/cli/audit-commands.ts src/mcp/dispatch.ts tests/audit.test.ts tests/audit-worker.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done
grep -q '^## Auditing' docs/SETUP.md || fail "docs/SETUP.md lacks an Auditing section"
grep -q 'audit.maxSegmentMB' docs/SETUP.md || fail "docs/SETUP.md lacks audit.maxSegmentMB"
# The audit line is written from dispatch.
grep -q 'ctx.audit.write' src/mcp/dispatch.ts || fail "dispatch does not write the audit line"

npm run build
# Full suite: Phases 1-4 plus the audit tests (one line per call in every
# mode, author/principal rejection, no leaks, restarts, rotation, readers,
# prune, two concurrent appenders).
npm test

# CLI end to end: an empty log, then tail/stats/prune over a rotated log.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p5-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/vault"
cat > "$tmp/config.json" <<JSON
{"vaultPath":"$tmp/vault","stateDir":"$tmp/state","principal":{"id":"tester","type":"human"},"mode":"read-only","audit":{"maxSegmentMB":0.001}}
JSON
chmod 600 "$tmp/config.json"
export EBRAIN_CONFIG="$tmp/config.json"
node dist/src/cli/main.js audit stats | grep -q '^segments: 0$' || fail "stats on empty log"
node --input-type=module -e "
import { AuditLog, segmentBytes } from './dist/src/audit/audit.js';
import { dispatch, registerTool, ToolRegistry } from './dist/src/mcp/dispatch.js';
import { resolveInState } from './dist/src/safe-path.js';
const registry = new ToolRegistry();
registerTool({ name: 'fake_read', modes: ['read-only'], schema: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } } },
  auditArgs: { path: 'path' }, handler: () => ({ content: 'ok', returned: [] }) }, registry);
const audit = new AuditLog(resolveInState('$tmp/state', ''), { maxSegmentBytes: segmentBytes(0.001) });
const ctx = { mode: 'read-only', principal: { id: 'tester', type: 'human' }, maxCharsPerCall: 10000, registry, audit };
for (let i = 0; i < 20; i++) await dispatch(ctx, 'fake_read', { path: 'n' + i + '.md', query: 'SECRET-QUERY-TEXT' });
await dispatch(ctx, 'fake_read', { path: 'x.md', author: 'mallory' });
"
[[ -f "$tmp/state/audit.jsonl.1" ]] || fail "no rotation"
node -e 'process.exit((require("fs").statSync(process.argv[1]).mode & 0o777) === 0o600 ? 0 : 1)' "$tmp/state/audit.jsonl" || fail "audit.jsonl not 0600"
cat "$tmp"/state/audit.jsonl* | grep -q 'SECRET-QUERY-TEXT' && fail "query text leaked"
cat "$tmp"/state/audit.jsonl* | grep -q 'mallory' && fail "argument value leaked"
node dist/src/cli/main.js audit stats | grep -q '^lines: 21$' || fail "stats line count"
node dist/src/cli/main.js audit tail -n 1 | grep -q '"outcome":"invalid"' || fail "tail last line"
[[ "$(node dist/src/cli/main.js audit tail -n 21 | head -1)" == *'"n0.md"'* ]] || fail "tail order across segments"
node dist/src/cli/main.js audit prune --older-than 1 | grep -q 'pruned 0 segment' || fail "prune deleted fresh segments"

echo "phase05: OK"
