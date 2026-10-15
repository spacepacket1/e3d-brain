#!/usr/bin/env bash
# Cognition Phase 7 verification: the `forget` job (demote/archive proposals
# from deterministic staleness signals, never deleting), `note_stats` rebuilt
# from recalls.jsonl, journal prune on the same mechanism, and
# `ebrain cognition stats forget`.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase07: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/cognition/jobs/forget.ts src/recall/stats.ts tests/forget.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: registered; derived stats table; no direct writes or deletes; no model; no MCP reach.
grep -q 'FORGET_JOB' src/cognition/jobs/index.ts || fail "forget job not registered"
grep -q 'CREATE TABLE note_stats' src/index/db.ts || fail "note_stats table missing"
grep -q "llm: 'never'" src/cognition/jobs/forget.ts || fail "forget must not use a model"
if grep -nE "writeAtomic|createExclusive|renameSafe|writeInboxFile|appendSafe|unlink|rmSync|rm\(" src/cognition/jobs/forget.ts; then fail "forget writes or deletes files itself (C1, C10)"; fi
if grep -rnE "from '\.\./cognition/" src/mcp; then fail "src/mcp imports cognition code"; fi
grep -q 'pruneRequiresReview' src/config.ts || fail "journal.pruneRequiresReview missing"

# Docs.
grep -q '^### The forget job' docs/SETUP.md || fail "docs/SETUP.md lacks the forget section"
for key in cognition.forget.windowDays cognition.forget.minAgeDays cognition.forget.exemptKinds journal.pruneRequiresReview; do
  grep -q "\`$key\`" docs/SETUP.md || fail "docs/SETUP.md config table lacks $key"
done

npm run build
# Full suite: candidates, ladder, history gate, accept/undo, note_stats rebuild, journal prune (default and review), stats, config;
# plus every earlier phase (including the existing journal prune tests with default settings).
npm test

# End to end from the shell. Dates are far in the past so the checks hold whatever today is.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog7-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal tester --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
note() { # name, extra frontmatter
  mkdir -p "$tmp/vault/notes"
  printf -- '---\ntitle: %s\ncreated: 2024-01-01\n%s---\n%s body text.\n' "$1" "${2:-}" "$1" > "$tmp/vault/notes/$1.md"
}
note quiet
note pinned $'pinned: true\n'
note decided $'kind: decision\n'
note cited
note active
eb ids assign > /dev/null || fail "ids assign"
cid="$(sed -n 's/^id: //p' "$tmp/vault/notes/cited.md" | head -n1)"
crev="$(node -e 'const {openIndex,closeIndex,refreshIndex}=require("./dist/src/index/indexer.js");const {allNoteRows}=require("./dist/src/index/query.js");const {ensureStateDir,loadConfig}=require("./dist/src/config.js");const c=loadConfig({}).config;const h=openIndex({vaultPath:c.vaultPath,stateDir:ensureStateDir(c)});refreshIndex(h);process.stdout.write(allNoteRows(h.db).find(r=>r.path==="notes/cited.md").rev);closeIndex(h)')"
printf -- '---\ntitle: hub\ncreated: 2024-02-01\nstatus: accepted\nsources: [note:%s@%s]\n---\nhub body.\n' "$cid" "$crev" > "$tmp/vault/notes/hub.md"
eb ids assign > /dev/null || fail "ids assign (hub)"
for n in quiet pinned decided cited active hub; do touch -t 202401010000 "$tmp/vault/notes/$n.md"; done
aid="$(sed -n 's/^id: //p' "$tmp/vault/notes/active.md" | head -n1)"
hid="$(sed -n 's/^id: //p' "$tmp/vault/notes/hub.md" | head -n1)"
printf '{"recall_id":"r1","ts":"2024-01-02T00:00:00.000Z","principal":"tester","ids":[{"id":"%s","rev":"x"}]}\n{"recall_id":"r2","ts":"%s","principal":"tester","ids":[{"id":"%s","rev":"x"}]}\n' \
  "$hid" "$(node -e 'process.stdout.write(new Date().toISOString())')" "$aid" > "$tmp/state/recalls.jsonl"
chmod 600 "$tmp/state/recalls.jsonl"

eb cognition stats forget > "$tmp/stats.out" || { cat "$tmp/stats.out" >&2; fail "stats forget"; }
grep -q 'candidates: 2 demote, 0 archive' "$tmp/stats.out" || { cat "$tmp/stats.out" >&2; fail "stats candidate counts"; }
grep -q '1 pinned, 1 exempt kind' "$tmp/stats.out" || fail "stats skip counts"
grep -q 'demote notes/quiet.md: age .* recalls 0; last recalled never' "$tmp/stats.out" || fail "stats lacks signal values"
[[ ! -e "$tmp/vault/_inbox" ]] || [[ -z "$(ls "$tmp/vault/_inbox")" ]] || fail "stats wrote to the vault"

eb cognition run forget > "$tmp/run.out" || { cat "$tmp/run.out" >&2; fail "cognition run forget"; }
grep -q 'proposals: 2 created' "$tmp/run.out" || { cat "$tmp/run.out" >&2; fail "proposal count"; }
for n in pinned decided cited active; do
  if grep -l "path_at_proposal: notes/$n.md" "$tmp/vault/_inbox/"*.md; then fail "$n was proposed"; fi
done
eb cognition run forget | grep -q 'proposals: 0 created, 2 already in _inbox/' || fail "re-run created proposals"

# Demote, then (after the note is stale and still quiet) archive; undo restores the original path and bytes.
qid="$(grep -l 'path_at_proposal: notes/quiet.md' "$tmp/vault/_inbox/"*.md | head -n1 | xargs sed -n 's/^id: //p' | head -n1)"
eb review accept "$qid" > /dev/null || fail "accept demote"
grep -q '^status: stale$' "$tmp/vault/notes/quiet.md" || fail "demote did not set status: stale"
touch -t 202401010000 "$tmp/vault/notes/quiet.md"
eb cognition run forget > "$tmp/run2.out" || fail "second forget run"
grep -q 'proposals: 1 created' "$tmp/run2.out" || { cat "$tmp/run2.out" >&2; fail "stale note not escalated to archive"; }
cp "$tmp/vault/notes/quiet.md" "$tmp/quiet.orig"
aid2="$(eb review list | grep archive | cut -f1)"
[[ -n "$aid2" ]] || fail "archive proposal not listed"
eb review accept "$aid2" > /dev/null || fail "accept archive"
[[ ! -e "$tmp/vault/notes/quiet.md" ]] || fail "archive left the note in place"
grep -q '^status: archived$' "$tmp/vault/_archive/notes/quiet.md" || fail "archived status missing"
grep -q '^archived_at: ' "$tmp/vault/_archive/notes/quiet.md" || fail "archived_at missing"
eb review undo "$aid2" > /dev/null || fail "undo archive"
cmp -s "$tmp/vault/notes/quiet.md" "$tmp/quiet.orig" || fail "undo did not restore the note byte for byte"
[[ ! -e "$tmp/vault/_archive/notes/quiet.md" ]] || fail "undo left the archive copy"

# Journal prune: default archives directly; with pruneRequiresReview it files a proposal and moves nothing.
mkdir -p "$tmp/vault/journal/bot/2024"
printf -- '---\nid: entry_exp_1\ntitle: Old entry\ncreated: 2024-03-01T00:00:00Z\nexpires: 2024-06-01T00:00:00Z\nstatus: journal\n---\nOld entry.\n' > "$tmp/vault/journal/bot/2024/old.md"
node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.journal={pruneRequiresReview:true};fs.writeFileSync(f,JSON.stringify(c));' "$EBRAIN_CONFIG"
eb journal prune > "$tmp/prune.out" || { cat "$tmp/prune.out" >&2; fail "journal prune (review)"; }
grep -q '1 archive proposals created' "$tmp/prune.out" || { cat "$tmp/prune.out" >&2; fail "journal prune proposal"; }
[[ -f "$tmp/vault/journal/bot/2024/old.md" ]] || fail "journal prune moved a file despite pruneRequiresReview"
node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.journal={pruneRequiresReview:false};fs.writeFileSync(f,JSON.stringify(c));' "$EBRAIN_CONFIG"
eb journal prune | grep -q 'archived journal/bot/2024/old.md -> journal/_archive/bot/2024/old.md' || fail "default journal prune changed"
[[ -f "$tmp/vault/journal/_archive/bot/2024/old.md" ]] || fail "default journal prune did not archive"

echo "cog-phase07: OK"
