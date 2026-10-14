#!/usr/bin/env bash
# Phase 15 verification: optional loopback HTTP transport (src/net/http-server.ts, token.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase15: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/yauzl ]] || npm ci --ignore-scripts

for f in src/net/http-server.ts src/net/token.ts src/cli/token-command.ts tests/http.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: network server APIs only under src/net/.
if grep -rnE "from 'node:(http|https|net)'" src | grep -v '^src/net/'; then fail "network API outside src/net/"; fi

grep -q '^## Optional HTTP transport' docs/SETUP.md || fail "SETUP lacks the HTTP section"
for pat in 'ebrain token create --principal' 'mcp --http' 'unsupported'; do
  grep -qF -- "$pat" docs/SETUP.md || fail "SETUP lacks: $pat"
done
grep -q 'Optional HTTP transport (Phase 15' docs/SECURITY.md || fail "SECURITY lacks the HTTP bullet"

npm run build
# Full suite: Phases 1-14 plus http.test (bind refusal, tokens, hashed storage, two-instance isolation, source scans).
npm test

# Shell E2E.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p15-")))')"
pid=""
cleanup() { [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/vault"
echo '{"vaultPath":"'"$tmp"'/vault","stateDir":"'"$tmp"'/state","principal":{"id":"alice","type":"human"},"mode":"inbox"}' > "$tmp/config.json"
chmod 600 "$tmp/config.json"
eb() { HOME="$tmp" EBRAIN_CONFIG="$tmp/config.json" node dist/src/cli/main.js "$@"; }

out="$(eb mcp --http --host 0.0.0.0 2>&1 && echo rc=0 || echo rc=$?)"
[[ "$out" == *loopback* && "$out" == *rc=1* ]] || fail "0.0.0.0 not refused: $out"

tok="$(eb token create --principal alice 2>/dev/null)"
secret="${tok#*.}"
if grep -rF -- "$secret" "$tmp/state"; then fail "plaintext token in state dir"; fi

HOME="$tmp" EBRAIN_CONFIG="$tmp/config.json" node dist/src/cli/main.js mcp --http --port 0 > /dev/null 2> "$tmp/err.log" & pid=$!
url=""
for _ in $(seq 1 50); do
  url="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/mcp' "$tmp/err.log" | head -1 || true)"
  [[ -n "$url" ]] && break
  sleep 0.2
done
[[ -n "$url" ]] || fail "server did not start"
body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
code() { curl -s -o /dev/null -w '%{http_code}' -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$@" -d "$body"; }
[[ "$(code)" == 401 ]] || fail "missing token"
[[ "$(code -H 'Authorization: Bearer wrong')" == 401 ]] || fail "wrong token"
[[ "$(code -H "Authorization: Bearer ${tok}x")" == 401 ]] || fail "malformed token"
[[ "$(code -H "Authorization: Bearer $tok")" == 200 ]] || fail "valid token"
grep -qF -- "$secret" "$tmp/err.log" && fail "token in server log"

echo "phase15: OK"
