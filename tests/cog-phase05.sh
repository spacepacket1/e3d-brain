#!/usr/bin/env bash
# Cognition Phase 5 verification: the `consolidate` job (deterministic
# minhash/LSH near-duplicate detection with embeddings off, merge proposals
# that archive per C10 and never delete, summary proposals with citations
# and verified quotes, taint propagation), applied and undone through the
# review queue.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase05: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/cognition/dedup.ts src/cognition/jobs/consolidate.ts src/cognition/prompts/consolidate.v1.md tests/consolidate.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: registered; minhash with fixed seeds and LSH; quotes verified; writes go through the framework; no network.
grep -q 'CONSOLIDATE_JOB' src/cognition/jobs/index.ts || fail "consolidate job not registered"
grep -q 'export const SEEDS' src/cognition/dedup.ts || fail "dedup has no fixed minhash seeds"
grep -q 'LSH_BANDS' src/cognition/dedup.ts || fail "dedup has no LSH bucket search"
if grep -nE "Math\.random|Date\.now|crypto\.random" src/cognition/dedup.ts; then fail "dedup is not deterministic"; fi
grep -q 'quoteAppears' src/cognition/jobs/consolidate.ts || fail "consolidate does not verify claim quotes"
grep -q 'archiveDestination' src/cognition/jobs/consolidate.ts || fail "merge does not use the C10 archive destination"
if grep -nE "writeAtomic|createExclusive|renameSafe|writeInboxFile|appendSafe|unlink|rmSync|rm\(" src/cognition/jobs/consolidate.ts src/cognition/dedup.ts; then fail "consolidate writes or deletes files itself (C1, C10)"; fi
if grep -nE "from '\.\./\.\./(net|llm/(openai|anthropic))|from '\.\./net" src/cognition/jobs/consolidate.ts src/cognition/dedup.ts; then fail "consolidate reaches the network directly"; fi
if grep -rnE "from '\.\./cognition/" src/mcp; then fail "src/mcp imports cognition code"; fi

# Docs.
grep -q '^### The consolidate job' docs/SETUP.md || fail "docs/SETUP.md lacks the consolidate section"
for key in cognition.consolidate.minJaccard cognition.consolidate.minCosine cognition.consolidate.maxSummaries; do
  grep -q "\`$key\`" docs/SETUP.md || fail "docs/SETUP.md config table lacks $key"
done

npm run build
# Full suite: the dedup corpus (exact, reworded, reordered, extended vs unrelated; FP <= 2%), eligibility,
# merge accept/undo, summaries with and without an LLM, unsupported claims dropped, taint, embeddings,
# idempotence and rejection memory, config; plus every earlier phase.
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog5-")))')"
mock_pid=""
trap '[[ -n "$mock_pid" ]] && kill "$mock_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode read-only --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
setcfg() {
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));Object.assign(c,JSON.parse(process.argv[2]));fs.writeFileSync(f,JSON.stringify(c));' "$EBRAIN_CONFIG" "$1"
}
mkdir -p "$tmp/vault/notes" "$tmp/vault/_raw"
deploy='We deploy the billing API every Friday afternoon after the integration suite passes. Rollbacks use the previous container tag. The on-call engineer watches error rates for one hour.'
printf -- '---\ntitle: Deploys\noccurred: 2026-01-10\n---\n%s\n' "$deploy" > "$tmp/vault/notes/deploy.md"
printf -- '---\ntitle: Deploys v2\noccurred: 2026-05-10\n---\n%s\n\nCanary deploys get five percent of traffic first.\n' "$deploy" > "$tmp/vault/notes/deploy-v2.md"
printf -- '---\ntitle: Raw copy\n---\n%s\n' "$deploy" > "$tmp/vault/_raw/deploy-raw.md"
printf -- '---\ntitle: Pinned copy\npinned: true\n---\n%s\n' "$deploy" > "$tmp/vault/notes/deploy-pinned.md"
printf -- '---\ntitle: Garden\n---\nTomatoes go in the south bed after the last frost. Basil grows well between them.\n' > "$tmp/vault/notes/garden.md"
printf -- '---\ntitle: Roadmap Q1\ntags: [roadmap]\n---\nQ1 focuses on the onboarding flow for agencies. Design starts in January.\n' > "$tmp/vault/notes/r1.md"
printf -- '---\ntitle: Roadmap Q2\ntags: [roadmap]\nuntrusted_origin: true\n---\nQ2 adds the billing dashboard and invoice exports. Finance reviews it.\n' > "$tmp/vault/notes/r2.md"
printf -- '---\ntitle: Roadmap Q3\ntags: [roadmap]\n---\nQ3 is reserved for performance work on search. Budgets get tighter.\n<!-- mock:badclaim -->\n' > "$tmp/vault/notes/r3.md"
eb ids assign > /dev/null || fail "ids assign"

# Without a provider (embeddings off): one merge (raw and pinned copies skipped) and one extractive summary.
eb cognition run consolidate --dry-run > "$tmp/dry.out" || fail "dry run"
grep -q '2 would be created' "$tmp/dry.out" || { cat "$tmp/dry.out" >&2; fail "dry run count"; }
[[ ! -e "$tmp/vault/_inbox" ]] || [[ -z "$(ls "$tmp/vault/_inbox")" ]] || fail "dry run wrote to the vault"
eb cognition run consolidate > "$tmp/run0.out" || fail "cognition run consolidate"
grep -q 'proposals: 2 created' "$tmp/run0.out" || { cat "$tmp/run0.out" >&2; fail "proposal count"; }
grep -q 'skipped 1 pinned' "$tmp/run0.out" || fail "pinned note not skipped"
if grep -l 'deploy-raw\|deploy-pinned' "$tmp/vault/_inbox/"*.md; then fail "a raw or pinned note was proposed"; fi
sum="$(grep -l '^proposal_type: summary' "$tmp/vault/_inbox/"*.md)"
grep -q '^untrusted_origin: true' "$sum" || fail "taint did not carry into the summary proposal"
grep -q 'kind: summary' "$sum" || fail "summary note lacks kind: summary"
grep -q 'derived_from' "$sum" || fail "summary note lacks derived_from"
eb cognition run consolidate | grep -q 'proposals: 0 created, 2 already in _inbox/' || fail "re-run created proposals"
if grep -lE "billing|Roadmap|onboarding" "$tmp/state/runs/"*.json; then fail "note text in a run record"; fi

# Accept the merge: the kept note gains a cited section, the other is archived (never deleted); undo restores both.
mid="$(eb review list | grep 'merge' | cut -f1)"
[[ -n "$mid" ]] || fail "merge proposal not listed"
cp "$tmp/vault/notes/deploy.md" "$tmp/old.orig"; cp "$tmp/vault/notes/deploy-v2.md" "$tmp/keep.orig"
count_before="$(find "$tmp/vault" -name '*.md' -not -path '*/_inbox/*' | wc -l)"
eb review accept "$mid" > /dev/null || fail "review accept merge"
[[ -f "$tmp/vault/_archive/notes/deploy.md" ]] || fail "merged note not archived"
[[ ! -e "$tmp/vault/notes/deploy.md" ]] || fail "merged note still at its path"
count_after="$(find "$tmp/vault" -name '*.md' -not -path '*/_inbox/*' | wc -l)"
[[ "$count_before" == "$count_after" ]] || fail "accept changed the number of notes ($count_before -> $count_after)"
grep -q '^status: archived$' "$tmp/vault/_archive/notes/deploy.md" || fail "status not archived"
keepid="$(sed -n 's/^id: //p' "$tmp/vault/notes/deploy-v2.md")"
grep -q "^merged_into: $keepid\$" "$tmp/vault/_archive/notes/deploy.md" || fail "merged_into not set"
grep -q '^archived_at: ' "$tmp/vault/_archive/notes/deploy.md" || fail "archived_at not set"
grep -q '^## Merged from Deploys' "$tmp/vault/notes/deploy-v2.md" || fail "merged section missing"
grep -qE 'note:[A-Za-z0-9_]+@[0-9a-f]{16}' "$tmp/vault/notes/deploy-v2.md" || fail "merged section lacks a citation"
eb review undo "$mid" > /dev/null || fail "review undo merge"
cmp -s "$tmp/old.orig" "$tmp/vault/notes/deploy.md" || fail "undo did not restore the archived note"
cmp -s "$tmp/keep.orig" "$tmp/vault/notes/deploy-v2.md" || fail "undo did not restore the kept note"
[[ ! -e "$tmp/vault/_archive/notes/deploy.md" ]] || fail "undo left the archive copy"

# With the mock provider: a claim whose quote is not verbatim in its source is dropped.
sid="$(eb review list | grep 'summary' | cut -f1)"
eb review reject "$sid" --reason "try the model" > /dev/null || fail "reject the summary"
node dist/tests/llm-mock-server.js "$tmp/requests.log" > "$tmp/port" &
mock_pid=$!
for _ in $(seq 1 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
port="$(head -n1 "$tmp/port")"
[[ -n "$port" ]] || fail "mock server did not start"
setcfg '{"llm":{"provider":"openai-compatible","model":"mock-1","baseUrl":"http://127.0.0.1:'"$port"'/v1"}}'
eb cognition run consolidate --reconsider > "$tmp/run1.out" || fail "cognition run consolidate (mock provider)"
grep -q 'claims: 2 supported, 1 dropped' "$tmp/run1.out" || { cat "$tmp/run1.out" >&2; fail "claim verification counts"; }
sum2="$(grep -l '^proposal_type: summary' "$tmp/vault/_inbox/"*.md)"
grep -q '> Q1 focuses on the onboarding flow for agencies.' "$sum2" || fail "supported claim quote missing"
if grep -q 'not in any source note' "$sum2"; then fail "an unsupported claim was kept"; fi
grep -q '^untrusted_origin: true' "$sum2" || fail "taint did not carry into the LLM summary proposal"

echo "cog-phase05: OK"
