#!/usr/bin/env bash
# Cognition Phase 1 verification: the undo store, `ebrain ids assign`,
# `ebrain undo`, and the recall record.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase01: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/undo/store.ts src/ids/assign.ts src/recall/recalls.ts src/cli/undo-commands.ts \
  tests/undo.test.ts tests/ids-assign.test.ts tests/recalls.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: undo data lives under <stateDir>/undo/ only; paths go through safe-path (I1).
if grep -rn 'ebrain-undo' src; then fail "a vault-side undo directory is named in src/"; fi
grep -q "export const UNDO_DIR = 'undo'" src/undo/store.ts || fail "UNDO_DIR is not 'undo'"
grep -q 'resolveInState(env.stateDir, `${UNDO_DIR}/' src/undo/store.ts || fail "undo dir not resolved in the state dir"
grep -q 'resolveInVault' src/undo/store.ts || fail "undo store does not resolve vault paths through safe-path"
grep -q 'ULID_RE' src/undo/store.ts || fail "operation ids are not validated as ULIDs"
grep -q "APPLY_LOCK = 'apply'" src/undo/store.ts || fail "undo store does not use the apply lock"
# Undo removes only files the same operation created: unlinkSafe appears once, in the create reversal.
[[ "$(grep -c 'unlinkSafe(' src/undo/store.ts)" == "1" ]] || fail "undo store unlinks in more than one place"
# ids assign writes only through the undo store.
if grep -nE '\b(writeAtomic|createExclusive|renameSafe|unlinkSafe|appendSafe)\b' src/ids/assign.ts; then fail "ids assign writes outside the undo store"; fi
grep -q 'runOperation' src/ids/assign.ts || fail "ids assign does not use the undo store"
# No MCP tool for ids, undo, or recalls; src/mcp/ still has no filesystem write calls.
if grep -rnE "name: '(ids|undo|assign|recalls)[a-z_]*'" src/mcp; then fail "an MCP tool exposes an owner command"; fi
if grep -nE '\b(createExclusive|writeAtomic|renameSafe|unlinkSafe|mkdirSafe|appendSafe|writeFileSync|renameSync|unlinkSync|mkdirSync)\b' src/mcp/*.ts; then
  fail "filesystem write call in src/mcp/"
fi
grep -q 'ctx.recalls.append' src/mcp/dispatch.ts || fail "dispatch does not append the recall record"
grep -q 'recalls: new RecallLog(stateDir)' src/mcp/server.ts || fail "the MCP server does not wire the recall log"
grep -q 'MAX_RECALL_IDS = 500' src/recall/recalls.ts || fail "recall records are not capped at 500 ids"
grep -q 'DEFAULT_RECALL_RETENTION_DAYS = 180' src/config.ts || fail "recallLog.retentionDays default is not 180"
grep -q 'id_aliases' src/index/db.ts || fail "index has no id_aliases table"
grep -q "DELETE FROM id_aliases" src/index/identity.ts || fail "a full rebuild does not clear id aliases"

# Docs.
grep -q '^## Assigning ids and undo' docs/SETUP.md || fail "docs/SETUP.md lacks the ids/undo section"
grep -q 'Undo is machine-local' docs/SETUP.md || fail "docs/SETUP.md does not say undo is machine-local"
grep -q '^## Recall record' docs/SETUP.md || fail "docs/SETUP.md lacks the recall record section"
grep -q 'recallLog.retentionDays' docs/SETUP.md || fail "docs/SETUP.md config table lacks recallLog.retentionDays"

npm run build
# Full suite, including the undo store (rewrite/create/move, byte-for-byte
# restore, refusal after edits, crash recovery, hostile ids and paths), ids
# assign (dry run, exact bytes, aliases until a full rebuild, CLI), and the
# recall record (dispatch, cap, failure, prune, config).
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog1-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
mkdir -p "$tmp/vault/notes/deep"
printf '# Plain\n\ncogphaseonemarker plain body\n' > "$tmp/vault/notes/plain.md"
printf -- '---\ntitle: Kept\npinned: true\nweird_key: [1, 2]\n---\r\ncogphaseonemarker body with CRLF\r\n' > "$tmp/vault/notes/deep/fm.md"
printf -- '---\nid: 01HAVEID00000000000000000A\n---\nalready has one\n' > "$tmp/vault/notes/has-id.md"
printf -- '---\ntitle: [broken\n---\nmalformed\n' > "$tmp/vault/notes/bad.md"
tree_sum() { (cd "$tmp/vault" && find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256); }
sum0="$(tree_sum)"

eb ids assign --dry-run > "$tmp/dry.out" || fail "ids assign --dry-run"
grep -q '2 would assign, 1 skipped' "$tmp/dry.out" || { cat "$tmp/dry.out" >&2; fail "dry-run summary"; }
[[ "$(tree_sum)" == "$sum0" ]] || fail "dry run changed the vault"
[[ ! -e "$tmp/state/undo" ]] || fail "dry run created undo data"

eb ids assign > "$tmp/assign.out" || fail "ids assign"
grep -q '2 assigned, 1 skipped' "$tmp/assign.out" || { cat "$tmp/assign.out" >&2; fail "assign summary"; }
op="$(sed -n 's/^undo with: ebrain undo \([0-9A-Z]\{26\}\)$/\1/p' "$tmp/assign.out")"
[[ -n "$op" ]] || fail "no operation id printed"
# Only the inserted lines differ.
node -e '
const fs = require("fs");
const t = fs.readFileSync(process.argv[1], "latin1");
const stripped = t.replace(/id: [0-9A-Z]{26}\r?\n(schema: 1\r?\n)?/, "");
if (stripped !== "---\ntitle: Kept\npinned: true\nweird_key: [1, 2]\n---\r\ncogphaseonemarker body with CRLF\r\n") process.exit(1);
const p = fs.readFileSync(process.argv[2], "latin1").replace(/^---\nid: [0-9A-Z]{26}\nschema: 1\n---\n/, "");
if (p !== "# Plain\n\ncogphaseonemarker plain body\n") process.exit(2);' "$tmp/vault/notes/deep/fm.md" "$tmp/vault/notes/plain.md" \
  || fail "ids assign changed bytes other than the inserted id lines"
grep -q '01HAVEID00000000000000000A' "$tmp/vault/notes/has-id.md" || fail "existing id touched"
[[ "$(grep -c '^id:' "$tmp/vault/notes/has-id.md")" == "1" ]] || fail "note with an id got a second id"
[[ -f "$tmp/state/undo/$op/manifest.json" ]] || fail "undo manifest not under <stateDir>/undo/"
[[ "$(stat -f '%Lp' "$tmp/state/undo/$op/manifest.json" 2>/dev/null || stat -c '%a' "$tmp/state/undo/$op/manifest.json")" == "600" ]] || fail "manifest mode is not 0600"
if find "$tmp/vault" -iname '*undo*' | grep -q .; then fail "undo data in the vault"; fi
eb undo --list | grep -q "^$op .* committed .*ids assign" || fail "undo --list does not show the operation"

# Hostile operation ids are refused.
for bad in '../../etc/passwd' '/etc/passwd' '..' "$op/../x"; do
  eb undo "$bad" > /dev/null 2>&1 && fail "undo accepted hostile id $bad"
done

# An edit after the operation blocks undo; reverting the edit unblocks it.
cp "$tmp/vault/notes/plain.md" "$tmp/plain.bak"
printf 'edited later\n' >> "$tmp/vault/notes/plain.md"
eb undo "$op" > /dev/null 2> "$tmp/undo-refused.err" && fail "undo ignored an edit made after the operation"
grep -q 'notes/plain.md was edited after operation' "$tmp/undo-refused.err" || fail "undo refusal message"
cp "$tmp/plain.bak" "$tmp/vault/notes/plain.md"
eb undo "$op" > /dev/null || fail "undo"
[[ "$(tree_sum)" == "$sum0" ]] || fail "undo did not restore the originals byte for byte"
eb undo "$op" > /dev/null 2>&1 && fail "a second undo succeeded"

# Recall record: a search over MCP appends {recall_id, ts, principal, ids} to <stateDir>/recalls.jsonl.
eb ids assign > /dev/null || fail "ids assign (second run)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"cogphaseonemarker"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ids_assign","arguments":{}}}'
  sleep 1
} | eb mcp > "$tmp/stdout.jsonl" 2> "$tmp/stderr.log" || fail "ebrain mcp exited non-zero"
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const s = lines.find((l) => l.id === 2).result;
if (s.isError) process.exit(1);
const rid = JSON.parse(s.content[0].text.split("\n")[0]).recall_id;
if (!lines.find((l) => l.id === 3).result.isError) process.exit(2);
const recs = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(JSON.parse);
if (recs.length !== 1) process.exit(3);
const r = recs[0];
if (r.recall_id !== rid || r.principal !== "chris" || Number.isNaN(Date.parse(r.ts)) || r.ids.length !== 2) process.exit(4);
if (!r.ids.every((x) => /^[0-9A-Z]{26}$/.test(x.id) && /^[0-9a-f]{16}$/.test(x.rev))) process.exit(5);
if (fs.readFileSync(process.argv[2], "utf8").includes("cogphaseonemarker")) process.exit(6);' "$tmp/stdout.jsonl" "$tmp/state/recalls.jsonl" \
  || fail "recall record over MCP (or an ids/undo tool was exposed)"
[[ "$(stat -f '%Lp' "$tmp/state/recalls.jsonl" 2>/dev/null || stat -c '%a' "$tmp/state/recalls.jsonl")" == "600" ]] || fail "recalls.jsonl mode is not 0600"
eb recalls prune > "$tmp/prune.out" || fail "recalls prune"
grep -q 'kept 1, removed 0 (older than 180 days)' "$tmp/prune.out" || fail "recalls prune default retention"
if find "$tmp/vault" -iname '*undo*' -o -name 'recalls.jsonl' | grep -q .; then fail "state data in the vault"; fi

echo "cog-phase01: OK"
