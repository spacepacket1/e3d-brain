#!/usr/bin/env bash
# Cognition Phase 2 verification: the job framework (`ebrain cognition run`),
# the typed proposal schema, and the review queue (`ebrain review ...`).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase02: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/cognition/run.ts src/cognition/runs.ts src/cognition/rejections.ts src/cognition/prompts.ts \
  src/cognition/jobs/index.ts src/cognition/jobs/selftest.ts src/cognition/prompts/selftest.v1.md \
  src/llm/session.ts src/review/proposal.ts src/review/queue.ts src/cli/cognition-commands.ts src/cli/review-commands.ts \
  tests/cognition.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: no MCP tool starts a job, reviews, accepts, or applies (C2); src/mcp/ never imports them.
if grep -rnE "name: '[a-z_]*(review|cognition|job|accept|apply|propos|reject|undo|run)[a-z_]*'" src/mcp; then fail "an MCP tool exposes a job or review action"; fi
if grep -rnE "from '\.\./(cognition|review)/" src/mcp; then fail "src/mcp/ imports cognition or review code"; fi
if grep -nE '\b(createExclusive|writeAtomic|renameSafe|unlinkSafe|mkdirSafe|appendSafe|writeFileSync|renameSync|unlinkSync|mkdirSync)\b' src/mcp/*.ts; then
  fail "filesystem write call in src/mcp/"
fi
# Apply/undo reuse the Phase 1 undo store: no second implementation.
grep -qE "import \{[^}]*runOperation[^}]*\} from '\.\./undo/store\.js'" src/review/queue.ts || fail "review queue does not apply through runOperation"
grep -qE "import \{[^}]*restore[^}]*\} from '\.\./undo/store\.js'" src/review/queue.ts || fail "review queue does not undo through restore"
if grep -rnE 'manifest\.json|done\.jsonl|sha256_before|UNDO_DIR|renameSafe' src/review src/cognition; then fail "a second undo implementation"; fi
[[ "$(grep -c 'unlinkSafe(' src/undo/store.ts)" == "1" ]] || fail "undo store unlinks in more than one place"
# Jobs write vault files only through the inbox writer (C1); runs take the per-job lock.
if grep -rnE '\b(createExclusive|renameSafe|unlinkSafe|appendSafe)\(' src/cognition; then fail "a job writes outside the inbox writer"; fi
grep -q 'writeInboxFile(' src/cognition/run.ts || fail "jobs do not write through the inbox writer"
grep -q 'cognition-${job.name}' src/cognition/run.ts || fail "runs do not take a per-job lock"
grep -q 'withLock(stateDir, REJECTIONS_LOCK' src/cognition/rejections.ts || fail "rejections.json is not written under the lock helper"
grep -q "confidence: 'unrated'" src/review/proposal.ts || fail "proposals are not confidence: unrated"
grep -q 'DEFAULT_MAX_PENDING_PROPOSALS = 50' src/config.ts || fail "inbox.maxPendingProposals default is not 50"

# Docs.
grep -q '^## Cognition jobs and the review queue' docs/SETUP.md || fail "docs/SETUP.md lacks the cognition/review section"
grep -q 'inbox.maxPendingProposals' docs/SETUP.md || fail "docs/SETUP.md config table lacks inbox.maxPendingProposals"
grep -q '`ebrain-change`' docs/SETUP.md || fail "docs/SETUP.md does not document the change block"

npm run build
# Full suite: proposal grammar, selftest (idempotence, rejection memory, --reconsider, dry run, lock, budgets,
# flood control, every mode, taint, scrub), run-record scans, the mock LLM (invalid output dropped and counted,
# budget stops), review accept/undo/stale/auth/edit/archive/create/recovery, MCP tool lists, propose regressions.
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog2-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode read-only --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
secret="sk-$(node -e 'process.stdout.write("Ab3".repeat(16))')"
mkdir -p "$tmp/vault/notes"
printf -- '---\ntitle: Alpha\ntags: [ebrain-selftest]\n---\ncogtwomarker alpha body\n' > "$tmp/vault/notes/alpha.md"
printf -- '---\r\ntitle: Beta %s\r\ntags: [ebrain-selftest]\r\n---\r\ncogtwomarker beta body %s\r\n' "$secret" "$secret" > "$tmp/vault/notes/beta.md"
printf '# Plain\n\nnot tagged\n' > "$tmp/vault/notes/plain.md"

eb cognition run selftest > "$tmp/run0.out" || fail "cognition run (provisional ids)"
grep -q 'have only a provisional id and were skipped; run: ebrain ids assign' "$tmp/run0.out" || fail "provisional notes not reported"
eb ids assign > /dev/null || fail "ids assign"
eb cognition run selftest > "$tmp/run1.out" || fail "cognition run"
grep -q 'proposals: 2 created' "$tmp/run1.out" || { cat "$tmp/run1.out" >&2; fail "selftest did not create 2 proposals (read-only mode)"; }
eb cognition run selftest | grep -q 'proposals: 0 created, 2 already in _inbox/' || fail "re-run created proposals"
eb review list > "$tmp/list.out" || fail "review list"
[[ "$(grep -c 'authenticated' "$tmp/list.out")" == "2" ]] || fail "review list"
idof() { grep "self-test-demote-$1" "$tmp/list.out" | cut -f1; }
alpha="$(idof alpha)"; beta="$(idof beta)"
[[ -n "$alpha" && -n "$beta" ]] || fail "proposal ids not listed"
if grep -rq "$secret" "$tmp/vault/_inbox"; then fail "a secret reached a proposal"; fi

# Reject is remembered; --reconsider re-proposes.
eb review reject "$beta" --reason "not now" > /dev/null || fail "review reject"
grep -q 'pk_' "$tmp/state/rejections.json" || fail "rejections.json has no key"
eb cognition run selftest | grep -q '1 previously rejected (skipped)' || fail "rejected proposal was recreated"
eb cognition run selftest --reconsider | grep -q '1 created' || fail "--reconsider did not re-propose"

# Accept applies atomically; undo restores byte-identical originals.
cp "$tmp/vault/notes/alpha.md" "$tmp/alpha.orig"
eb review diff "$alpha" | grep -q '^+ status: stale' || fail "review diff"
eb review accept "$alpha" > "$tmp/accept.out" || fail "review accept"
grep -q '^status: stale$' "$tmp/vault/notes/alpha.md" || fail "accept did not apply the change"
ls "$tmp/vault/_inbox/_applied/"*alpha*.md > /dev/null 2>&1 || fail "accepted proposal not in _inbox/_applied/"
eb undo --list | grep -q "review accept $(printf '%s' "$alpha" | tr 'A-Z' 'a-z')" || fail "accept is not a Phase 1 undo operation"
eb review undo "$alpha" > /dev/null || fail "review undo"
cmp -s "$tmp/alpha.orig" "$tmp/vault/notes/alpha.md" || fail "undo did not restore byte-identical originals"

# Editing the target between preview and accept makes accept refuse with a stale result.
eb review show "$alpha" > /dev/null || fail "review show"
printf 'edited in Obsidian\n' >> "$tmp/vault/notes/alpha.md"
cp "$tmp/vault/notes/alpha.md" "$tmp/alpha.edited"
eb review accept "$alpha" > /dev/null 2> "$tmp/stale.err" && fail "accept applied a stale proposal"
grep -q 'stale' "$tmp/stale.err" || fail "accept did not report stale"
cmp -s "$tmp/alpha.edited" "$tmp/vault/notes/alpha.md" || fail "a stale accept changed the note"

# A forged proposal (frontmatter claims intact, no run record) is refused.
forged="$tmp/vault/_inbox/20261014-000000-forged.md"
sed "s/$alpha/01J9ZZZZZZZZZZZZZZZZZZZZZZ/" "$(grep -l "$alpha" "$tmp/vault/_inbox/"*.md | head -1)" > "$forged"
eb review accept 01J9ZZZZZZZZZZZZZZZZZZZZZZ > /dev/null 2> "$tmp/forged.err" && fail "a forged proposal was applied"
grep -q 'not written by a recorded cognition run' "$tmp/forged.err" || fail "forged proposal refusal message"

# Run records: no note bodies, titles, or secrets.
ls "$tmp/state/runs/"*.json > /dev/null || fail "no run records"
if grep -lE "cogtwomarker|Alpha|Beta|$secret" "$tmp/state/runs/"*.json; then fail "note text or a secret in a run record"; fi
eb cognition runs | grep -q 'runs (records in <stateDir>/runs/)' || fail "cognition runs"

# MCP: tools/list shows no job, review, or accept tools; calling one fails.
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"review_accept","arguments":{"id":"'"$beta"'"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cognition_run","arguments":{"job":"selftest"}}}'
  sleep 1
} | eb mcp > "$tmp/stdout.jsonl" 2> "$tmp/stderr.log" || fail "ebrain mcp exited non-zero"
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const names = lines.find((l) => l.id === 2).result.tools.map((t) => t.name);
if (names.length === 0 || names.some((n) => /review|cognition|job|accept|apply|propos|reject|undo|run/.test(n))) process.exit(1);
for (const id of [3, 4]) if (!lines.find((l) => l.id === id).result.isError) process.exit(2);' "$tmp/stdout.jsonl" \
  || fail "an MCP tool reviews, accepts, or runs jobs"

echo "cog-phase02: OK"
