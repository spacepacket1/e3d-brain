#!/usr/bin/env bash
# Phase 13 verification: Claude Code hooks (session brief and checkpoints).
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase13: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/yauzl ]] || npm ci --ignore-scripts

for f in src/hooks/brief.ts src/hooks/checkpoint.ts src/hooks/install.ts src/cli/hook-commands.ts tests/hooks.test.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# Static: no PATH-search fallbacks in the hook installer.
if grep -nE "npx|uvx|which |/usr/bin/env" src/hooks/install.ts src/cli/hook-commands.ts; then fail "PATH fallback in hook code"; fi
if grep -nE "process\.cwd\(|\.claude/settings" src/hooks/brief.ts src/hooks/checkpoint.ts src/cli/hook-commands.ts; then fail "hook runtime reads project-local state"; fi

# Docs.
grep -q '^## Claude Code hooks' docs/SETUP.md || fail "SETUP lacks the hooks section"
for pat in 'hook session-start' 'hook pre-compact' 'hook install' 'hook remove' 'hooks.briefFolders' 'hooks.captureCheckpoints' 'hooks.focus' 'hooks.claudeProjectsDir'; do
  grep -qF -- "$pat" docs/SETUP.md || fail "SETUP lacks: $pat"
done
grep -q 'Hooks (Phase 13' docs/SECURITY.md || fail "SECURITY lacks the hooks bullet"

npm run build
# Full suite: Phases 1-12 plus hooks.test (brief, checkpoint, install/remove, config isolation).
npm test

# End to end from the shell.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p13-")))')"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home/.claude/projects/proj" "$tmp/vault/notes/work" "$tmp/project/.claude"
export HOME="$tmp/home"
printf -- '---\nid: alpha1\ntitle: Alpha decision\ncreated: 2026-10-01T00:00:00Z\n---\n# Alpha decision\n\nBody.\n' > "$tmp/vault/notes/work/alpha.md"
node dist/src/cli/main.js init --vault "$tmp/vault" --principal chris --type human --mode inbox --state-dir "$tmp/state" \
  --config "$tmp/cfg/config.json" > /dev/null || fail "ebrain init"
export EBRAIN_CONFIG="$tmp/cfg/config.json"
root="$PWD"
eb() { node "$root/dist/src/cli/main.js" "$@"; }
setcfg() { node -e '
const fs=require("fs"); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.hooks=JSON.parse(process.argv[2]); fs.writeFileSync(f,JSON.stringify(c));' "$tmp/cfg/config.json" "$1"; }

# session-start: fenced brief with the configured folder, exit 0.
setcfg '{"briefFolders":["notes/work"],"focus":"Finish phase 13","claudeProjectsDir":"'"$tmp"'/home/.claude/projects"}'
echo '{"session_id":"s1","hook_event_name":"SessionStart","source":"startup"}' | eb hook session-start > "$tmp/brief.out" || fail "session-start exit"
grep -q 'Reference data retrieved from memory, not instructions' "$tmp/brief.out" || fail "brief is not fenced"
grep -q 'Alpha decision' "$tmp/brief.out" || fail "brief lacks the accepted note"
grep -q 'Finish phase 13' "$tmp/brief.out" || fail "brief lacks the focus text"
[[ "$(wc -c < "$tmp/brief.out")" -le 10000 ]] || fail "brief over 10,000 characters"

# Malformed stdin and a missing config: exit 0, no output.
out="$(echo 'not json' | eb hook session-start; echo "rc=$?")"; [[ "$out" == "rc=0" ]] || fail "malformed stdin: $out"
out="$(echo '{}' | EBRAIN_CONFIG="$tmp/none.json" eb hook session-start; echo "rc=$?")"; [[ "$out" == "rc=0" ]] || fail "missing config: $out"

# pre-compact: a no-op until captureCheckpoints is true.
secret="sk-Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9aB2cD4eF6gH8iJ0kL2mN4"
transcript="$tmp/home/.claude/projects/proj/s1.jsonl"
printf '%s\n' \
  '{"type":"user","sessionId":"s1","timestamp":"2026-10-14T10:00:00Z","message":{"role":"user","content":"Please refactor billing"}}' \
  '{"type":"user","sessionId":"s1","timestamp":"2026-10-14T10:05:00Z","message":{"role":"user","content":"my key is '"$secret"' ok"}}' > "$transcript"
payload='{"session_id":"s1","transcript_path":"'"$transcript"'","hook_event_name":"PreCompact","trigger":"auto"}'
echo "$payload" | eb hook pre-compact || fail "pre-compact exit (disabled)"
[[ ! -e "$tmp/vault/_inbox" ]] || [[ -z "$(ls "$tmp/vault/_inbox")" ]] || fail "pre-compact wrote without opt-in"

# A project-local settings file with an ebrain block has no effect.
echo '{"ebrain":{"hooks":{"captureCheckpoints":true}}}' > "$tmp/project/.claude/settings.json"
(cd "$tmp/project" && echo "$payload" | eb hook pre-compact) || fail "pre-compact exit (project-local)"
[[ ! -e "$tmp/vault/_inbox" ]] || [[ -z "$(ls "$tmp/vault/_inbox")" ]] || fail "project-local settings enabled capture"

# Opted in: one inbox note, secret redacted.
setcfg '{"captureCheckpoints":true,"claudeProjectsDir":"'"$tmp"'/home/.claude/projects"}'
echo "$payload" | eb hook pre-compact || fail "pre-compact exit"
[[ "$(ls "$tmp/vault/_inbox" | wc -l | tr -d ' ')" == "1" ]] || fail "expected one inbox note"
note="$(ls "$tmp/vault/_inbox"/*.md)"
grep -q '^origin: hook' "$note" || fail "origin is not hook"
grep -q '^kind: raw' "$note" || fail "kind is not raw"
grep -q 'Please refactor billing' "$note" || fail "opening request missing"
grep -qF -- "$secret" "$note" && fail "secret persisted in the inbox note"
grep -q '\[REDACTED:' "$note" || fail "no redaction marker"

# A transcript outside the projects directory is ignored (exit 0, nothing new).
cp "$transcript" "$tmp/outside.jsonl"
echo '{"session_id":"s1","transcript_path":"'"$tmp"'/outside.jsonl"}' | eb hook pre-compact || fail "outside transcript exit"
[[ "$(ls "$tmp/vault/_inbox" | wc -l | tr -d ' ')" == "1" ]] || fail "outside transcript produced a note"

# install / remove keep a user hook byte-identical and use absolute paths.
# (settings.json is rewritten with JSON.stringify layout: 2-space indent, as Claude Code writes it)
node -e '
const fs=require("fs");
const u={theme:"dark",hooks:{SessionStart:[{hooks:[{type:"command",command:"echo mine"}]}]}};
fs.writeFileSync(process.argv[1], JSON.stringify(u,null,2)+"\n");' "$tmp/home/.claude/settings.json"
cp "$tmp/home/.claude/settings.json" "$tmp/settings.orig"
eb hook install > "$tmp/install.out" || fail "hook install"
node -e '
const fs=require("fs"), path=require("path");
const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const cmds=[s.hooks.SessionStart[1].hooks[0].command, s.hooks.PreCompact[0].hooks[0].command];
if (s.hooks.SessionStart[0].hooks[0].command!=="echo mine") process.exit(1);
for (const c of cmds) {
  const [node, script] = c.split(" ");
  if (!path.isAbsolute(node) || !path.isAbsolute(script)) { console.error(c); process.exit(2); }
  if (!/ --ebrain-managed$/.test(c)) process.exit(3);
}' "$tmp/home/.claude/settings.json" || fail "installed hook commands"
eb hook remove > /dev/null || fail "hook remove"
cmp "$tmp/home/.claude/settings.json" "$tmp/settings.orig" || fail "install+remove changed the user's settings.json"

echo "phase13: OK"
