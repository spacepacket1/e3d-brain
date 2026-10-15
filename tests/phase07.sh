#!/usr/bin/env bash
# Phase 7 verification: the secret and sensitive-data scrubber and `ebrain scrub`.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "phase07: FAIL $*" >&2; exit 1; }

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail "node >= 22 required"
[[ -d node_modules/@modelcontextprotocol/sdk ]] || npm ci --ignore-scripts

for f in src/scrub/index.ts src/scrub/scrub.ts src/scrub/detectors.ts src/scrub/checks.ts src/scrub/bip39-english.ts \
  src/mcp/scrub-guard.ts src/cli/scrub-command.ts tests/scrub.test.ts tests/scrub-fixtures.ts; do
  [[ -f "$f" ]] || fail "missing $f"
done

# The entry point exports scrub and scrubVersion; the scrubber is pure (no I/O imports).
grep -q "export \* from './scrub.js'" src/scrub/index.ts || fail "src/scrub/index.ts does not re-export scrub.ts"
grep -q '^export function scrub(' src/scrub/scrub.ts || fail "no scrub export"
grep -q '^export const scrubVersion' src/scrub/scrub.ts || fail "no scrubVersion export"
if grep -nE "from 'node:(fs|net|http|https|child_process)'" src/scrub/*.ts; then fail "src/scrub must not do I/O"; fi
# No user regexes: extraPatterns are literals.
if grep -n 'new RegExp' src/scrub/*.ts; then fail "src/scrub must not compile user regexes"; fi

# Docs.
grep -q '^## Scrubbing' docs/SETUP.md || fail "docs/SETUP.md lacks a Scrubbing section"
grep -q 'ebrain scrub' docs/SETUP.md || fail "docs/SETUP.md lacks ebrain scrub"
grep -q 'DEFAULT_ENTROPY_THRESHOLD' docs/SETUP.md || fail "docs/SETUP.md does not document the entropy threshold"
grep -q 'Scrubber (Phase 7' docs/SECURITY.md || fail "docs/SECURITY.md lacks the scrubber bullet"

npm run build
# Full suite: Phases 1-6 plus the scrubber tests (corpus with precision/recall,
# no secret in any output, BIP39 vs prose, idempotence, 1 MB pathological
# inputs under a timeout, strict agent mode, journal-text preservation,
# literals, fail-safe writes, strict rejection through dispatch + audit, CLI).
npm test

# End to end from the shell: `ebrain scrub` on a fixture file of synthetic
# secrets prints redacted text and finding counts only.
tmp="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(fs.realpathSync(os.tmpdir()),"ebrain-p7-")))')"
trap 'rm -rf "$tmp"' EXIT
export EBRAIN_CONFIG="$tmp/no-config.json"
node --input-type=module -e "
import * as fs from 'node:fs';
import { fake, POSITIVES } from './dist/tests/scrub-fixtures.js';
const text = POSITIVES.map((p) => p.text).join('\n\n') + '\n';
fs.writeFileSync(process.argv[1] + '/leaky.md', text);
fs.writeFileSync(process.argv[1] + '/secrets.txt', POSITIVES.flatMap((p) => p.secrets).join('\n') + '\n');
fs.writeFileSync(process.argv[1] + '/agent.md', 'journal entry\n' + fake.openai() + '\n');
" "$tmp"
node dist/src/cli/main.js scrub "$tmp/leaky.md" > "$tmp/out.md" 2> "$tmp/err.txt" || fail "ebrain scrub exited non-zero"
grep -q '\[REDACTED:private-key\]' "$tmp/out.md" || fail "no private-key redaction in output"
grep -q '\[REDACTED:bip39-mnemonic\]' "$tmp/out.md" || fail "no mnemonic redaction in output"
grep -q '^findings:$' "$tmp/err.txt" || fail "no findings summary"
# stderr is the summary only: "findings:" then "type: count" lines.
grep -vqE '^(findings:|[a-z0-9-]+: [0-9]+)$' "$tmp/err.txt" && fail "stderr has more than finding counts"
node -e '
const fs = require("fs");
const secrets = fs.readFileSync(process.argv[1] + "/secrets.txt", "utf8").split("\n").filter(Boolean);
const out = fs.readFileSync(process.argv[1] + "/out.md", "utf8") + fs.readFileSync(process.argv[1] + "/err.txt", "utf8");
const leaked = secrets.filter((s) => out.includes(s));
if (leaked.length) { console.error("leaked", leaked.length, "fixture secrets"); process.exit(1); }' "$tmp" || fail "a fixture secret survived ebrain scrub"
# Strict mode: rejection, no text, detector type only, exit 3.
set +e
node dist/src/cli/main.js scrub --strict - < "$tmp/agent.md" > "$tmp/strict.out" 2> "$tmp/strict.err"
code=$?
set -e
[[ "$code" -eq 3 ]] || fail "strict scrub should exit 3 (got $code)"
[[ ! -s "$tmp/strict.out" ]] || fail "strict rejection printed text"
grep -q '^rejected (strict): openai-key$' "$tmp/strict.err" || fail "strict rejection does not name the detector"

echo "phase07: OK"
