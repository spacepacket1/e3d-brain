#!/usr/bin/env bash
# Phase 12 verification: optional local embeddings and hybrid search.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase12: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/yauzl ]] || npm ci --ignore-scripts

for f in src/net/hosts.ts src/net/ollama.ts src/index/vectors.ts tests/embeddings.test.ts tests/embed-mock-server.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: I3 (network APIs only in src/net/) and the dependency set.
if grep -rnE "from 'node:(net|http|https|http2|dgram|tls)'|\bfetch\(|XMLHttpRequest|new WebSocket" src | grep -v '^src/net/'; then fail "network API outside src/net/"; fi
grep -q "provider === 'none'" src/net/ollama.ts || fail "createEmbedder does not short-circuit provider none"
node -e '
const p = require("./package.json");
const deps = Object.keys(p.dependencies).sort().join(",");
if (deps !== "@modelcontextprotocol/sdk,better-sqlite3,yaml,yauzl") { console.error(deps); process.exit(1); }' || fail "unexpected runtime dependency"
grep -q '^## Vector storage (Phase 12)' docs/DEPENDENCIES.md || fail "DEPENDENCIES lacks the vector storage decision"

# Docs.
grep -q '^## Optional embeddings' docs/SETUP.md || fail "SETUP lacks the embeddings section"
for pat in 'embeddings.provider' 'embeddings.model' 'embeddings.baseUrl' 'embeddings.store' 'network.allowedHosts' 'Reciprocal Rank Fusion'; do
  grep -qF -- "$pat" docs/SETUP.md || fail "SETUP lacks: $pat"
done
grep -q 'Embeddings (Phase 12' docs/SECURITY.md || fail "SECURITY lacks the embeddings bullet"
grep -q 'Reciprocal Rank Fusion' docs/RANKING.md || fail "RANKING lacks the RRF rule"

npm run build
# Full suite: Phases 1-11 plus embeddings.test (URL policy, config rejection,
# provider none with a fetch spy, mock-server hybrid search, incremental
# embedding, model switch, failure degradation, scrubbed requests, RRF order).
npm test

# End to end from the shell, with a loopback mock embedding server.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p12-")))')"
mock_pid=""
cleanup() { [[ -n "$mock_pid" ]] && kill "$mock_pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p "$tmp/home" "$tmp/vault"
export HOME="$tmp/home"
printf '# Pets\n\nOur feline naps on the sofa all afternoon.\n' > "$tmp/vault/Pets.md"
printf '# Cars\n\nThe engine needs new tires before winter.\n' > "$tmp/vault/Cars.md"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }

# A remote host that is not allowlisted is rejected at load time.
cp "$tmp/cfg/config.json" "$tmp/cfg/config.orig"
node -e '
const fs=require("fs"); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.embeddings={provider:"ollama",baseUrl:"http://gpu.example.com:11434"}; fs.writeFileSync(f,JSON.stringify(c));' "$tmp/cfg/config.json"
if eb reindex > "$tmp/rej.out" 2>&1; then fail "config with a non-allowlisted host was accepted"; fi
grep -q 'embeddings.baseUrl' "$tmp/rej.out" || { cat "$tmp/rej.out" >&2; fail "rejection does not name embeddings.baseUrl"; }

# Provider none: BM25 only, no embeddings line, no vectors.
cp "$tmp/cfg/config.orig" "$tmp/cfg/config.json"
eb reindex > "$tmp/none.out" || fail "reindex (none)"
grep -q 'embeddings' "$tmp/none.out" && fail "provider none printed an embeddings line"

node dist/tests/embed-mock-server.js > "$tmp/port" &
mock_pid=$!
for _ in $(seq 1 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(head -n1 "$tmp/port")"
[[ -n "$port" ]] || fail "mock server did not start"
node -e '
const fs=require("fs"); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.embeddings={provider:"ollama",model:"mock-1",baseUrl:"http://127.0.0.1:"+process.argv[2]}; fs.writeFileSync(f,JSON.stringify(c));' "$tmp/cfg/config.json" "$port"
eb reindex > "$tmp/emb.out" || { cat "$tmp/emb.out" >&2; fail "reindex (ollama)"; }
grep -q 'embeddings (ollama, mock-1): embedded 2, unchanged 0, failed 0' "$tmp/emb.out" || { cat "$tmp/emb.out" >&2; fail "embedding summary"; }
eb reindex | grep -q 'embedded 0, unchanged 2, failed 0' || fail "second reindex re-embedded"

# Model switch re-embeds everything.
node -e '
const fs=require("fs"); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8")); c.embeddings.model="mock-2"; fs.writeFileSync(f,JSON.stringify(c));' "$tmp/cfg/config.json"
eb reindex | grep -q 'embeddings (ollama, mock-2): embedded 2, unchanged 0' || fail "model switch did not re-embed"

# A dead server is a warning, exit 0.
kill "$mock_pid"; wait "$mock_pid" 2>/dev/null || true; mock_pid=""
printf '# Soup\n\nA kitchen recipe.\n' > "$tmp/vault/Soup.md"
eb reindex > "$tmp/dead.out" || fail "reindex failed when the embedding server was down"
grep -q 'failed 1; warnings 1' "$tmp/dead.out" || { cat "$tmp/dead.out" >&2; fail "dead server not counted as a warning"; }
grep -q '^reindex (hash): 3 notes' "$tmp/dead.out" || fail "BM25 index not updated"

echo "phase12: OK"
