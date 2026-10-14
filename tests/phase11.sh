#!/usr/bin/env bash
# Phase 11 verification: the reference library (books) with citations.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase11: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/yauzl ]] || npm ci --ignore-scripts

for f in src/refs/xml.ts src/refs/extract.ts src/refs/chunk.ts src/refs/db.ts src/refs/library.ts src/exec/pdftotext.ts \
  src/mcp/ref-tools.ts src/cli/refs-commands.ts tests/refs.test.ts tests/ref-fixtures.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Dependencies: the XHTML extractor decision is documented; no parser package was added.
grep -q '^## XHTML text extraction (Phase 11)' docs/DEPENDENCIES.md || fail "docs/DEPENDENCIES.md lacks the XHTML extractor decision"
grep -q 'src/refs/xml.ts' docs/DEPENDENCIES.md || fail "docs/DEPENDENCIES.md does not name the in-repo tokenizer"
node -e '
const p = require("./package.json");
const deps = Object.keys(p.dependencies).sort().join(",");
if (deps !== "@modelcontextprotocol/sdk,better-sqlite3,yaml,yauzl") { console.error(deps); process.exit(1); }' || fail "unexpected runtime dependency"
if grep -q 'Planned' docs/DEPENDENCIES.md && grep -q 'XHTML text extractor (Phase 11)' docs/DEPENDENCIES.md; then fail "DEPENDENCIES still lists the extractor as planned"; fi

# Static: I1/I3 boundaries for the library.
if grep -rn "from 'node:fs'" src/refs; then fail "src/refs imports node:fs"; fi
if grep -rnE "from 'node:(net|http|https|http2|dgram|tls|child_process)'|\bfetch\(|XMLHttpRequest|WebSocket" src/refs; then fail "src/refs uses network or process APIs"; fi
if grep -rln "node:child_process" src | grep -v '^src/exec/'; then fail "child_process outside src/exec/"; fi
grep -q "spawnSync(PDFTOTEXT, \[" src/exec/pdftotext.ts || fail "pdftotext is not spawned with an argument array"
grep -q "shell: false" src/exec/pdftotext.ts || fail "pdftotext spawn does not set shell: false"
grep -q "timeout:" src/exec/pdftotext.ts || fail "pdftotext has no timeout"
grep -q "maxBuffer:" src/exec/pdftotext.ts || fail "pdftotext output is not capped"
grep -q 'openExternalFile' src/refs/library.ts || fail "sources are not read through openExternalFile"
grep -q 'readZipEntries' src/refs/extract.ts || fail "EPUB does not use the Phase 10 zip reader"
if grep -rn "from 'yauzl'" src/refs; then fail "src/refs uses yauzl directly"; fi
grep -q 'scrubForWrite' src/refs/library.ts || fail "book text is not scrubbed"
if grep -nE 'strict: true|principal:' src/refs/library.ts | grep -n scrubForWrite; then fail "book scrubbing is not non-strict"; fi
grep -q "REFS_FILE = 'refs.db'" src/refs/db.ts || fail "refs.db file name"
if grep -rn "refs/" src/index src/cli/index-commands.ts; then fail "the note index reaches refs.db"; fi
for f in src/mcp/*.ts; do
  for m in $(grep -oE "from '\.\./refs/[^']+'" "$f" | sed -E "s/from '(.*)'/\1/"); do
    [[ "$m" == "../refs/db.js" ]] || fail "$f imports $m (MCP may only read refs.db)"
  done
done
if grep -rnE '\bopenRefsDb\(|replaceRef|deleteRef' src/mcp; then fail "MCP code writes refs.db"; fi
grep -q "openRefsDbReadOnly" src/mcp/ref-tools.ts || fail "read_ref_chunk does not open refs.db read-only"
node -e '
const reg = require("./tests/fixtures/tools-by-mode.json");
const e = reg.find((x) => x.name === "read_ref_chunk");
if (!e || e.phase !== 11 || JSON.stringify(e.modes) !== JSON.stringify(["inbox", "journal", "read-only"])) process.exit(1);' \
  || fail "tools-by-mode.json lacks read_ref_chunk (every mode, phase 11)"

# Docs.
grep -q '^## Reference library (books)' docs/SETUP.md || fail "docs/SETUP.md lacks the reference library section"
for pat in 'ebrain refs add' 'ebrain refs list' 'ebrain refs remove' 'ebrain refs reindex' 'refs.db' 'references/<slug>.md' 'pdftotext' 'ref:<ref_id>/<chapter>/<ordinal>' 'read_ref_chunk' 'scope'; do
  sed -n '/^## Reference library/,/^## Auditing/p' docs/SETUP.md | grep -qF -- "$pat" || fail "SETUP reference library section lacks: $pat"
done
grep -q '`refs.excerptChars`' docs/SETUP.md && grep -q '`refs.maxHits`' docs/SETUP.md || fail "SETUP config table lacks refs keys"
grep -q 'Reference library (Phase 11' docs/SECURITY.md || fail "docs/SECURITY.md lacks the reference library bullet"
grep -q 'Reference books (Phase 11)' docs/RANKING.md || fail "docs/RANKING.md lacks the reference ordering note"

npm run build
# Full suite: Phases 1-10 plus the tokenizer, chapters and chunks, refs add
# (EPUB, Markdown, text, PDF via a fake pdftotext), scrubbing, the vault scan,
# search scopes and limits, read_ref_chunk, hostile EPUBs (zip-slip, huge
# entry, external URLs with a loopback server that must see no request),
# refs list/remove/reindex, and refs.db surviving reindex --full.
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p11-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/tests/ref-fixtures.js "$tmp/fx" > "$tmp/manifest.json" || fail "fixture generation"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
vault_sum() { (cd "$tmp/vault" && find . -type f -exec shasum {} + | sort | shasum); }
sum() { shasum "$1" | cut -d' ' -f1; }

# Add the public-domain EPUB fixture.
eb refs add "$tmp/fx/alice.epub" > "$tmp/add.out" || { cat "$tmp/add.out" >&2; fail "refs add"; }
grep -qE "^added ref_[0-9a-f]{32}: \"Alice's Adventures in Wonderland\" by \"Lewis Carroll\" \(3 chapters, [0-9]+ chunks\)" "$tmp/add.out" || { cat "$tmp/add.out" >&2; fail "add summary"; }
grep -q '^scrub findings: github-token: 1' "$tmp/add.out" || fail "add does not report scrub findings"
ref_id="$(grep -oE 'ref_[0-9a-f]{32}' "$tmp/add.out" | head -1)"
expected="ref_$(shasum -a 256 "$tmp/fx/alice.epub" | cut -c1-32)"
[[ "$ref_id" == "$expected" ]] || fail "ref_id is not derived from the file SHA-256"
[[ -f "$tmp/vault/references/alice-s-adventures-in-wonderland.md" ]] || fail "no reference note"
[[ "$(stat -f '%Lp' "$tmp/state/refs.db" 2>/dev/null || stat -c '%a' "$tmp/state/refs.db")" == "600" ]] || fail "refs.db is not 0600"
eb refs list | grep -q "^$ref_id  \"Alice's Adventures in Wonderland\"" || fail "refs list"

# No book text anywhere under the vault; no secret in refs.db.
for phrase in 'without pictures or conversations' 'Curiouser and curiouser' 'queer-looking party' 'daisy-chain'; do
  if grep -rqF -- "$phrase" "$tmp/vault"; then fail "book text under the vault: $phrase"; fi
done
node -e '
const D = require("better-sqlite3"), m = require(process.argv[2]);
const db = new D(process.argv[1], { readonly: true });
const all = db.prepare("SELECT text FROM refs_chunks").all().map((r) => r.text).join("\n");
if (!all.includes("Curiouser and curiouser")) process.exit(1);
for (const s of m.secrets) if (all.includes(s)) process.exit(2);
for (const x of ["scriptmarkerzz", "stylemarkerzz", "headmarkerzz"]) if (all.includes(x)) process.exit(3);' "$tmp/state/refs.db" "$tmp/manifest.json" \
  || fail "refs.db contents (text present, secret redacted, scripts/styles dropped)"

# Re-adding the same file (same hash) is a no-op.
db_sum="$(sum "$tmp/state/refs.db")"; vs="$(vault_sum)"
eb refs add "$tmp/fx/alice.epub" | grep -q 'already in the library' || fail "re-add not reported as a no-op"
eb refs add "$tmp/fx/alice-copy.epub" | grep -q 'already in the library' || fail "same-hash copy not a no-op"
[[ "$(sum "$tmp/state/refs.db")" == "$db_sum" && "$(vault_sum)" == "$vs" ]] || fail "re-add changed refs.db or the vault"

# Hostile EPUBs: rejected (zip-slip, huge entry) or ingested without network (external URLs); nothing written outside.
fx_sum="$(cd "$tmp" && find fx -type f -exec shasum {} + | sort | shasum)"
for z in zip-slip huge; do
  if eb refs add "$tmp/fx/hostile/$z.epub" > /dev/null 2> "$tmp/h.err"; then fail "hostile EPUB $z accepted"; fi
  grep -q 'archive rejected' "$tmp/h.err" || { cat "$tmp/h.err" >&2; fail "hostile EPUB $z: no rejection message"; }
done
[[ "$(sum "$tmp/state/refs.db")" == "$db_sum" && "$(vault_sum)" == "$vs" ]] || fail "hostile EPUB changed refs.db or the vault"
[[ "$(cd "$tmp" && find fx -type f -exec shasum {} + | sort | shasum)" == "$fx_sum" ]] || fail "hostile EPUB wrote next to the source"
[[ ! -e "$tmp/evil.xhtml" && ! -e "$tmp/fx/evil.xhtml" ]] || fail "zip-slip entry was written"
eb refs add "$tmp/fx/hostile/external.epub" > /dev/null || fail "EPUB with external URLs not ingested"
node -e '
const D = require("better-sqlite3");
const db = new D(process.argv[1], { readonly: true });
const all = db.prepare("SELECT text FROM refs_chunks").all().map((r) => r.text).join("\n");
if (/https?:|127\.0\.0\.1/.test(all)) process.exit(1);' "$tmp/state/refs.db" || fail "external URLs reached refs.db"

# PDF without pdftotext: a clear refusal.
if PATH="$tmp/home:$(dirname "$(command -v node)")" node dist/src/cli/main.js refs add "$tmp/fx/scan.pdf" > /dev/null 2> "$tmp/pdf.err"; then
  command -v pdftotext > /dev/null || fail "PDF accepted without pdftotext"
fi
grep -q 'pdftotext' "$tmp/pdf.err" || fail "PDF refusal message"

# MCP over stdio: tools list, scope refs search with the right chapter citation, read_ref_chunk, out-of-range.
mkdir -p "$tmp/vault/notes"
printf '# Pool\n\nMy note on curiouser things.\n' > "$tmp/vault/notes/pool.md"
mcp_session() {
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"Curiouser","scope":"refs"}}}'
    printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read_ref_chunk\",\"arguments\":{\"ref_id\":\"$ref_id\",\"chapter\":2,\"ordinal\":0}}}"
    printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"read_ref_chunk\",\"arguments\":{\"ref_id\":\"$ref_id\",\"chapter\":9,\"ordinal\":0}}}"
    printf '%s\n' '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"search","arguments":{"query":"curiouser","scope":"all"}}}'
    sleep 1
  } | node dist/src/cli/main.js mcp > "$1" 2> "$tmp/stderr.log" || fail "ebrain mcp exited non-zero"
}
check_session() {
  node -e '
const [file, refId] = process.argv.slice(1);
const lines = require("fs").readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const by = (id) => lines.find((l) => l.id === id).result;
const names = by(2).tools.map((t) => t.name);
if (!names.includes("read_ref_chunk") || !names.includes("search")) process.exit(1);
const scope = by(2).tools.find((t) => t.name === "search").inputSchema.properties.scope;
if (JSON.stringify(scope.enum) !== JSON.stringify(["notes", "raw", "refs", "all"])) process.exit(2);
const rows = (r) => r.content[0].text.split("\n").filter((l) => l.startsWith("{\"")).map(JSON.parse).filter((x) => x.citation);
const s = rows(by(3));
if (s.length < 1 || s.length > 5 || s[0].citation !== `ref:${refId}/2/0` || s[0].label !== "Alice" + String.fromCharCode(39) + "s Adventures in Wonderland, Chapter 2 (The Pool of Tears)") { console.error(s); process.exit(3); }
if (s.some((x) => x.excerpt.length > 400)) process.exit(4);
const chunk = by(4);
if (chunk.isError || !chunk.content[0].text.includes("Curiouser and curiouser") || chunk.content[0].text.length > 10000) process.exit(5);
if (!by(5).isError) process.exit(6);
const all = rows(by(6)).map((x) => x.source ?? "note");
if (all[0] !== "note" || !all.includes("ref") || all.indexOf("ref") < all.lastIndexOf("note")) { console.error(all); process.exit(7); }' "$1" "$ref_id"
}
mcp_session "$tmp/s1.jsonl"
check_session "$tmp/s1.jsonl" || fail "MCP session (tools, scope refs, read_ref_chunk, scope all)"

# Deleting index.db and running reindex --full leaves refs.db intact.
db_sum="$(sum "$tmp/state/refs.db")"
rm -f "$tmp/state/index.db" "$tmp/state/index.db-wal" "$tmp/state/index.db-shm"
eb reindex --full > /dev/null || fail "reindex --full"
[[ "$(sum "$tmp/state/refs.db")" == "$db_sum" ]] || fail "reindex --full touched refs.db"

# Deleting refs.db and running refs reindex restores it.
rm -f "$tmp/state/refs.db"
eb refs reindex > "$tmp/reindex.out" || { cat "$tmp/reindex.out" >&2; fail "refs reindex"; }
grep -q '^refs reindex: 2 rebuilt, 0 missing, 0 changed, 0 failed' "$tmp/reindex.out" || { cat "$tmp/reindex.out" >&2; fail "refs reindex summary"; }
mcp_session "$tmp/s2.jsonl"
check_session "$tmp/s2.jsonl" || fail "MCP session after refs reindex"

# A moved source is reported missing; refs remove leaves the vault note.
mv "$tmp/fx/hostile/external.epub" "$tmp/fx/moved.epub"
if eb refs reindex > "$tmp/reindex2.out"; then fail "refs reindex with a moved source exited 0"; fi
grep -qE '^missing ref_[0-9a-f]{32}: source not found at .*external\.epub' "$tmp/reindex2.out" || { cat "$tmp/reindex2.out" >&2; fail "moved source not reported missing"; }
note="$tmp/vault/references/alice-s-adventures-in-wonderland.md"
note_sum="$(sum "$note")"
eb refs remove "$ref_id" | grep -q 'left in place' || fail "refs remove"
[[ "$(sum "$note")" == "$note_sum" ]] || fail "refs remove touched the vault note"
eb refs list | grep -q "$ref_id" && fail "removed ref still listed"

echo "phase11: OK"
