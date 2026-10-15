#!/usr/bin/env bash
# Phase 1 verification: scaffold, config, and safe paths.
# Set PHASE01_CLEAN_INSTALL=1 to start from `npm ci --ignore-scripts`.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase01: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"

if [[ "${PHASE01_CLEAN_INSTALL:-0}" == "1" || ! -d node_modules ]]; then
  npm ci --ignore-scripts
fi

# Scaffold files required by the spec.
for f in package.json package-lock.json tsconfig.json .nvmrc src/safe-path.ts src/config.ts \
         docs/SECURITY.md docs/DEPENDENCIES.md docs/SETUP.md; do
  [[ -f "$f" ]] || fail "missing $f"
done
node -e '
const p = require("./package.json");
const bad = [];
if (!p.engines || p.engines.node !== ">=22") bad.push("engines.node must be >=22");
if (!p.bin || !p.bin.ebrain) bad.push("bin.ebrain missing");
if (p.scripts["build:native"] !== "npm rebuild better-sqlite3") bad.push("build:native script");
for (const s of ["build", "test"]) if (!p.scripts[s]) bad.push("scripts." + s);
for (const deps of [p.dependencies || {}, p.devDependencies || {}])
  for (const [n, v] of Object.entries(deps)) if (!/^\d+\.\d+\.\d+$/.test(v)) bad.push("unpinned " + n + "@" + v);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
' || fail "package.json checks"

# Every direct dependency has a DEPENDENCIES.md line.
for dep in $(node -e 'const p=require("./package.json");console.log(Object.keys({...p.dependencies,...p.devDependencies}).join(" "))'); do
  grep -q "\`$dep\`" docs/DEPENDENCIES.md || fail "docs/DEPENDENCIES.md lacks $dep"
done

# SECURITY.md lists I1-I13.
for i in $(seq 1 13); do
  grep -q "\*\*I$i " docs/SECURITY.md || fail "docs/SECURITY.md lacks I$i"
done

npm run build
npm test

# CLI smoke checks.
version="$(node dist/src/cli/main.js --version)"
[[ "$version" == "$(node -p 'require("./package.json").version')" ]] || fail "ebrain --version printed '$version'"

tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/vault" "$tmp/home"
cat > "$tmp/config.json" <<JSON
{"vaultPath": "$tmp/vault", "stateDir": "$tmp/state", "principal": {"id": "phase01", "type": "human"}, "mode": "inbox"}
JSON
chmod 600 "$tmp/config.json"
set +e
out="$(HOME="$tmp/home" EBRAIN_CONFIG="$tmp/config.json" node dist/src/cli/main.js doctor)"
set -e
echo "$out"
for want in "platform: " "node: v" "vault case-sensitive: " "fts5: " "vault: " "state dir: " "network: disabled"; do
  grep -q "$want" <<<"$out" || fail "doctor output lacks '$want'"
done
[[ -z "$(ls -A "$tmp/vault")" ]] || fail "doctor wrote into the vault"
perm="$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$tmp/state")"
[[ "$perm" == "700" ]] || fail "state dir mode $perm"

chmod 666 "$tmp/config.json"
if HOME="$tmp/home" EBRAIN_CONFIG="$tmp/config.json" node dist/src/cli/main.js doctor >/dev/null; then
  fail "doctor accepted a world-writable config"
fi

echo "phase01: OK"
