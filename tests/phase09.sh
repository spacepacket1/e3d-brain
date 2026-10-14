#!/usr/bin/env bash
# Phase 9 verification: agent principals in journal mode (journal_append,
# journal_list, limits, expiry and prune) and workspace import.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase09: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/journal/entry.ts src/journal/store.ts src/journal/prune.ts src/journal/import.ts src/mcp/journal-tools.ts \
  src/cli/journal-commands.ts tests/journal.test.ts tests/journal-mcp.test.ts tests/journal-worker.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Registry fixture: journal gains journal_append and journal_list at phase 9; no other mode does.
node -e '
const t = JSON.parse(require("fs").readFileSync("tests/fixtures/tools-by-mode.json", "utf8"));
const at9 = (m) => t.filter((e) => e.phase <= 9 && e.modes.includes(m)).map((e) => e.name).sort().join(",");
if (at9("journal") !== "journal_append,journal_list,list_notes,read_note,related,search") process.exit(1);
if (at9("inbox") !== "capture,list_inbox,list_notes,read_note,related,search") process.exit(1);
if (at9("read-only") !== "list_notes,read_note,related,search") process.exit(1);
if (t.some((e) => /accept|promote|edit|delete|move|overwrite|run|job|start/.test(e.name))) process.exit(1);' \
  || fail "tools-by-mode.json phase-9 entries"

# Static: src/mcp/ still has no filesystem write calls; journal tools reach the vault only through the store.
if grep -nE '\b(createExclusive|writeAtomic|renameSafe|unlinkSafe|mkdirSafe|appendSafe|writeFileSync|renameSync|unlinkSync|mkdirSync)\b' src/mcp/*.ts; then
  fail "filesystem write call in src/mcp/"
fi
grep -q "from '../journal/store.js'" src/mcp/journal-tools.ts || fail "journal tools do not use the journal store"
grep -q "modes: \['journal'\]" src/mcp/journal-tools.ts || fail "journal tools are not journal-mode only"
if grep -nE "import|prune" src/mcp/journal-tools.ts | grep -E "journal/(import|prune)"; then fail "MCP imports the owner CLI journal modules"; fi
# The store never renames, unlinks, or rewrites entries.
if grep -nE '\b(writeAtomic|renameSafe|unlinkSafe|appendSafe)\b' src/journal/store.ts; then fail "journal store can modify existing files"; fi
grep -q 'createExclusive' src/journal/store.ts || fail "journal store does not publish with createExclusive"
grep -q 'journal-\${' src/journal/store.ts || fail "journal store does not take the journal-<principal-id> lock"
grep -q 'openExternalFile' src/journal/import.ts || fail "workspace import does not read through openExternalFile"
if grep -nE '\bunlinkSafe\b' src/journal/prune.ts; then fail "prune deletes files"; fi
# T3-T5 rows and the citation kinds live in rank.ts.
grep -q "GROUNDING_CITATION_KINDS" src/index/rank.ts || fail "rank.ts lacks the T3 citation kinds"
if grep -rln "node:child_process" src | grep -v '^src/exec/'; then fail "child_process outside src/exec/"; fi

# Docs.
grep -q '^## Agents' docs/SETUP.md || fail "docs/SETUP.md lacks the Agents section"
for pat in 'journal_append' 'ebrain import agent-workspace' 'ebrain journal prune' 'limits.maxCharsPerCall' '"format": "compact"' 'read-only' 'inbox' 'git' 'journal.maxEntriesPerHour'; do
  sed -n '/^## Agents/,/^## Several/p' docs/SETUP.md | grep -qF -- "$pat" || fail "SETUP Agents section lacks: $pat"
done
grep -q 'journal.maxTotalMB' docs/SETUP.md || fail "docs/SETUP.md config table lacks journal.maxTotalMB"
grep -q 'Journal (Phase 9' docs/SECURITY.md || fail "docs/SECURITY.md lacks the journal bullet"
grep -q 'newestFirst' docs/RANKING.md || fail "docs/RANKING.md lacks the journal_list order"

npm run build
# Full suite: Phases 1-8 plus journal entry names and dedup normalization,
# the store (hostile principal ids, symlinked dirs, create-only, limits from
# the filesystem), journal tools via dispatch (strict scrub, provenance,
# author refused, limits audited, immediate search), the T1-T5 ranking
# fixture and labels, expiry/include_expired/prune, workspace import, and the
# spawned servers (expectedTools(<mode>, 9), the same-name race, limits with
# two processes, isolation of two agents, the owner CLI).
npm test

# End to end from the shell: init an agent brain, append over MCP, search it, prune, import.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p9-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal bot-9 --type agent --mode journal --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init (journal)"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"journal_append","arguments":{"title":"../../Phase nine","body":"phaseninemarker lesson","kind":"lesson","sources":["commit:abc1234"]}}}'
  sleep 1
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"phaseninemarker"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"journal_append","arguments":{"title":"Again","body":"phaseninemarker lesson"}}}'
  sleep 1
} | node dist/src/cli/main.js mcp > "$tmp/stdout.jsonl" 2> "$tmp/stderr.log" || fail "ebrain mcp exited non-zero"
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const byId = (id) => lines.find((l) => l.id === id).result;
const a = byId(2);
if (a.isError) process.exit(1);
const h = JSON.parse(a.content[0].text.split("\n")[0]);
if (!/^journal\/bot-9\/\d{4}\/\d{8}-\d{6}-phase-nine\.md$/.test(h.path)) process.exit(2);
const s = byId(3).content[0].text;
if (!s.includes(h.path) || !s.includes("agent-journal") || !s.includes("\"tier\":3")) process.exit(3);
const d = byId(4);
if (!d.isError || !d.content[0].text.includes(h.path)) process.exit(4);' "$tmp/stdout.jsonl" || fail "journal_append / search / dedup over MCP"
[[ "$(find "$tmp/vault/journal/bot-9" -name '*.md' | wc -l | tr -d ' ')" == "1" ]] || fail "expected exactly one journal file"
[[ "$(find "$tmp/vault" -type f -name '*.md' | grep -vc '/journal/bot-9/' || true)" == "0" ]] || fail "journal_append wrote outside journal/bot-9/"
grep -q 'phaseninemarker' "$tmp/state/audit.jsonl" && fail "audit leaked the entry body"
grep -q '"code":"duplicate"' "$tmp/state/audit.jsonl" || fail "duplicate rejection not audited"

# Prune: an expired entry moves to journal/_archive/bot-9/<yyyy>/ and nothing is deleted.
mkdir -p "$tmp/vault/journal/bot-9/2025"
printf -- '---\nstatus: journal\nexpires: 2025-01-01\n---\nold\n' > "$tmp/vault/journal/bot-9/2025/20250101-000000-old.md"
count_before="$(find "$tmp/vault" -type f | wc -l)"
node dist/src/cli/main.js journal prune > "$tmp/prune.out" || fail "journal prune"
grep -q '1 archived' "$tmp/prune.out" || fail "prune did not archive the expired entry"
[[ -f "$tmp/vault/journal/_archive/bot-9/2025/20250101-000000-old.md" ]] || fail "archived entry not at journal/_archive/bot-9/2025/"
[[ "$(find "$tmp/vault" -type f | wc -l)" == "$count_before" ]] || fail "prune changed the file count"

# Import: idempotent, source unchanged, a file with a fake private key skipped.
ws="$tmp/workspace"
mkdir -p "$ws/memory"
printf '# Memory\n\nfacts\n' > "$ws/MEMORY.md"
printf '# Goals\n\n- ship\n' > "$ws/GOALS.md"
printf 'day one\n' > "$ws/memory/2026-10-01.md"
label="$(printf '%s %s %s' RSA PRIVATE KEY)"
body="$(node -e 'const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";let s="";for(let l=0;l<4;l++){for(let i=0;i<64;i++)s+=c[(i*7+l*13+i*i)%64];s+="\n"}process.stdout.write(s)')"
printf -- '-----BEGIN %s-----\n%s\n-----END %s-----\n' "$label" "$body" "$label" > "$ws/memory/2026-10-02.md"
sum_before="$(find "$ws" -type f -exec shasum {} + | sort | shasum)"
node dist/src/cli/main.js import agent-workspace "$ws" --principal other-bot > /dev/null 2>&1 && fail "import accepted a foreign principal"
node dist/src/cli/main.js import agent-workspace "$ws" --principal bot-9 > "$tmp/import1.out" || fail "import agent-workspace"
grep -q '3 imported, 0 unchanged, 1 skipped' "$tmp/import1.out" || { cat "$tmp/import1.out" >&2; fail "first import summary"; }
grep -q 'skipped memory/2026-10-02.md' "$tmp/import1.out" || fail "private-key file not skipped"
node dist/src/cli/main.js import agent-workspace "$ws" --principal bot-9 > "$tmp/import2.out" || fail "second import"
grep -q '0 imported, 3 unchanged, 1 skipped' "$tmp/import2.out" || fail "import is not idempotent"
[[ "$(find "$ws" -type f -exec shasum {} + | sort | shasum)" == "$sum_before" ]] || fail "import modified the source directory"
grep -rq 'PRIVATE KEY' "$tmp/vault/journal" && fail "private key reached the vault"

echo "phase09: OK"
