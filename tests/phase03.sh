#!/usr/bin/env bash
# Phase 3 verification: note identity, revisions, citation grammar, and citation edges.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase03: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules ]] || npm ci --ignore-scripts

for f in src/cite/citation.ts src/index/identity.ts tests/cite.test.ts tests/identity.test.ts tests/fixtures/vault.dump; do
  [[ -f "$f" ]] || fail "missing $f"
done

npm run build
# Full suite: Phase 1-2 tests (including the golden dump), the citation
# grammar tests, and the identity/revision/edge tests.
npm test

# CLI end-to-end over a scratch vault.
tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
v="$tmp/vault"
mkdir -p "$v/Projects" "$tmp/home"
alpha=$'---\nid: 01JALPHA0000000000000000AA\nstatus: accepted\n---\n# Alpha\n\nAlpha body.\n'
printf '%s' "$alpha" > "$v/Projects/Alpha.md"
plain=$'---\nkind: fact\n---\n# Plain\n\nSame text, different line endings.\n'
printf '%s' "$plain" > "$v/LF.md"
printf '%s' "${plain//$'\n'/$'\r\n'}" > "$v/CRLF.md"
# rev = first 16 hex of SHA-256 of the normalized text (this file is already LF, no BOM).
rev="$(printf '%s' "$alpha" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(require("crypto").createHash("sha256").update(d).digest("hex").slice(0,16)))')"
printf -- '---\nsources: [note:01JALPHA0000000000000000AA@%s]\n---\nCites alpha.\n' "$rev" > "$v/Citer.md"
printf -- '---\nid: DUP_ID\n---\nfirst\n' > "$v/dup-a.md"
printf -- '---\nid: DUP_ID\n---\nsecond\n' > "$v/dup-b.md"
printf -- '---\nstatus: someday\n---\nunknown status\n' > "$v/Unknown Status.md"
printf -- '---\ntags: [unclosed\n---\nbad yaml\n' > "$v/Malformed.md"
printf -- '---\noccurred: 2026-02-30\n---\nbad date\n' > "$v/Bad Date.md"
printf 'twin\n' > "$v/twin-1.md"
printf 'twin\n' > "$v/twin-2.md"
printf 'movable\n' > "$v/movable.md"
printf 'edit and move\n' > "$v/edit-me.md"

cat > "$tmp/config.json" <<JSON
{"vaultPath": "$v", "stateDir": "$tmp/state", "principal": {"id": "phase03", "type": "human"}, "mode": "inbox"}
JSON
chmod 600 "$tmp/config.json"
ebrain() { HOME="$tmp/home" EBRAIN_CONFIG="$tmp/config.json" node dist/src/cli/main.js "$@"; }
checksum() { node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const h = crypto.createHash("sha256");
const walk = (d, rel) => { for (const n of fs.readdirSync(d).sort()) {
  const full = path.join(d, n), r = rel + "/" + n, st = fs.lstatSync(full);
  if (st.isDirectory()) { h.update("D " + r + "\n"); walk(full, r); }
  else h.update("F " + r + " " + crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") + "\n");
} };
walk(process.argv[1], ""); console.log(h.digest("hex"));' "$1"; }
# Run a read-only query against the index; rows print as `a|b|c`.
q() { node -e '
const D = require("better-sqlite3"); const db = new D(process.argv[1], { readonly: true });
for (const r of db.prepare(process.argv[2]).all()) console.log(Object.values(r).join("|"));' "$tmp/state/index.db" "$1"; }

before="$(checksum "$v")"
summary="$(ebrain reindex)"
echo "$summary"
grep -q '^ids: provisional [0-9]*, duplicate 1, missing 0$' <<<"$summary" || fail "reindex summary lacks id counts"
grep -q 'note citations: 1$' <<<"$summary" || fail "reindex summary lacks the citation edge"
[[ "$(checksum "$v")" == "$before" ]] || fail "vault changed during indexing (ids must never be written into notes)"

# Citation edge, revisions, CRLF rev equality.
[[ "$(q "SELECT from_path, to_id, to_rev FROM cites")" == "Citer.md|01JALPHA0000000000000000AA|$rev" ]] || fail "cites table"
[[ "$(q "SELECT rev FROM notes WHERE path = 'Projects/Alpha.md'")" == "$rev" ]] || fail "rev of Alpha"
[[ "$(q "SELECT COUNT(DISTINCT rev) FROM notes WHERE path IN ('LF.md', 'CRLF.md')")" == "1" ]] || fail "CRLF and LF revs differ"
twins="$(q "SELECT COUNT(DISTINCT id) FROM notes WHERE path IN ('twin-1.md', 'twin-2.md')")"
[[ "$twins" == "2" ]] || fail "identical notes share an id"
[[ "$(q "SELECT provisional FROM notes WHERE path = 'dup-b.md'")" == "1" ]] || fail "later duplicate id is not provisional"

dump="$(ebrain index dump)"
grep -q 'cites sources "note:01JALPHA0000000000000000AA@'"$rev"'"' <<<"$dump" || fail "dump lacks the cites edge"
grep -q 'prov_' <<<"$dump" && fail "dump contains provisional ids"

set +e
doctor="$(ebrain doctor)"; dcode=$?
set -e
echo "$doctor"
[[ $dcode -eq 1 ]] || fail "doctor should fail on duplicate ids (exit $dcode)"
grep -q '^duplicate ids: FAIL 1' <<<"$doctor" || fail "doctor does not report duplicate ids"
grep -q 'duplicate id "DUP_ID": "dup-a.md" "dup-b.md"' <<<"$doctor" || fail "doctor does not list duplicate id paths"
grep -q '^missing identities: 0$' <<<"$doctor" || fail "doctor missing identities"
grep -q '^unknown statuses: WARN 1$' <<<"$doctor" || fail "doctor unknown statuses"
grep -q '^malformed frontmatter: WARN 1$' <<<"$doctor" || fail "doctor malformed frontmatter"
grep -q '^invalid dates: WARN 1$' <<<"$doctor" || fail "doctor invalid dates"
grep -q '^path collisions: ' <<<"$doctor" || fail "doctor path collisions"

# Rename without edit keeps the id; edit+move reports the old id missing; a twin move transfers nothing.
movable="$(q "SELECT id FROM notes WHERE path = 'movable.md'")"
edited="$(q "SELECT id FROM notes WHERE path = 'edit-me.md'")"
twin1="$(q "SELECT id FROM notes WHERE path = 'twin-1.md'")"
mv "$v/movable.md" "$v/Projects/movable renamed.md"
mv "$v/edit-me.md" "$v/edited.md" && printf 'edited and moved\n' > "$v/edited.md"
mv "$v/twin-1.md" "$v/twin-3.md"
rm "$v/dup-a.md"
after_moves="$(checksum "$v")"
ebrain reindex >/dev/null
[[ "$(checksum "$v")" == "$after_moves" ]] || fail "vault changed during reindex"
[[ "$(q "SELECT id FROM notes WHERE path = 'Projects/movable renamed.md'")" == "$movable" ]] || fail "rename lost the provisional id"
[[ "$(q "SELECT id FROM notes WHERE path = 'edited.md'")" != "$edited" ]] || fail "edit+move kept the id"
[[ "$(q "SELECT id FROM notes WHERE path = 'twin-3.md'")" != "$twin1" ]] || fail "twin move transferred identity"
[[ "$(q "SELECT id FROM notes WHERE path = 'dup-b.md'")" == "DUP_ID" ]] || fail "remaining duplicate did not get the explicit id"
missing="$(q "SELECT id FROM missing_ids ORDER BY id")"
[[ "$missing" == "$(printf '%s\n' "$edited" "$twin1" | LC_ALL=C sort)" ]] || fail "missing identities: $missing"
doctor="$(ebrain doctor)" || fail "doctor failed after duplicate removed"
grep -q '^missing identities: WARN 2$' <<<"$doctor" || fail "doctor does not report missing identities"
grep -q "missing provisional id $edited (last at \"edit-me.md\"" <<<"$doctor" || fail "doctor missing identity detail"

# Dump equality across a full rebuild (provisional ids and rename history excluded).
ebrain index dump > "$tmp/dump-incremental"
rm -f "$tmp/state/index.db" "$tmp/state/index.db-wal" "$tmp/state/index.db-shm"
ebrain reindex --full >/dev/null
ebrain index dump > "$tmp/dump-full"
cmp -s "$tmp/dump-incremental" "$tmp/dump-full" || fail "dump differs after a full rebuild"
[[ "$(q "SELECT COUNT(*) FROM missing_ids")" == "0" ]] || fail "full rebuild kept rename history"
[[ "$(checksum "$v")" == "$after_moves" ]] || fail "vault changed during full rebuild"

echo "phase03: OK"
