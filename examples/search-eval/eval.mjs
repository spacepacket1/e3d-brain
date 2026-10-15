#!/usr/bin/env node
// Score search quality against questions you wrote. Search quality is the product, so re-run this after every change.
//   EBRAIN_CONFIG=<config.json> node examples/search-eval/eval.mjs questions.json
// questions.json: [{ "q": "what is e3d-agent", "expect": ["kb/e3d-agent"] }, ...]
// A hit counts when a result's path contains any `expect` string. Reports hit@1, hit@3, hit@5 and mean reciprocal rank.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBrain } from '../agent-memory/agent-brain.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = process.env.EBRAIN_MAIN || path.join(here, '..', '..', 'dist', 'src', 'cli', 'main.js');
const [file] = process.argv.slice(2);
const config = process.env.EBRAIN_CONFIG;
if (!file || !config) {
  console.error('usage: EBRAIN_CONFIG=<config.json> node examples/search-eval/eval.mjs <questions.json>');
  process.exit(2);
}
const questions = JSON.parse(fs.readFileSync(file, 'utf8'));
const brain = await AgentBrain.open({ main, config });
if (brain.disabled) {
  console.error(`brain unavailable: ${brain.reason}`);
  process.exit(1);
}
let h1 = 0, h3 = 0, h5 = 0, rr = 0;
for (const { q, expect } of questions) {
  const r = await brain.recall(q, { limit: 5, maxChars: 8000 });
  const rank = r.hits.findIndex((h) => expect.some((e) => String(h.path).includes(e))) + 1;
  if (rank === 1) h1++;
  if (rank >= 1 && rank <= 3) h3++;
  if (rank >= 1) { h5++; rr += 1 / rank; }
  console.log(`${rank ? `#${rank}` : 'MISS'}\t${q}${rank ? '' : `   (top: ${r.hits[0]?.path ?? 'nothing'})`}`);
}
const n = questions.length;
console.log(`\n${n} questions: hit@1 ${h1}/${n}  hit@3 ${h3}/${n}  hit@5 ${h5}/${n}  MRR ${(rr / n).toFixed(2)}`);
await brain.close();
