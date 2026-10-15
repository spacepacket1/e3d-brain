#!/usr/bin/env bash
# Phase 14 verification: shared LLM layer (src/llm/) and `ebrain propose`.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase14: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/yauzl ]] || npm ci --ignore-scripts

for f in src/llm/provider.ts src/llm/openai-compatible.ts src/llm/anthropic.ts src/llm/schema.ts src/llm/budget.ts \
  src/llm/prompts/index.ts src/llm/prompts/propose.v1.ts src/net/http.ts src/propose/propose.ts src/propose/archive-reader.ts \
  src/cli/propose-command.ts tests/propose.test.ts tests/llm-mock-server.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: no provider or network code under src/propose/; propose imports src/llm/.
if grep -rnE "from '\.\./net/|openai-compatible\.js|anthropic\.js|fetch\(|chat/completions|v1/messages|x-api-key" src/propose; then
  fail "provider code under src/propose/"
fi
grep -q "from '../llm/" src/propose/propose.ts || fail "propose does not import src/llm/"
if grep -rnE "\bfetch\(|from 'node:(net|http|https)'" src/llm; then fail "network API in src/llm/ (must go through src/net/)"; fi

# Docs.
grep -q '^## Candidate notes (propose)' docs/SETUP.md || fail "SETUP lacks the propose section"
for pat in 'llm.provider' 'llm.model' 'llm.baseUrl' 'llm.apiKeyEnv' 'llm.maxCallsPerRun' 'llm.maxInputCharsPerRun' '--i-understand-data-leaves-machine' 'confidence: unrated'; do
  grep -qF -- "$pat" docs/SETUP.md || fail "SETUP lacks: $pat"
done
grep -q 'Candidate proposals (Phase 14' docs/SECURITY.md || fail "SECURITY lacks the propose bullet"

npm run build
# Full suite: Phases 1-13 plus propose.test (config, llm layer, propose end to end, layout scan).
npm test

# End to end from the shell, with a loopback mock LLM server.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p14-")))')"
mock_pid=""
cleanup() { [[ -n "$mock_pid" ]] && kill "$mock_pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
root="$PWD"
eb() { node "$root/dist/src/cli/main.js" "$@"; }
mkdir -p "$tmp/vault/notes" "$tmp/projects/proj"
printf '# Keep\n\nCurated.\n' > "$tmp/vault/notes/keep.md"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
setcfg() { node -e '
const fs=require("fs"); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8"));
Object.assign(c, JSON.parse(process.argv[2])); fs.writeFileSync(f,JSON.stringify(c));' "$tmp/cfg/config.json" "$1"; }

secret="sk-Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9aB2cD4eF6gH8iJ0kL2mN4"
printf '%s\n' \
  '{"type":"user","sessionId":"s1","timestamp":"2026-10-14T10:00:00Z","message":{"role":"user","content":"my key is '"$secret"' ok"}}' \
  '{"type":"assistant","sessionId":"s1","timestamp":"2026-10-14T10:01:00Z","message":{"role":"assistant","id":"m1","content":[{"type":"text","text":"Thanks."}]}}' \
  '{"type":"user","sessionId":"s1","timestamp":"2026-10-14T10:02:00Z","message":{"role":"user","content":"We decided to ship on Fridays only."}}' > "$tmp/projects/proj/s1.jsonl"
eb import claude-code --projects-dir "$tmp/projects" > /dev/null || fail "import"

vault_sum() { (cd "$tmp/vault" && find . -type f -not -path './_inbox/*' -print0 | sort -z | xargs -0 shasum -a 256) | shasum -a 256; }
before="$(vault_sum)"

# Provider none: message, exit 1, nothing written.
out="$(eb propose 2>&1 && echo rc=0 || echo rc=$?)"
[[ "$out" == *"no extraction provider is configured"* && "$out" == *"rc=1"* ]] || fail "provider none: $out"
[[ ! -e "$tmp/vault/_inbox" ]] || [[ -z "$(ls "$tmp/vault/_inbox")" ]] || fail "provider none wrote to _inbox/"

node dist/tests/llm-mock-server.js "$tmp/requests.log" > "$tmp/port" &
mock_pid=$!
for _ in $(seq 1 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(head -n1 "$tmp/port")"
[[ -n "$port" ]] || fail "mock server did not start"

# anthropic without the flag refuses before any request.
setcfg '{"network":{"allowedHosts":["api.anthropic.com"]},"llm":{"provider":"anthropic","model":"claude-mock","baseUrl":"http://127.0.0.1:'"$port"'","apiKeyEnv":"EBRAIN_P14_KEY"}}'
out="$(EBRAIN_P14_KEY=k eb propose 2>&1 && echo rc=0 || echo rc=$?)"
[[ "$out" == *"--i-understand-data-leaves-machine"* && "$out" == *"rc=1"* ]] || fail "anthropic without flag: $out"
[[ ! -s "$tmp/requests.log" ]] || fail "anthropic sent a request without the flag"

# openai-compatible: one candidate citing a turn range; malformed items counted.
setcfg '{"network":{"allowedHosts":[]},"llm":{"provider":"openai-compatible","model":"mock-1","baseUrl":"http://127.0.0.1:'"$port"'/v1"}}'
eb propose > "$tmp/p1.out" || { cat "$tmp/p1.out" >&2; fail "propose"; }
grep -q '1 candidates created, 0 duplicates skipped' "$tmp/p1.out" || { cat "$tmp/p1.out" >&2; fail "candidate count"; }
grep -q 'dropped: 1 invalid items, 1 unsupported quotes, 0 malformed responses' "$tmp/p1.out" || { cat "$tmp/p1.out" >&2; fail "dropped counts"; }
note="$(ls "$tmp/vault/_inbox"/*.md)"
grep -q '^confidence: unrated' "$note" || fail "confidence"
grep -q '^status: proposed' "$note" || fail "status"
grep -qE '^  - note:raw_[0-9a-f]{32}@[0-9a-f]{16}#turns-3-3$' "$note" || fail "turn-range citation"
grep -qF -- "$secret" "$tmp/requests.log" && fail "raw secret in a provider request"
grep -q 'REDACTED' "$tmp/requests.log" || fail "request lacks redaction marker"

# Idempotent; nothing outside _inbox/ changed.
eb propose > "$tmp/p2.out" || fail "propose (second run)"
grep -q '0 candidates created, 1 duplicates skipped' "$tmp/p2.out" || { cat "$tmp/p2.out" >&2; fail "second run duplicated"; }
[[ "$(ls "$tmp/vault/_inbox" | wc -l | tr -d ' ')" == "1" ]] || fail "duplicate inbox files"
[[ "$(vault_sum)" == "$before" ]] || fail "vault changed outside _inbox/"

# Mode refusal.
setcfg '{"mode":"read-only"}'
out="$(eb propose 2>&1 && echo rc=0 || echo rc=$?)"
[[ "$out" == *'needs mode "inbox"'* && "$out" == *"rc=1"* ]] || fail "read-only mode: $out"

echo "phase14: OK"
