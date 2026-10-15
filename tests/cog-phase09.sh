#!/usr/bin/env bash
# Cognition Phase 9 verification: `ebrain cognition report [--check]` (online
# metrics from review records, kill criteria), `cognition run --shadow`
# (proposals under <stateDir>/shadow/, nothing in _inbox/), `ebrain eval
# replay` (git archive into a temp dir, temp index and state, counts against
# later actions; the documented message without git), the operations docs,
# and the safety scan.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "cog-phase09: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
command -v git > /dev/null || fail "git is required for the replay checks"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/cognition/report.ts src/cognition/outcomes.ts src/eval/replay.ts src/eval/tar.ts src/exec/git.ts src/cli/eval-commands.ts \
  docs/COGNITION-EVAL.md tests/eval.test.ts tests/cognition-safety.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: git only through src/exec/ with argument arrays; never worktree/checkout; no MCP path into cognition, eval, or review.
if grep -rln "node:child_process" src | grep -v '^src/exec/'; then fail "child_process outside src/exec/"; fi
grep -q "shell: false" src/exec/git.ts || fail "git is not spawned with shell: false"
if grep -nE "'(worktree|checkout)'" src/exec/git.ts src/eval/*.ts; then fail "replay must never use git worktree/checkout"; fi
grep -q "'archive'" src/exec/git.ts || fail "replay does not use git archive"
if grep -rnE "from '\.\./(cognition|eval|review)/" src/mcp; then fail "src/mcp imports cognition, eval, or review code"; fi
if grep -nE '\b(resolveInVault|resolveInState|writeInboxFile|writeAtomic)\b' src/eval/*.ts; then fail "src/eval must write only below its temp directory"; fi
grep -q 'shadow_proposals' src/cognition/runs.ts || fail "run records lack shadow_proposals"
grep -q "edited:" src/review/queue.ts || fail "review edit does not stamp edited"

# Docs.
grep -q '^## Cognition$' docs/SETUP.md || fail "docs/SETUP.md lacks the Cognition section"
for pat in 'cron' 'launchd' "agent's brain" 'Jobs run per brain only' 'local first' 'Per-run budgets' 'cognition report --check' 'eval replay' '--shadow' 'only online metrics are available'; do
  grep -qF -- "$pat" docs/SETUP.md || fail "docs/SETUP.md Cognition section lacks: $pat"
done
for job in supersede consolidate reflect forget gaps; do
  grep -qE "^\| \`$job\` \| [0-9]+% \| [0-9]+ \| [0-9]+ \|" docs/COGNITION-EVAL.md || fail "docs/COGNITION-EVAL.md lacks the $job threshold"
done
grep -q 'exits \*\*3\*\*' docs/COGNITION-EVAL.md || fail "docs/COGNITION-EVAL.md does not state the --check exit code"

npm run build
# Full suite: report counts per job/version, the edited stamp, --check, shadow runs, replay (fixture git vault,
# dates, no git, dirty tree), the tar reader, the outcome matcher, the safety scan; plus every earlier phase.
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-cog9-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
export GIT_CONFIG_NOSYSTEM=1
node dist/src/cli/main.js init --vault "$tmp/vault" --principal tester --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
mkdir -p "$tmp/vault/notes"
for i in 1 2 3 4; do
  printf -- '---\nid: note_%s\ntitle: Note %s\ncreated: 2024-01-0%s\ntags: [ebrain-selftest]\n---\nBody %s.\n' "$i" "$i" "$i" "$i" > "$tmp/vault/notes/n$i.md"
done

# Without git: replay exits 1 with the documented message.
out="$(eb eval replay --job selftest --at HEAD 2>&1)" && fail "replay without git succeeded"
grep -q 'only online metrics are available: ebrain cognition report' <<< "$out" || { echo "$out" >&2; fail "replay without git: wrong message"; }

# Shadow: no _inbox/ files and no vault change (checksum).
rm -rf "$tmp/vault/_inbox"
sumv="$(cd "$tmp/vault" && find . -type f -exec shasum {} + | sort | shasum)"
eb cognition run selftest --shadow > "$tmp/shadow.out" || { cat "$tmp/shadow.out" >&2; fail "shadow run"; }
grep -q 'proposals: 4 written to <stateDir>/shadow/' "$tmp/shadow.out" || { cat "$tmp/shadow.out" >&2; fail "shadow run count"; }
[[ ! -e "$tmp/vault/_inbox" ]] || fail "a shadow run created _inbox/"
[[ "$(cd "$tmp/vault" && find . -type f -exec shasum {} + | sort | shasum)" == "$sumv" ]] || fail "a shadow run changed the vault"
[[ "$(find "$tmp/state/shadow" -name '*.md' | wc -l | tr -d ' ')" == "4" ]] || fail "shadow proposals not under <stateDir>/shadow/"

# Replay on a git vault with known later actions: notes 1 and 2 demoted by hand afterwards.
git -C "$tmp/vault" init -q
git -C "$tmp/vault" add -A
GIT_AUTHOR_DATE=2026-03-01T00:00:00Z GIT_COMMITTER_DATE=2026-03-01T00:00:00Z git -C "$tmp/vault" -c user.email=o@example.invalid -c user.name=O -c commit.gpgsign=false commit -qm one
c1="$(git -C "$tmp/vault" rev-parse HEAD)"
for i in 1 2; do
  node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^---\n/,"---\nstatus: stale\n"))' "$tmp/vault/notes/n$i.md"
done
GIT_AUTHOR_DATE=2026-07-01T00:00:00Z GIT_COMMITTER_DATE=2026-07-01T00:00:00Z git -C "$tmp/vault" -c user.email=o@example.invalid -c user.name=O -c commit.gpgsign=false commit -qam two
sumv="$(cd "$tmp/vault" && find . -type f -exec shasum {} + | sort | shasum)"
runs_before="$(ls "$tmp/state/runs" | wc -l | tr -d ' ')"
eb eval replay --job selftest --at "$c1" > "$tmp/replay.out" || { cat "$tmp/replay.out" >&2; fail "eval replay"; }
grep -q 'shadow run: 4 proposals' "$tmp/replay.out" || { cat "$tmp/replay.out" >&2; fail "replay proposal count"; }
grep -q 'precision: 2 of 4 proposals match a later action (50%)' "$tmp/replay.out" || { cat "$tmp/replay.out" >&2; fail "replay precision"; }
grep -q 'recall: 2 of 2 later actions were proposed (100%)' "$tmp/replay.out" || { cat "$tmp/replay.out" >&2; fail "replay recall"; }
eb eval replay --job selftest --at 2026-04-01 | grep -q 'precision: 2 of 4' || fail "replay --at <date>"
[[ "$(cd "$tmp/vault" && find . -type f -exec shasum {} + | sort | shasum)" == "$sumv" ]] || fail "replay changed the vault working tree or .git"
[[ -z "$(git -C "$tmp/vault" status --porcelain)" ]] || fail "replay left the working tree dirty"
[[ "$(ls "$tmp/state/runs" | wc -l | tr -d ' ')" == "$runs_before" ]] || fail "replay wrote a run record to the owner's state dir"

# Dirty tree: refused with the online-metrics message.
echo "edit" >> "$tmp/vault/notes/n3.md"
out="$(eb eval replay --job selftest --at "$c1" 2>&1)" && fail "replay on a dirty tree succeeded"
grep -q 'uncommitted changes' <<< "$out" || { echo "$out" >&2; fail "dirty tree message"; }
git -C "$tmp/vault" checkout -q -- notes/n3.md

# report and --check on fixture review records: 1 accepted, 10 rejected forget proposals -> below threshold (exit 3).
node -e '
const { writeRunRecord } = require("./dist/src/cognition/runs.js");
const { ulid } = require("./dist/src/mcp/ulid.js");
const { ensurePrivateDir } = require("./dist/src/safe-path.js");
const fs = require("fs"), path = require("path");
const [vault, state] = process.argv.slice(1);
const t0 = Date.parse("2026-09-01T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const run = { run_id: ulid(t0), job: "forget", job_version: 1, prompt: null, provider: null, started: iso(t0), finished: iso(t0), status: "finished",
  options: { since: null, max_proposals: 20, dry_run: false, reconsider: false }, budget: { max_llm_calls: 1, max_input_chars: 1, max_proposals: 20, max_pending: 50 },
  inputs: { count: 0, sha256: "", notes: [] }, counts: {}, stop_reason: "complete", llm_requests: [], proposals: [] };
for (let i = 0; i < 11; i++) {
  const id = ulid(t0 + i + 1), key = "pk_" + String(i + 1).padStart(32, "0"), ok = i === 0;
  run.proposals.push({ id, proposal_key: key, digest: "d".repeat(64) });
  const dir = path.join(vault, ok ? "_inbox/_applied" : "_inbox/_rejected");
  fs.mkdirSync(dir, { recursive: true });
  const fm = ["id: " + id, "title: f" + i, "kind: proposal", "status: " + (ok ? "accepted" : "rejected"), "proposal_type: demote", "job: forget", "job_version: 1",
    "created: " + iso(t0), "proposal_key: " + key, "confidence: unrated", "untrusted_origin: false", (ok ? "applied: " : "rejected: ") + iso(t0 + 7200000)];
  if (!ok) fm.push("rejected_reason: still useful");
  fs.writeFileSync(path.join(dir, "f" + i + ".md"), "---\n" + fm.join("\n") + "\n---\nx\n");
}
writeRunRecord(ensurePrivateDir(state), run);' "$tmp/vault" "$tmp/state"
eb cognition report > "$tmp/report.out" || { cat "$tmp/report.out" >&2; fail "cognition report"; }
grep -q 'forget v1: 11 created; 1 accepted, 0 edited then accepted, 10 rejected, 0 stale, 0 pending, 0 missing; acceptance 9% (1/11 reviewed); median time to review 2.0h' "$tmp/report.out" \
  || { cat "$tmp/report.out" >&2; fail "report counts"; }
grep -q 'rejected reasons: "still useful" 10' "$tmp/report.out" || fail "report rejection reasons"
grep -q 'selftest v1: 1 runs, 4 proposals, 2 later done by hand (50%)' "$tmp/report.out" || { cat "$tmp/report.out" >&2; fail "shadow comparison"; }
set +e
eb cognition report --check > "$tmp/check.out" 2> "$tmp/check.err"
code=$?
set -e
[[ "$code" == "3" ]] || { cat "$tmp/check.out" "$tmp/check.err" >&2; fail "report --check should exit 3 below threshold (got $code)"; }
grep -q 'forget v1: 1/11 accepted (9%).*BELOW THRESHOLD' "$tmp/check.out" || fail "report --check verdict"

echo "cog-phase09: OK"
