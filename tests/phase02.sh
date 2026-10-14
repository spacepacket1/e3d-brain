#!/usr/bin/env bash
# Phase 2 verification: vault scanner, parser, and SQLite index.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase02: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules ]] || npm ci --ignore-scripts

for f in src/vault/scan.ts src/vault/parse.ts src/vault/chunk.ts src/vault/names.ts src/vault/markdown.ts \
         src/index/db.ts src/index/indexer.ts src/index/resolve.ts src/index/dump.ts src/index/query.ts \
         tests/fixtures/vault/Home.md tests/fixtures/vault-extra.json tests/fixtures/vault.dump; do
  [[ -f "$f" ]] || fail "missing $f"
done
[[ -L tests/fixtures/vault/outside-link.md ]] || fail "fixture symlink-to-outside missing"
grep -q '`yaml`' docs/DEPENDENCIES.md || fail "docs/DEPENDENCIES.md lacks yaml"
grep -qi 'local filesystem' docs/SETUP.md || fail "docs/SETUP.md must state the state dir is on a local filesystem"

npm run build
# Full suite: includes the Phase 1 tests, the fs-scan invariant, and the Phase 2
# parser, scanner, index, freshness, collision, golden-dump, and concurrency tests.
npm test

# CLI end-to-end over a copy of the fixture vault.
tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'chmod -R u+rwX "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
cp -R tests/fixtures/vault tests/fixtures/outside "$tmp/"
node -e '
const fs = require("fs"), path = require("path");
const m = JSON.parse(fs.readFileSync("tests/fixtures/vault-extra.json", "utf8"));
for (const f of m.files) fs.writeFileSync(path.join(process.argv[1], f.path), f.content);
' "$tmp/vault"
mkdir -p "$tmp/home"
cat > "$tmp/config.json" <<JSON
{"vaultPath": "$tmp/vault", "stateDir": "$tmp/state", "principal": {"id": "phase02", "type": "human"}, "mode": "inbox"}
JSON
chmod 600 "$tmp/config.json"
ebrain() { HOME="$tmp/home" EBRAIN_CONFIG="$tmp/config.json" node dist/src/cli/main.js "$@"; }
# SHA-256 over every path, symlink target, and file content below a directory (symlinks not followed).
checksum() { node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const h = crypto.createHash("sha256");
const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) {
  const full = path.join(d, n), r = rel + "/" + n, st = fs.lstatSync(full);
  if (st.isSymbolicLink()) h.update("L " + r + " " + fs.readlinkSync(full) + "\n");
  else if (st.isDirectory()) { h.update("D " + r + "\n"); walk(full, r); }
  else h.update("F " + r + " " + crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") + "\n");
} };
walk(process.argv[1], ""); console.log(h.digest("hex"));' "$1"; }
sha256() { node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }

before="$(checksum "$tmp/vault")"
chmod 000 "$tmp/outside/secret.md"   # reading the symlink target would fail

summary="$(ebrain reindex)"
echo "$summary"
grep -q '^malformed frontmatter: 2$' <<<"$summary" || fail "reindex summary does not count malformed frontmatter"
ebrain index dump > "$tmp/dump1"
ebrain reindex >/dev/null
ebrain index dump > "$tmp/dump2"
cmp -s "$tmp/dump1" "$tmp/dump2" || fail "reindex twice gave different dumps"
rm -f "$tmp/state/index.db" "$tmp/state/index.db-wal" "$tmp/state/index.db-shm"
ebrain reindex --full >/dev/null
ebrain index dump > "$tmp/dump3"
cmp -s "$tmp/dump1" "$tmp/dump3" || fail "delete + reindex --full gave a different dump"
cmp -s "$tmp/dump1" tests/fixtures/vault.dump || fail "dump differs from tests/fixtures/vault.dump on $(uname -s)/$(uname -m)"
grep -q 'OUTSIDE-SECRET-CANARY' "$tmp/dump1" && fail "symlink target was indexed"
chmod 644 "$tmp/outside/secret.md"
[[ "$(checksum "$tmp/vault")" == "$before" ]] || fail "vault changed during indexing"
perm="$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$tmp/state/index.db")"
[[ "$perm" == "600" ]] || fail "index.db mode $perm"

doctor="$(ebrain doctor || true)"
grep -q '^path collisions: ' <<<"$doctor" || fail "doctor does not report path collisions"

echo "phase02: platform $(uname -s)/$(uname -m), dump sha256 $(sha256 "$tmp/dump1") (matches tests/fixtures/vault.dump)"
echo "phase02: OK"
