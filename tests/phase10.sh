#!/usr/bin/env bash
# Phase 10 verification: conversation importers (Claude Code JSONL, Claude.ai
# and ChatGPT exports) into the scrubbed raw archive, and the safe zip reader.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase10: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/yauzl ]] || npm ci --ignore-scripts

for f in src/import/zip.ts src/import/sources.ts src/import/load.ts src/import/archive.ts src/cli/import-commands.ts \
  tests/import.test.ts tests/conversation-fixtures.ts tests/zip-writer.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Dependency: yauzl pinned exactly, in the lockfile, justified with its transitive count.
node -e '
const p = require("./package.json"), l = require("./package-lock.json");
if (p.dependencies.yauzl !== "3.4.0") process.exit(1);
if (!/^\d+\.\d+\.\d+$/.test(p.devDependencies["@types/yauzl"] ?? "")) process.exit(2);
if (l.packages["node_modules/yauzl"]?.version !== "3.4.0") process.exit(3);' || fail "yauzl is not pinned in package.json and the lockfile"
grep -qE '^- `yauzl` 3\.4\.0: .*Transitive: [0-9]+' docs/DEPENDENCIES.md || fail "docs/DEPENDENCIES.md lacks the yauzl line with its transitive count"
grep -q '`@types/yauzl`' docs/DEPENDENCIES.md || fail "docs/DEPENDENCIES.md lacks @types/yauzl"

# Static: yauzl only in src/import/zip.ts, never opening paths itself; sources only through openExternalFile.
if grep -rln "from 'yauzl'" src | grep -v '^src/import/zip.ts$'; then fail "yauzl imported outside src/import/zip.ts"; fi
if grep -nE 'yauzl\.(open|fromFd|fromBuffer)' src/import/zip.ts; then fail "zip reader opens paths or fds directly"; fi
grep -q 'fromRandomAccessReader' src/import/zip.ts || fail "zip reader does not use the random-access reader"
grep -q 'openExternalFile' src/import/load.ts || fail "importers do not read through openExternalFile"
grep -q 'resolveInRoot' src/import/load.ts || fail "importers do not resolve sources with resolveInRoot"
if grep -rn "from 'node:fs'" src/import; then fail "src/import imports node:fs"; fi
if grep -rnE "import/|import-commands" src/mcp/*.ts; then fail "MCP code reaches the importers"; fi
if grep -nE 'scrub\??:|noScrub|--no-scrub|skipScrub' src/import/*.ts src/cli/import-commands.ts; then fail "scrubbing looks optional"; fi
grep -q "type !== 'human'" src/import/archive.ts || fail "archive writer does not require a human principal"
grep -q "type !== 'human'" src/cli/import-commands.ts || fail "import CLI does not require a human principal"
grep -q "tier: 6, name: 'raw'.*registered: 10" src/index/rank.ts || fail "rank.ts lacks the T6 raw row (Phase 10)"
grep -q "'raw-archive'" src/mcp/tools.ts || fail "raw results are not labeled"

# Docs.
grep -q '^## Importing conversations (raw archive)' docs/SETUP.md || fail "docs/SETUP.md lacks the importing section"
for pat in 'ebrain import claude-code' 'ebrain import claude-export' 'ebrain import chatgpt-export' '--dry-run' '_raw/conversations/<source>/<yyyy>/<id>.md' 'synced' 'git' 'human'; do
  sed -n '/^## Importing conversations/,/^## Auditing/p' docs/SETUP.md | grep -qF -- "$pat" || fail "SETUP importing section lacks: $pat"
done
grep -q 'Conversation importers (Phase 10' docs/SECURITY.md || fail "docs/SECURITY.md lacks the importer bullet"
grep -q 'raw-archive' docs/RANKING.md || fail "docs/RANKING.md lacks the raw-archive label"

npm run build
# Full suite: Phases 1-9 plus the parsers, the safe zip reader (zip-slip,
# absolute/backslash names, oversized entries, entry count, total size, lying
# headers), the archive writer (stable ids, occurred, idempotence, atomic
# update, dry run, human only, symlinked _raw/), the CLI per source, and raw
# notes in search (T6, label, notice).
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p10-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home"
export HOME="$tmp/home"
node dist/tests/conversation-fixtures.js "$tmp/fx" > "$tmp/manifest.json" || fail "fixture generation"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init (human)"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
eb() { node dist/src/cli/main.js "$@"; }
vault_sum() { (cd "$tmp/vault" && find . -type f -exec shasum {} + | sort | shasum); }

# Dry run: counts, nothing written.
before="$(vault_sum)"
eb import claude-code --projects-dir "$tmp/fx/projects" --dry-run > "$tmp/dry.out" || fail "dry run"
grep -q '^dry run: import claude-code: 2 conversations, 6 turns (2 would create' "$tmp/dry.out" || { cat "$tmp/dry.out" >&2; fail "dry-run counts"; }
grep -qE '^scrub findings: .*aws-access-key: 1' "$tmp/dry.out" || fail "dry run lacks finding counts"
[[ "$(vault_sum)" == "$before" ]] || fail "dry run wrote to the vault"
[[ ! -e "$tmp/vault/_raw/conversations" ]] || fail "dry run created archive directories"

# Imports: counts, malformed lines counted, findings reported.
eb import claude-code --projects-dir "$tmp/fx/projects" > "$tmp/cc.out" || fail "import claude-code"
grep -q '^import claude-code: 2 conversations, 6 turns (2 created, 0 updated, 0 unchanged)' "$tmp/cc.out" || { cat "$tmp/cc.out" >&2; fail "claude-code counts"; }
grep -q '2 malformed lines' "$tmp/cc.out" || fail "malformed JSONL lines not counted"
grep -qE '^scrub findings: .*openai-key: 1' "$tmp/cc.out" || fail "claude-code findings"
eb import claude-export "$tmp/fx/claude-export.zip" > "$tmp/ce.out" || fail "import claude-export"
grep -q '^import claude-export: 2 conversations, 5 turns (2 created' "$tmp/ce.out" || { cat "$tmp/ce.out" >&2; fail "claude-export counts"; }
grep -qE '^skipped: 1 empty, 0 duplicate, 0 unusable conversations; 2 malformed records' "$tmp/ce.out" || fail "claude-export skipped counts"
grep -qE '^scrub findings: .*github-token: 1' "$tmp/ce.out" || fail "claude-export findings"
eb import chatgpt-export "$tmp/fx/chatgpt-export.zip" > "$tmp/cg.out" || fail "import chatgpt-export"
grep -q '^import chatgpt-export: 2 conversations, 6 turns (2 created' "$tmp/cg.out" || { cat "$tmp/cg.out" >&2; fail "chatgpt-export counts"; }
grep -qE '^scrub findings: .*stripe-key: 1' "$tmp/cg.out" || fail "chatgpt-export findings"
[[ "$(find "$tmp/vault/_raw/conversations" -name 'raw_*.md' | wc -l | tr -d ' ')" == "6" ]] || fail "expected 6 archive files"

# Archive files: path shape, id = stable function, occurred = start, redactions, no secrets, private mode.
node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [vault, manifest] = process.argv.slice(1);
const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
const root = path.join(vault, "_raw/conversations");
let all = "";
for (const source of fs.readdirSync(root)) for (const y of fs.readdirSync(path.join(root, source))) for (const f of fs.readdirSync(path.join(root, source, y))) {
  const p = path.join(root, source, y, f);
  const text = fs.readFileSync(p, "utf8");
  all += text;
  const fm = Object.fromEntries(text.split("\n---\n")[0].split("\n").slice(1).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
  const conv = fm.conversation_id.replace(/^"|"$/g, "");
  const id = "raw_" + crypto.createHash("sha256").update(source + "\n" + conv).digest("hex").slice(0, 32);
  if (fm.id !== id || f !== id + ".md") { console.error("id", p); process.exit(1); }
  if (fm.kind !== "raw" || fm.schema !== "1" || fm.scrubVersion !== "1") { console.error("fields", p); process.exit(2); }
  if (fm.occurred !== m.starts[source + "/" + conv] || fm.occurred !== fm.started || y !== fm.started.slice(0, 4)) { console.error("occurred", p); process.exit(3); }
  if ((fs.statSync(p).mode & 0o777) !== 0o600) { console.error("mode", p); process.exit(4); }
}
for (const s of m.secrets) if (all.includes(s)) { console.error("secret leaked"); process.exit(5); }
if ((all.match(/\[REDACTED:/g) || []).length < m.secrets.length) process.exit(6);
for (const dropped of ["secret plan thoughts", "tool output text", "subagent chatter", "hidden reasoning", "abandoned branch"]) if (all.includes(dropped)) { console.error(dropped); process.exit(7); }' \
  "$tmp/vault" "$tmp/manifest.json" || fail "archive file contents"

# Re-running every import changes no file and keeps every id.
sum="$(vault_sum)"
eb import claude-code --projects-dir "$tmp/fx/projects" | grep -q '(0 created, 0 updated, 2 unchanged)' || fail "claude-code re-run"
eb import claude-export "$tmp/fx/claude-export.zip" | grep -q '(0 created, 0 updated, 2 unchanged)' || fail "claude-export re-run"
eb import claude-export "$tmp/fx/claude-export" | grep -q '(0 created, 0 updated, 2 unchanged)' || fail "claude-export (directory) re-run"
eb import chatgpt-export "$tmp/fx/chatgpt-export.zip" | grep -q '(0 created, 0 updated, 2 unchanged)' || fail "chatgpt-export re-run"
[[ "$(vault_sum)" == "$sum" ]] || fail "re-import changed files"

# Hostile archives: rejected, nothing written outside (or inside) the vault and state dir.
state_files_before="$(find "$tmp/state" -type f ! -name 'audit*' | sort)"
fx_sum="$(cd "$tmp" && find fx -type f -exec shasum {} + | sort | shasum)"
for z in zip-slip absolute backslash oversized too-many bomb; do
  if eb import chatgpt-export "$tmp/fx/hostile/$z.zip" > "$tmp/h.out" 2> "$tmp/h.err"; then fail "hostile archive $z accepted"; fi
  grep -q 'archive rejected' "$tmp/h.err" || { cat "$tmp/h.err" >&2; fail "hostile archive $z: no rejection message"; }
done
grep -q 'entry-count' <(eb import claude-export "$tmp/fx/hostile/too-many.zip" 2>&1 || true) || fail "entry-count rejection"
grep -q 'entry-size' <(eb import claude-export "$tmp/fx/hostile/oversized.zip" 2>&1 || true) || fail "entry-size rejection"
grep -q 'entry-name' <(eb import claude-export "$tmp/fx/hostile/zip-slip.zip" 2>&1 || true) || fail "zip-slip rejection"
[[ "$(vault_sum)" == "$sum" ]] || fail "hostile archive changed the vault"
[[ "$(find "$tmp/state" -type f ! -name 'audit*' | sort)" == "$state_files_before" ]] || fail "hostile archive wrote to the state dir"
[[ "$(cd "$tmp" && find fx -type f -exec shasum {} + | sort | shasum)" == "$fx_sum" ]] || fail "hostile archive wrote next to the source"
[[ ! -e "$tmp/evil.md" && ! -e "$tmp/fx/evil.md" && ! -e /tmp/evil.md ]] || fail "zip-slip entry was written"

# Scrubbing cannot be turned off; agents are refused.
eb import claude-export "$tmp/fx/claude-export.zip" --no-scrub > /dev/null 2>&1 && fail "accepted --no-scrub"
node dist/src/cli/main.js init --vault "$tmp/agent-vault" --principal bot-10 --type agent --mode journal --state-dir "$tmp/agent-state" \
  --config "$tmp/agent-cfg/config.json" > /dev/null || fail "ebrain init (agent)"
if EBRAIN_CONFIG="$tmp/agent-cfg/config.json" node dist/src/cli/main.js import claude-code --projects-dir "$tmp/fx/projects" > /dev/null 2> "$tmp/agent.err"; then
  fail "agent principal allowed to import conversations"
fi
grep -q 'human principal' "$tmp/agent.err" || fail "agent refusal message"
[[ ! -e "$tmp/agent-vault/_raw/conversations" ]] || fail "agent import wrote an archive"

# Raw notes are searchable over MCP, tier 6, labeled raw-archive, below a curated note.
mkdir -p "$tmp/vault/notes"
printf '# Budget\n\nchatgptmarker curated budget note\n' > "$tmp/vault/notes/budget.md"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"chatgptmarker"}}}'
  sleep 1
} | node dist/src/cli/main.js mcp > "$tmp/stdout.jsonl" 2> "$tmp/stderr.log" || fail "ebrain mcp exited non-zero"
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
const r = lines.find((l) => l.id === 2).result;
if (r.isError) process.exit(1);
const t = r.content[0].text;
const rows = t.split("\n").filter((l) => l.startsWith("{\"id\"")).map(JSON.parse);
const tiers = rows.map((x) => [x.folder_class, x.tier]);
if (JSON.stringify(tiers) !== JSON.stringify([["curated", 1], ["raw", 6]])) { console.error(tiers); process.exit(2); }
if (rows[1].kind !== "raw" || !rows[1].labels.includes("raw-archive") || rows[1].occurred !== "2026-01-01T00:00:00Z") process.exit(3);
if (!t.includes("not established facts")) process.exit(4);' "$tmp/stdout.jsonl" || fail "raw archive search over MCP"

echo "phase10: OK"
