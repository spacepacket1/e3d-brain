#!/usr/bin/env bash
# Cognition Phase 6 verification: the `reflect` job (structural
# thesis/outcome pairing from evidence files, model lessons whose citations
# must resolve, numeric and guardrail checks, contradiction -> supersede,
# taint), refusal without evidence, and accept/undo through the review queue.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase06: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/cognition/jobs/reflect.ts src/cognition/prompts/reflect.v1.md tests/reflect.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: registered; needs evidence; resolves citations; checks numbers and guardrails; writes only through the framework.
grep -q 'REFLECT_JOB' src/cognition/jobs/index.ts || fail "reflect job not registered"
grep -q "evidence: 'required'" src/cognition/jobs/reflect.ts || fail "reflect does not require an evidence source"
grep -q 'CitationResolver' src/cognition/jobs/reflect.ts || fail "reflect does not resolve citations"
grep -q 'unsupportedNumbers' src/cognition/jobs/reflect.ts || fail "reflect does not check numbers"
grep -q 'ACTION_VERBS' src/cognition/jobs/reflect.ts || fail "reflect has no action-verb deny-list"
grep -q 'strict: true' src/cognition/jobs/reflect.ts || fail "reflect does not scrub lessons in strict mode"
grep -q 'LESSON_BANNER' src/review/queue.ts || fail "review show has no lesson banner"
if grep -nE "writeAtomic|createExclusive|renameSafe|writeInboxFile|appendSafe|unlink|rmSync|rm\(" src/cognition/jobs/reflect.ts; then fail "reflect writes or deletes files itself (C1, C10)"; fi
if grep -nE "from '\.\./\.\./(net|llm/(openai|anthropic))" src/cognition/jobs/reflect.ts; then fail "reflect reaches the network directly"; fi
if grep -rnE "from '\.\./cognition/" src/mcp; then fail "src/mcp imports cognition code"; fi
# Lessons rank through the existing tiers: rank.ts has no tier of its own for them (the only kind check is the journal-lesson tiers T3/T4).
[[ "$(grep -c "kind === 'lesson'" src/index/rank.ts)" == "1" ]] || fail "rank.ts special-cases lessons (they must rank through the existing tiers)"

# Docs.
grep -q '^### The reflect job' docs/SETUP.md || fail "docs/SETUP.md lacks the reflect section"
for key in cognition.reflect.maxLessons cognition.reflect.minDuplicateJaccard cognition.reflect.decisions; do
  grep -q "\`$key\`" docs/SETUP.md || fail "docs/SETUP.md config table lacks $key"
done

npm run build
# Full suite: pairing, citation resolution, dropped lessons (unknown outcome, unsupported number, guardrails),
# the guardrail corpus, refusal without evidence, accept/undo, contradiction -> supersede, taint, decisions;
# plus every earlier phase.
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog6-")))')"
mock_pid=""
trap '[[ -n "$mock_pid" ]] && kill "$mock_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal trader --type agent --mode journal --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
setcfg() {
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));Object.assign(c,JSON.parse(process.argv[2]));fs.writeFileSync(f,JSON.stringify(c));' "$EBRAIN_CONFIG" "$1"
}
j="$tmp/vault/journal/trader/2026"
mkdir -p "$j"
printf -- '---\nid: entry_win_1\ntitle: ETH over BTC\ncreated: 2026-09-02T10:00:00Z\nstatus: journal\nkind: decision\nsources: [thesis:th_win]\nuntrusted_origin: false\n---\nOpened the ETH over BTC thesis on rotation flows.\n<!-- mock:badoutcome -->\n' > "$j/20260902-100000-eth.md"
printf -- '---\nid: entry_loss_1\ntitle: SOL support\ncreated: 2026-09-06T10:00:00Z\nstatus: journal\nkind: decision\nsources: [thesis:th_loss]\nuntrusted_origin: true\n---\nExpecting SOL support to hold through the unlock.\n<!-- mock:badnumber -->\n' > "$j/20260906-100000-sol.md"
cat > "$tmp/e3d.jsonl" <<'EOF'
{"kind":"thesis","id":"th_win","occurred":"2026-09-01T00:00:00Z","summary":"Expected ETH to outperform BTC over two weeks.","attributes":{"status":"closed"}}
{"kind":"outcome","id":"oc_win","occurred":"2026-09-15T00:00:00Z","summary":"ETH outperformed BTC by 4.2% over two weeks.","attributes":{"thesis":"th_win","result":"win","metric":"+4.2%"}}
{"kind":"thesis","id":"th_loss","occurred":"2026-09-05T00:00:00Z","summary":"Expected SOL to hold support during the unlock week.","attributes":{"status":"closed"}}
{"kind":"outcome","id":"oc_loss","occurred":"2026-09-20T00:00:00Z","summary":"SOL fell 12% during the unlock week.","attributes":{"thesis":"th_loss","result":"loss"}}
EOF

node dist/tests/llm-mock-server.js "$tmp/requests.log" > "$tmp/port" &
mock_pid=$!
for _ in $(seq 1 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(head -n1 "$tmp/port")"
[[ -n "$port" ]] || fail "mock server did not start"
setcfg '{"llm":{"provider":"openai-compatible","model":"mock-1","baseUrl":"http://127.0.0.1:'"$port"'/v1"}}'

# No evidence source: a clear message, nothing created (no proposal, no run record).
if eb cognition run reflect > "$tmp/noev.out" 2> "$tmp/noev.err"; then fail "reflect ran without an evidence source"; fi
grep -q 'needs an evidence source' "$tmp/noev.err" || { cat "$tmp/noev.err" >&2; fail "no clear message without evidence"; }
[[ ! -e "$tmp/vault/_inbox" ]] || [[ -z "$(ls "$tmp/vault/_inbox")" ]] || fail "reflect wrote to the vault without evidence"
[[ ! -d "$tmp/state/runs" ]] || [[ -z "$(ls "$tmp/state/runs")" ]] || fail "reflect wrote a run record without evidence"

# With evidence: one lesson per thesis; the unknown-outcome and unsupported-number lessons are dropped.
eb evidence import "$tmp/e3d.jsonl" > /dev/null || fail "evidence import"
eb cognition run reflect > "$tmp/run.out" || { cat "$tmp/run.out" >&2; fail "cognition run reflect"; }
grep -q 'proposals: 2 created' "$tmp/run.out" || { cat "$tmp/run.out" >&2; fail "proposal count"; }
grep -q 'lessons: 4 proposed by the model, 2 kept; dropped 1 with unresolved citations' "$tmp/run.out" || { cat "$tmp/run.out" >&2; fail "unresolved outcome not dropped"; }
grep -q '1 with unsupported numbers' "$tmp/run.out" || fail "unsupported number not dropped"
if grep -lE 'oc_missing|73 percent' "$tmp/vault/_inbox/"*.md; then fail "a dropped lesson reached the inbox"; fi
loss="$(grep -l 'thesis:th_loss' "$tmp/vault/_inbox/"*.md)"
grep -q '^untrusted_origin: true' "$loss" || fail "taint did not carry into the lesson proposal"
grep -q 'untrusted_origin: true' <(sed -n '/ebrain-change/,/```$/p' "$loss") || fail "the lesson note is not flagged untrusted"
eb cognition run reflect | grep -q 'proposals: 0 created, 2 already in _inbox/' || fail "re-run created proposals"
if grep -lE "rotation flows|outperformed|unlock week" "$tmp/state/runs/"*.json; then fail "note or record text in a run record"; fi

# Accept the win lesson: written under lessons/trader/ with structured derived_from; undo removes only it.
win="$(grep -l 'thesis:th_win' "$tmp/vault/_inbox/"*.md)"
wid="$(sed -n 's/^id: //p' "$win" | head -n1)"
eb review show "$wid" | grep -q 'advisory, unverified' || fail "review show lacks the advisory banner"
before="$(cd "$tmp/vault" && find . -name '*.md' -not -path './_inbox/*' | sort)"
eb review accept "$wid" > /dev/null || fail "review accept lesson"
lesson="$(ls "$tmp/vault/lessons/trader/"*.md)"
[[ -n "$lesson" ]] || fail "lesson not written"
grep -q '^status: accepted$' "$lesson" || fail "lesson not accepted"
grep -q '^kind: lesson$' "$lesson" || fail "lesson kind"
grep -q '^derived_from:$' "$lesson" || fail "derived_from not a list"
grep -qE '^  - note:entry_win_1@[0-9a-f]{16}$' "$lesson" || fail "derived_from lacks the entry"
grep -q '^  - thesis:th_win$' "$lesson" || fail "derived_from lacks the thesis"
grep -q '^  - outcome:oc_win$' "$lesson" || fail "derived_from lacks the outcome"
eb review undo "$wid" > /dev/null || fail "review undo lesson"
[[ ! -e "$lesson" ]] || fail "undo left the lesson"
after="$(cd "$tmp/vault" && find . -name '*.md' -not -path './_inbox/*' | sort)"
[[ "$before" == "$after" ]] || fail "undo changed other files"

echo "cog-phase06: OK"
