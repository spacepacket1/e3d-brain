#!/usr/bin/env bash
# Cognition Phase 8 verification: `report_use` (every mode, state directory
# only), the `note_usage` rollup and `ebrain cognition stats usage`, the
# bounded `rank.usageBoost` nudge (evidence-linked counters only), the opt-in
# query log with `ebrain queries prune`, and the `gaps` job.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase08: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/mcp/usage-tools.ts src/recall/usage.ts src/recall/usage-rollup.ts src/recall/queries.ts src/cognition/jobs/gaps.ts tests/usage.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Registry: report_use is a cog-8 entry in every mode, and memory-phase assertions never include it.
node -e '
const t = JSON.parse(require("fs").readFileSync("tests/fixtures/tools-by-mode.json", "utf8"));
const e = t.find((x) => x.name === "report_use");
if (!e || e.phase !== "cog-8" || [...e.modes].sort().join(",") !== "inbox,journal,read-only") process.exit(1);
for (const m of ["inbox", "journal", "read-only"]) {
  const memory = t.filter((x) => typeof x.phase === "number" && x.phase <= 15 && x.modes.includes(m));
  if (memory.some((x) => x.name === "report_use")) process.exit(1);
}' || fail "tools-by-mode.json lacks report_use as cog-8 in every mode"
grep -q 'upToCognitionPhase' tests/tool-registry.ts || fail "expectedTools lacks the cognition phase parameter"

# Static: MCP writes no files itself and does not import cognition code; logs live in src/recall; the gaps job is registered and uses no model.
if grep -nE '\b(createExclusive|writeAtomic|renameSafe|unlinkSafe|mkdirSafe|appendSafe|writeFileSync|renameSync|unlinkSync|mkdirSync)\b' src/mcp/*.ts; then fail "filesystem write call in src/mcp/"; fi
if grep -rnE "from '\.\./cognition/" src/mcp; then fail "src/mcp imports cognition code"; fi
grep -q 'GAPS_JOB' src/cognition/jobs/index.ts || fail "gaps job not registered"
grep -q "llm: 'never'" src/cognition/jobs/gaps.ts || fail "gaps must not use a model"
grep -q 'CREATE TABLE note_usage' src/index/db.ts || fail "note_usage table missing"
grep -q 'usageNet' src/index/rank.ts || fail "ranking nudge missing from rank.ts"

# Docs.
grep -q '^## Usefulness feedback and gaps' docs/SETUP.md || fail "docs/SETUP.md lacks the usefulness section"
for key in queryLog.enabled queryLog.retentionDays rank.usageBoost cognition.gaps.minQueries cognition.gaps.minPoorRate cognition.gaps.minSimilarity; do
  grep -q "\`$key\`" docs/SETUP.md || fail "docs/SETUP.md config table lacks $key"
done
grep -q 'counter state' docs/RANKING.md || fail "docs/RANKING.md lacks the I11 amendment"

npm run build
# Full suite: report_use (all modes, refusals, limits), rollups, the nudge, the query log, gaps, forget's usage signals, config; plus every earlier phase.
npm test

# End to end from the shell. Dates are far in the past so the checks hold whatever today is.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog8-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal tester --type human --mode read-only --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
mkdir -p "$tmp/vault/notes"
printf -- '---\ntitle: Zebra facts\ncreated: 2024-01-01\n---\nzebra stripes are unique.\n' > "$tmp/vault/notes/zebra.md"
eb ids assign > /dev/null || fail "ids assign"

# Drive the MCP dispatcher in-process (read-only mode): query log off first, then on.
session() { # extra config JSON (merged), prints "<recall_id> <note_id>" lines
  node -e '
const fs = require("fs");
const cfgPath = process.env.EBRAIN_CONFIG;
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
Object.assign(cfg, JSON.parse(process.argv[1]));
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
(async () => {
  const { loadConfig } = require("./dist/src/config.js");
  const { createMcpRuntime } = require("./dist/src/mcp/server.js");
  const { dispatch } = require("./dist/src/mcp/dispatch.js");
  const rt = createMcpRuntime(loadConfig({}));
  try {
    const s = await dispatch(rt.ctx, "search", { query: "zebra" });
    const rid = /"recall_id":"([A-Za-z0-9_]+)"/.exec(s.content[0].text)[1];
    const fs2 = require("fs"), path = require("path");
    const rec = fs2.readFileSync(path.join(loadConfig({}).config.stateDir, "recalls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.recall_id === rid);
    console.log(rid + " " + rec.ids[0].id);
  } finally { rt.close(); }
})().catch((e) => { console.error(e); process.exit(1); });' "$1"
}
out="$(session '{}')" || fail "search session (query log off)"
[[ ! -e "$tmp/state/queries.jsonl" ]] || fail "queries.jsonl exists with queryLog.enabled=false"
read -r rid nid <<< "$out"

sumv="$(find "$tmp/vault" -type f -exec shasum {} + | sort | shasum)"
node -e '
(async () => {
  const { loadConfig } = require("./dist/src/config.js");
  const { createMcpRuntime } = require("./dist/src/mcp/server.js");
  const { dispatch } = require("./dist/src/mcp/dispatch.js");
  const rt = createMcpRuntime(loadConfig({}));
  try {
    const [rid, nid] = process.argv.slice(1);
    const bad = await dispatch(rt.ctx, "report_use", { recall_id: "01NOSUCHRECALL", note_ids: [nid] });
    if (!bad.isError) throw new Error("unknown recall accepted");
    const foreign = await dispatch(rt.ctx, "report_use", { recall_id: rid, note_ids: ["not_in_recall"] });
    if (!foreign.isError) throw new Error("foreign note id accepted");
    const ok = await dispatch(rt.ctx, "report_use", { recall_id: rid, note_ids: [nid], helpful: true });
    if (ok.isError) throw new Error("valid report refused: " + JSON.stringify(ok));
    const dup = await dispatch(rt.ctx, "report_use", { recall_id: rid, note_ids: [nid] });
    if (dup.isError || !/"recorded":0/.test(dup.content[0].text)) throw new Error("duplicate not ignored");
  } finally { rt.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });' "$rid" "$nid" || fail "report_use over the dispatcher"
[[ "$(find "$tmp/vault" -type f -exec shasum {} + | sort | shasum)" == "$sumv" ]] || fail "report_use changed the vault"
[[ "$(wc -l < "$tmp/state/usage.jsonl" | tr -d ' ')" == "1" ]] || fail "usage.jsonl should hold exactly one event"
[[ "$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$tmp/state/usage.jsonl")" == "600" ]] || fail "usage.jsonl is not 0600"
grep -q '"label":"self_reported"' "$tmp/state/usage.jsonl" || fail "event not labeled self_reported"

eb cognition stats usage > "$tmp/usage.out" || { cat "$tmp/usage.out" >&2; fail "stats usage"; }
grep -q '1 notes recalled or reported' "$tmp/usage.out" || { cat "$tmp/usage.out" >&2; fail "stats usage count"; }
grep -q '1 reported used (self-reported), 0 evidence-linked good, 0 evidence-linked bad' "$tmp/usage.out" || fail "stats usage totals"

# Query log on: a normal query is logged, one with a credential is not; prune honors retention.
key="$(node -e 'process.stdout.write(["s","k-"].join("")+"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7kL9mN1pQ")')"
session '{"queryLog":{"enabled":true}}' > /dev/null || fail "search session (query log on)"
node -e '
(async () => {
  const { loadConfig } = require("./dist/src/config.js");
  const { createMcpRuntime } = require("./dist/src/mcp/server.js");
  const { dispatch } = require("./dist/src/mcp/dispatch.js");
  const rt = createMcpRuntime(loadConfig({}));
  try { await dispatch(rt.ctx, "search", { query: "how to use " + process.argv[1] }); } finally { rt.close(); }
})();' "$key"
[[ "$(wc -l < "$tmp/state/queries.jsonl" | tr -d ' ')" == "1" ]] || fail "expected exactly one logged query"
grep -q '"query":"zebra"' "$tmp/state/queries.jsonl" || fail "query not logged"
if grep -q 'sk-' "$tmp/state/queries.jsonl"; then fail "a credential reached the query log"; fi
printf '{"ts":"2020-01-01T00:00:00.000Z","recall_id":"r","principal":"tester","query":"ancient","results":0,"top_tier":null}\n' >> "$tmp/state/queries.jsonl"
eb queries prune | grep -q 'kept 1, removed 1 (older than 30 days)' || fail "queries prune"

# gaps on a fixture log: expected top clusters, a count-citing proposal that changes nothing.
node -e '
const fs = require("fs");
const now = Date.now();
const rows = [];
const q = (query, results, tier, i) => rows.push(JSON.stringify({ ts: new Date(now - i * 60000).toISOString(), recall_id: "r" + i, principal: "tester", query, results, top_tier: tier }));
for (let i = 0; i < 4; i++) q(["pricing latency tokens", "latency tokens pricing", "pricing latency tokens", "what is the latency pricing tokens"][i], 0, null, i + 1);
for (let i = 0; i < 3; i++) q("kafka consumer lag", 0, null, i + 10);
for (let i = 0; i < 3; i++) q("deploy rollback steps", 2, 1, i + 20);
fs.writeFileSync(process.argv[1], rows.join("\n") + "\n", { mode: 0o600 });' "$tmp/state/queries.jsonl"
sumv="$(find "$tmp/vault/notes" -type f -exec shasum {} + | sort | shasum)"
eb cognition run gaps > "$tmp/gaps.out" || { cat "$tmp/gaps.out" >&2; fail "cognition run gaps"; }
grep -q 'proposals: 2 created' "$tmp/gaps.out" || { cat "$tmp/gaps.out" >&2; fail "gap proposal count"; }
[[ "$(find "$tmp/vault/notes" -type f -exec shasum {} + | sort | shasum)" == "$sumv" ]] || fail "gaps changed a note"
grep -lq 'proposal_type: gap' "$tmp/vault/_inbox/"*.md || fail "no gap proposal file"
grep -q 'Asked 4 times, best result tier none' "$tmp/vault/_inbox/"*latency*.md || fail "gap proposal lacks the counts"
grep -q 'Asked 3 times, best result tier none' "$tmp/vault/_inbox/"*kafka*.md || fail "kafka gap lacks the counts"
if grep -l 'deploy' "$tmp/vault/_inbox/"*.md; then fail "a well-answered query cluster was proposed"; fi
eb cognition run gaps | grep -q 'proposals: 0 created, 2 already in _inbox/' || fail "gaps re-run created proposals"

echo "cog-phase08: OK"
