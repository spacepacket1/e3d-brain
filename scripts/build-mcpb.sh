#!/usr/bin/env bash
# Build dist-mcpb/e3d-brain.mcpb for Claude Desktop from the package in this checkout.
# The bundle carries node_modules, including the native SQLite build, so it is
# specific to the platform and CPU it is built on.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
npm run build
out="$root/dist-mcpb"
stage="$out/stage"
rm -rf "$out"
mkdir -p "$stage"
tarball="$(npm pack --pack-destination "$out" --silent)"
cp mcpb/manifest.json mcpb/launch.mjs "$stage/"
(cd "$stage" && npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund "$out/$tarball" >/dev/null)
rm -f "$stage/package.json" "$stage/package-lock.json"
npx --yes @anthropic-ai/mcpb@2.1.2 pack "$stage" "$out/e3d-brain.mcpb"
echo "built $out/e3d-brain.mcpb ($(uname -s) $(uname -m))"
