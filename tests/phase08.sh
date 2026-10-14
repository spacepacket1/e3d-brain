#!/usr/bin/env bash
# Phase 8 verification: inbox capture (MCP, inbox mode only) and the owner's review gate (CLI).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase08: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/inbox/note.ts src/inbox/writer.ts src/inbox/review.ts src/mcp/inbox-tools.ts src/cli/inbox-commands.ts \
  src/exec/editor.ts tests/inbox.test.ts tests/inbox-mcp.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Registry fixture: inbox gains capture and list_inbox at phase 8; no other mode does.
node -e '
const t = JSON.parse(require("fs").readFileSync("tests/fixtures/tools-by-mode.json", "utf8"));
const at8 = (m) => t.filter((e) => e.phase <= 8 && e.modes.includes(m)).map((e) => e.name).sort().join(",");
if (at8("inbox") !== "capture,list_inbox,list_notes,read_note,related,search") process.exit(1);
for (const m of ["journal", "read-only"]) if (at8(m) !== "list_notes,read_note,related,search") process.exit(1);
if (t.some((e) => /accept|promote|edit|delete|move|overwrite/.test(e.name))) process.exit(1);' \
  || fail "tools-by-mode.json phase-8 entries"

# Static: no filesystem write calls in src/mcp/ (the vault is reached only via src/inbox/writer.ts).
if grep -nE '\b(createExclusive|writeAtomic|renameSafe|unlinkSafe|mkdirSafe|appendSafe|writeFileSync|renameSync|unlinkSync|mkdirSync)\b' src/mcp/*.ts; then
  fail "filesystem write call in src/mcp/"
fi
grep -q "from '../inbox/writer.js'" src/mcp/inbox-tools.ts || fail "inbox tools do not use the inbox writer"
if grep -n "inbox/review" src/mcp/*.ts; then fail "src/mcp/ imports the CLI review module"; fi
grep -q "modes: \['inbox'\]" src/mcp/inbox-tools.ts || fail "inbox tools are not inbox-mode only"
# child_process only in src/exec/ (I3).
if grep -rln "node:child_process" src | grep -v '^src/exec/'; then fail "child_process outside src/exec/"; fi

# Docs.
grep -q '^## Inbox (the review gate)' docs/SETUP.md || fail "docs/SETUP.md lacks the Inbox section"
grep -q 'ebrain inbox accept' docs/SETUP.md || fail "docs/SETUP.md lacks ebrain inbox accept"
grep -q 'Inbox (Phase 8' docs/SECURITY.md || fail "docs/SECURITY.md lacks the inbox bullet"

npm run build
# Full suite: Phases 1-7 plus slugs and the inbox writer (hostile titles,
# collisions, length limits), capture/list_inbox via dispatch (frontmatter,
# human redaction, agent strict rejection, ranking T2 and labels), the
# accept/reject review gate (moves, frontmatter, id preservation, --to rules,
# crash recovery), the static src/mcp/ write scan, and the spawned server per
# mode (expectedTools(<mode>, 8)) with the owner CLI and doctor.
npm test

# End to end from the shell: init, capture over MCP, accept from the CLI.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p8-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal tester --state-dir "$tmp/state" --config "$tmp/cfg/config.json" > /dev/null \
  || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
printf '# Kept\n\ncurated text\n' > "$tmp/vault/kept.md"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capture","arguments":{"title":"../../Phase eight","body":"phaseeightmarker body"}}}'
  sleep 1
} | node dist/src/cli/main.js mcp > "$tmp/stdout.jsonl" 2> "$tmp/stderr.log" || fail "ebrain mcp exited non-zero"
id="$(node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const call = JSON.parse(lines[1]);
if (call.result.isError) process.exit(1);
const h = JSON.parse(call.result.content[0].text.split("\n")[0]);
if (!/^_inbox\/\d{8}-\d{6}-phase-eight\.md$/.test(h.path) || h.status !== "proposed") process.exit(1);
process.stdout.write(h.id);' "$tmp/stdout.jsonl")" || fail "capture over MCP"
[[ "$(ls "$tmp/vault/_inbox" | grep -c 'phase-eight')" -eq 1 ]] || fail "capture did not create one inbox file"
[[ "$(cat "$tmp/vault/kept.md")" == "$(printf '# Kept\n\ncurated text')" ]] || fail "capture touched a curated note"
grep -q 'phaseeightmarker' "$tmp/state/audit.jsonl" && fail "audit leaked capture body"
node dist/src/cli/main.js inbox list | grep -q "$id" || fail "inbox list does not show the capture"
node dist/src/cli/main.js inbox accept "$id" > "$tmp/accept.out" || fail "inbox accept"
grep -q 'notes/phase-eight.md' "$tmp/accept.out" || fail "accept did not move to notes/"
grep -q '^status: accepted$' "$tmp/vault/notes/phase-eight.md" || fail "accepted note lacks status: accepted"
grep -q "^id: $id\$" "$tmp/vault/notes/phase-eight.md" || fail "accept did not keep the id"
[[ -z "$(ls "$tmp/vault/_inbox" | grep 'phase-eight' || true)" ]] || fail "inbox copy left behind"
node dist/src/cli/main.js inbox accept "$id" --to journal/x > /dev/null 2>&1 && fail "accept --to journal/x was allowed"

echo "phase08: OK"
