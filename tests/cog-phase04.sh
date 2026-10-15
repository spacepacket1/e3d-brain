#!/usr/bin/env bash
# Cognition Phase 4 verification: the `supersede` job (deterministic
# candidates, LLM adjudication with verbatim quotes, unadjudicated fallback),
# its change block applied and undone through the review queue, and search
# honoring superseded status and as_of.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase04: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/cognition/jobs/supersede.ts src/cognition/shingle.ts src/cognition/prompts/supersede.v1.md tests/supersede.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: the job is registered, deterministic candidates use no model, quotes are verified, writes go through the framework.
grep -q 'SUPERSEDE_JOB' src/cognition/jobs/index.ts || fail "supersede job not registered"
grep -q 'quoteAppears' src/cognition/jobs/supersede.ts || fail "supersede does not verify quotes"
if grep -nE "writeAtomic|createExclusive|renameSafe|writeInboxFile|appendSafe" src/cognition/jobs/supersede.ts; then fail "supersede writes files itself (C1)"; fi
if grep -nE "from '\.\./\.\./(net|llm/(openai|anthropic))" src/cognition/jobs/supersede.ts src/cognition/shingle.ts; then fail "supersede reaches a provider directly"; fi
if grep -rnE "from '\.\./cognition/" src/mcp; then fail "src/mcp imports cognition code"; fi
grep -q 'needs_review' src/review/proposal.ts || fail "proposal schema lacks needs_review"

# Docs.
grep -q '^### The supersede job' docs/SETUP.md || fail "docs/SETUP.md lacks the supersede section"
for key in cognition.supersede.minJaccard cognition.supersede.maxUnadjudicated; do
  grep -q "\`$key\`" docs/SETUP.md || fail "docs/SETUP.md config table lacks $key"
done

npm run build
# Full suite: shingles and quote checks, candidates (tags, mutual links, same-kind overlap, dates, pinned,
# provisional, undated), adjudication (supersedes/conflicts/compatible/unrelated, unverified quotes dropped),
# unadjudicated cap, the Postgres -> SQLite fixture with search/as_of and undo, idempotence and rejection memory,
# the 20/22 fixture corpus, config; plus every earlier phase.
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog4-")))')"
mock_pid=""
trap '[[ -n "$mock_pid" ]] && kill "$mock_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode read-only --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
setcfg() {
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));Object.assign(c,JSON.parse(process.argv[2]));fs.writeFileSync(f,JSON.stringify(c));' "$EBRAIN_CONFIG" "$1"
}
mkdir -p "$tmp/vault/notes"
printf -- '---\ntitle: Database choice\noccurred: 2026-03-10\nkind: decision\ntags: [database]\n---\nWe use Postgres for the main database.\n' > "$tmp/vault/notes/db-old.md"
printf -- '---\ntitle: Database migration\noccurred: 2026-06-20\nkind: decision\ntags: [database]\n---\nWe moved to SQLite for the main database.\n<!-- mock:supersedes -->\n' > "$tmp/vault/notes/db-new.md"
printf -- '---\ntitle: Pinned rule\noccurred: 2026-01-05\ntags: [style]\npinned: true\n---\nTabs for indentation.\n' > "$tmp/vault/notes/style-old.md"
printf -- '---\ntitle: New rule\noccurred: 2026-04-05\ntags: [style]\n---\nSpaces for indentation.\n<!-- mock:supersedes -->\n' > "$tmp/vault/notes/style-new.md"
eb ids assign > /dev/null || fail "ids assign"

# Without a provider: unadjudicated proposals; a pinned older note is never proposed.
eb cognition run supersede --dry-run > "$tmp/dry.out" || fail "dry run"
grep -q '1 would be created' "$tmp/dry.out" || { cat "$tmp/dry.out" >&2; fail "dry run count"; }
[[ ! -e "$tmp/vault/_inbox" ]] || [[ -z "$(ls "$tmp/vault/_inbox")" ]] || fail "dry run wrote to the vault"
eb cognition run supersede > "$tmp/run0.out" || fail "cognition run supersede (no provider)"
grep -q 'proposals: 1 created' "$tmp/run0.out" || { cat "$tmp/run0.out" >&2; fail "unadjudicated proposal count"; }
grep -q 'skipped 1 with a pinned older note' "$tmp/run0.out" || fail "pinned older note not skipped"
grep -lq 'needs_review: unadjudicated' "$tmp/vault/_inbox/"*.md || fail "proposal not marked needs_review: unadjudicated"
if grep -l 'style-old' "$tmp/vault/_inbox/"*.md; then fail "a pinned note was proposed as superseded"; fi
eb cognition run supersede | grep -q 'proposals: 0 created, 1 already in _inbox/' || fail "re-run created proposals"
un="$(eb review list | grep 'supersede' | cut -f1)"
eb review reject "$un" --reason "use the model" > /dev/null || fail "reject the unadjudicated proposal"

# With the mock provider: --reconsider re-adjudicates the rejected pair.
node dist/tests/llm-mock-server.js "$tmp/requests.log" > "$tmp/port" &
mock_pid=$!
for _ in $(seq 1 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(head -n1 "$tmp/port")"
[[ -n "$port" ]] || fail "mock server did not start"
setcfg '{"llm":{"provider":"openai-compatible","model":"mock-1","baseUrl":"http://127.0.0.1:'"$port"'/v1"}}'
eb cognition run supersede | grep -q '1 previously rejected (skipped)' || fail "rejected pair re-proposed"
[[ ! -s "$tmp/requests.log" ]] || fail "a rejected pair was sent to the model"
eb cognition run supersede --reconsider > "$tmp/run1.out" || fail "cognition run supersede (mock provider)"
grep -q 'verdicts: 1 supersedes' "$tmp/run1.out" || { cat "$tmp/run1.out" >&2; fail "verdicts"; }
grep -q 'proposals: 1 created' "$tmp/run1.out" || fail "adjudicated proposal count"
id="$(eb review list | grep 'supersede' | cut -f1)"
[[ -n "$id" ]] || fail "proposal not listed"
grep -q '> We use Postgres for the main database.' "$tmp/vault/_inbox/"*supersede*.md || fail "quote missing"
if grep -lE "Postgres|SQLite" "$tmp/state/runs/"*.json; then fail "note text in a run record"; fi

# Accept sets the fields on both notes; undo restores them byte for byte.
cp "$tmp/vault/notes/db-old.md" "$tmp/old.orig"; cp "$tmp/vault/notes/db-new.md" "$tmp/new.orig"
eb review accept "$id" > /dev/null || fail "review accept"
newid="$(sed -n 's/^id: //p' "$tmp/vault/notes/db-new.md")"; oldid="$(sed -n 's/^id: //p' "$tmp/vault/notes/db-old.md")"
grep -q '^status: superseded$' "$tmp/vault/notes/db-old.md" || fail "status not set"
grep -q "^superseded_by: $newid\$" "$tmp/vault/notes/db-old.md" || fail "superseded_by not set"
grep -q '^superseded_at: 2026-06-20$' "$tmp/vault/notes/db-old.md" || fail "superseded_at not set"
grep -q '^valid_until: 2026-06-20$' "$tmp/vault/notes/db-old.md" || fail "valid_until not set"
grep -q "$oldid" "$tmp/vault/notes/db-new.md" || fail "supersedes not set on the newer note"

# Search (MCP): hidden by default, shown with as_of March.
search() {
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"Postgres"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"Postgres","as_of":"2026-03-15"}}}'
    sleep 1
  } | eb mcp > "$tmp/search.jsonl" 2> "$tmp/search.err" || fail "ebrain mcp exited non-zero"
}
search
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const text = (id) => lines.find((l) => l.id === id).result.content[0].text;
if (text(2).includes("notes/db-old.md")) process.exit(1);
if (!text(3).includes("notes/db-old.md")) process.exit(2);' "$tmp/search.jsonl" || fail "search does not honor superseded status / as_of"

eb review undo "$id" > /dev/null || fail "review undo"
cmp -s "$tmp/old.orig" "$tmp/vault/notes/db-old.md" || fail "undo did not restore the older note"
cmp -s "$tmp/new.orig" "$tmp/vault/notes/db-new.md" || fail "undo did not restore the newer note"

echo "cog-phase04: OK"
