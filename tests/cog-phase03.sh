#!/usr/bin/env bash
# Cognition Phase 3 verification: evidence sources (`src/evidence/`), the
# derived evidence index, `ebrain evidence import|stats|reindex`, and citation
# resolution (`src/cite/resolve.ts`).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase03: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/evidence/record.ts src/evidence/source.ts src/evidence/store.ts src/cite/resolve.ts src/cli/evidence-commands.ts \
  tests/evidence.test.ts tests/fixtures/evidence/e3d-sample.jsonl scripts/export-e3d-evidence.md; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: evidence loading is local only (I3); src/cite stays free of I/O; no MCP tool imports or exposes evidence.
if grep -rnE "from '(node:)?(net|http|https|http2|dns|tls|dgram)'|from '\.\./net/|\bfetch\s*\(" src/evidence src/cite; then fail "network code in src/evidence or src/cite"; fi
if grep -nE "safe-path|writeAtomic|appendSafe|createExclusive" src/cite/*.ts; then fail "src/cite touches the filesystem"; fi
if grep -rnE "from '\.\./evidence/" src/mcp; then fail "src/mcp imports evidence code"; fi
if grep -rnE "name: '[a-z_]*evidence[a-z_]*'" src/mcp; then fail "an MCP tool exposes evidence"; fi
# Files are opened only through safe-path, each inside its configured root (I1).
grep -q 'openExternalFile(f.path, \[f.root\])' src/evidence/store.ts || fail "evidence files are not opened inside their root"
if grep -nE "from '(node:)?fs" src/evidence/*.ts; then fail "src/evidence imports node:fs"; fi
grep -q 'resolveCitation' src/review/queue.ts || fail "review does not resolve evidence citations"

# Docs.
grep -q '^## Evidence files' docs/SETUP.md || fail "docs/SETUP.md lacks the evidence section"
for key in evidence.dir evidence.sources evidence.maxFileMB evidence.maxRecordBytes; do
  grep -q "\`$key\`" docs/SETUP.md || fail "docs/SETUP.md config table lacks $key"
done
grep -q 'scripts/export-e3d-evidence.md' docs/SETUP.md || fail "docs/SETUP.md does not point at the exporter stub"

npm run build
# Full suite: record format and limits, config, store (fixture resolution, skipped counts, rebuilds, overrides,
# size limits, scrub), I1 hostile paths, import/stats/reindex, I3 network spy, citation resolution and caching,
# review accept blocked on unresolved evidence; plus every earlier phase.
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog3-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/exports" "$tmp/outside"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode read-only --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
secret="sk-$(node -e 'process.stdout.write("Ab3".repeat(16))')"

eb evidence stats | grep -q 'no evidence files' || fail "stats with no evidence"
cp tests/fixtures/evidence/e3d-sample.jsonl "$tmp/exports/e3d.jsonl"
printf '{"kind":"thesis","id":"th_secret","occurred":"2026-09-02T00:00:00Z","summary":"key %s"}\n' "$secret" >> "$tmp/exports/e3d.jsonl"
eb evidence import "$tmp/exports/e3d.jsonl" > "$tmp/import.out" || fail "evidence import"
grep -q '6 records written' "$tmp/import.out" || { cat "$tmp/import.out" >&2; fail "import record count"; }
grep -q 'skipped: 4 malformed, 1 too deep' "$tmp/import.out" || fail "import skipped counts"
[[ -f "$tmp/state/evidence/e3d.jsonl" ]] || fail "import did not write into evidence.dir"
if grep -q "$secret" "$tmp/state/evidence/e3d.jsonl"; then fail "a secret reached the evidence dir"; fi
[[ "$(stat -f %Lp "$tmp/state/evidence/e3d.jsonl" 2>/dev/null || stat -c %a "$tmp/state/evidence/e3d.jsonl")" == "600" ]] || fail "imported file is not 0600"
eb evidence stats > "$tmp/stats.out" || fail "evidence stats"
grep -q 'kinds: outcome 2, thesis 3' "$tmp/stats.out" || { cat "$tmp/stats.out" >&2; fail "stats kinds"; }
[[ -f "$tmp/state/evidence.db" ]] || fail "no evidence.db"
if grep -q "$secret" "$tmp/state/evidence.db"; then fail "a secret reached evidence.db"; fi

# Hostile paths: a symlink in evidence.dir to a file outside is refused, and its records never load.
printf '{"kind":"thesis","id":"th_outside","occurred":"2026-09-01T00:00:00Z","summary":"outside"}\n' > "$tmp/outside/o.jsonl"
ln -s "$tmp/outside/o.jsonl" "$tmp/state/evidence/link.jsonl"
eb evidence stats > "$tmp/stats2.out" || fail "stats with a symlink"
grep -q 'link.jsonl  \[dir\]  REFUSED: symlink' "$tmp/stats2.out" || { cat "$tmp/stats2.out" >&2; fail "symlink not refused"; }
grep -q 'evidence: 5 records from 2 files' "$tmp/stats2.out" || fail "symlinked records loaded"
eb evidence import "$tmp/exports/e3d.jsonl" --name ../escape.jsonl > /dev/null 2>&1 && fail "import accepted a traversal name"
[[ ! -e "$tmp/state/escape.jsonl" ]] || fail "import wrote outside evidence.dir"
printf 'garbage\n' > "$tmp/exports/bad.jsonl"
eb evidence import "$tmp/exports/bad.jsonl" > /dev/null 2>&1 && fail "import accepted a file with no valid records"
[[ ! -e "$tmp/state/evidence/bad.jsonl" ]] || fail "a refused import wrote a file"
eb evidence reindex | grep -q '(index rebuilt)' || fail "evidence reindex"

# Config: a hostile evidence source is rejected at load.
node -e '
const fs = require("fs"); const f = process.argv[1]; const c = JSON.parse(fs.readFileSync(f, "utf8"));
c.evidence = { sources: [process.argv[2] + "/../outside/o.jsonl"] }; fs.writeFileSync(f, JSON.stringify(c));' "$EBRAIN_CONFIG" "$tmp/exports"
eb evidence stats > /dev/null 2> "$tmp/cfg.err" && fail "config accepted a .. evidence source"
grep -q 'evidence.sources' "$tmp/cfg.err" || fail "config error does not name evidence.sources"

echo "cog-phase03: OK"
