#!/usr/bin/env bash
# Phase 6 verification: MCP server (stdio) with read tools, ebrain init, doctor --strict.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase06: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/mcp/server.ts src/mcp/tools.ts src/mcp/ulid.ts src/cli/init.ts tests/mcp-client.ts tests/mcp-server.test.ts \
  tests/read-tools.test.ts tests/fixtures/mcp-notes/Injection.md; do
  [[ -f "$f" ]] || fail "missing $f"
done

# The SDK is an exact pin with a DEPENDENCIES.md line.
node -e '
const p = require("./package.json");
const v = p.dependencies["@modelcontextprotocol/sdk"];
if (!/^\d+\.\d+\.\d+$/.test(v || "")) process.exit(1);
if (require("./package-lock.json").packages["node_modules/@modelcontextprotocol/sdk"].version !== v) process.exit(1);' \
  || fail "@modelcontextprotocol/sdk must be exact-pinned and locked"
grep -q '@modelcontextprotocol/sdk' docs/DEPENDENCIES.md || fail "docs/DEPENDENCIES.md lacks the SDK"

# Docs.
for pat in '^## Several people, separate brains' '^## Running on a Linux server' 'claude mcp add' '"mcpServers"' \
  'build-essential' 'npm ci --ignore-scripts' '\.mcp\.json' 'NFS' 'doctor --strict' 'must \*\*not\*\*\|Never sync the state dir'; do
  grep -q -- "$pat" docs/SETUP.md || fail "docs/SETUP.md lacks: $pat"
done

# Registry fixture: exactly the four read tools at phase 6, in every mode.
node -e '
const t = JSON.parse(require("fs").readFileSync("tests/fixtures/tools-by-mode.json", "utf8")).filter((e) => e.phase <= 6);
const names = t.map((e) => e.name).sort().join(",");
if (names !== "list_notes,read_note,related,search") process.exit(1);
if (!t.every((e) => ["inbox", "journal", "read-only"].every((m) => e.modes.includes(m)))) process.exit(1);' \
  || fail "tools-by-mode.json phase-6 entries"

# Server wiring lives in dispatch only.
grep -q 'export function attachToServer' src/mcp/dispatch.ts || fail "dispatch lacks attachToServer"
grep -q 'refreshIndex' src/mcp/tools.ts || fail "tools do not refresh the index"

npm run build
# Full suite: Phases 1-5 plus the MCP integration test (handshake and tool list
# per mode, every tool, path containment, fencing, citations fresh/stale,
# as_of and include flags, size caps, refresh-on-read, stdout frames only,
# one audit line per call) and init + doctor --strict.
npm test

# End to end from the shell: init on an empty temp dir, doctor --strict,
# then an MCP session whose stdout must be protocol frames only.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p6-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal tester --state-dir "$tmp/state" --config "$tmp/cfg/config.json" > "$tmp/init.out" \
  || fail "ebrain init"
grep -q 'claude mcp add' "$tmp/init.out" || fail "init did not print the Claude Code snippet"
grep -q '"mcpServers"' "$tmp/init.out" || fail "init did not print the Claude Desktop snippet"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
node dist/src/cli/main.js doctor --strict > "$tmp/doctor.out" || { cat "$tmp/doctor.out" >&2; fail "doctor --strict after init"; }
printf '# Hello\n\nphasesixmarker lives here.\n' > "$tmp/vault/hello.md"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"phasesixmarker"}}}'
  sleep 1
} | node dist/src/cli/main.js mcp > "$tmp/stdout.jsonl" 2> "$tmp/stderr.log" || fail "ebrain mcp exited non-zero"
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
if (lines.length !== 3) { console.error("expected 3 frames, got", lines.length); process.exit(1); }
for (const l of lines) { const m = JSON.parse(l); if (m.jsonrpc !== "2.0") process.exit(1); }
const call = JSON.parse(lines[2]);
if (!call.result.content[0].text.includes("hello.md")) process.exit(1);' "$tmp/stdout.jsonl" || fail "stdout is not protocol frames only"
grep -q 'phasesixmarker' "$tmp/stderr.log" && fail "stderr leaked query text"
[[ "$(wc -l < "$tmp/state/audit.jsonl")" -eq 1 ]] || fail "expected exactly one audit line"
grep -q 'phasesixmarker' "$tmp/state/audit.jsonl" && fail "audit leaked query text"

echo "phase06: OK"
