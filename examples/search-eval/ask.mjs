#!/usr/bin/env node
// Ask the brain a question from the terminal: runs the same `search` tool an MCP client would call.
//   EBRAIN_CONFIG=~/.e3d-brain/config.json node examples/search-eval/ask.mjs "what did we decide about X" [--limit 5]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBrain } from '../agent-memory/agent-brain.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = process.env.EBRAIN_MAIN || path.join(here, '..', '..', 'dist', 'src', 'cli', 'main.js');
const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args.splice(li, 2)[1]) || 5 : 5;
const query = args.join(' ').trim();
const config = process.env.EBRAIN_CONFIG;
if (!query || !config) {
  console.error('usage: EBRAIN_CONFIG=<config.json> node examples/search-eval/ask.mjs "<question>" [--limit N]');
  process.exit(2);
}
const brain = await AgentBrain.open({ main, config });
if (brain.disabled) {
  console.error(`brain unavailable: ${brain.reason}`);
  process.exit(1);
}
const r = await brain.recall(query, { limit, maxChars: 1000 * limit + 1000 });
if (r.hits.length === 0) console.log(`no results${r.omitted ? ` (${r.omitted} matches did not fit the size budget)` : ''}`);
r.hits.forEach((h, i) => {
  console.log(`${i + 1}. ${h.title ?? '(untitled)'}  [${h.path}]`);
  console.log(`   ${String(h.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)}`);
});
if (r.matchMode === 'any_term') console.log('(matched on any word: the query had no note containing all of its words)');
await brain.close();
