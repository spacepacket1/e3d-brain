// examples/reviewer-audit/m1-audit.mjs: the M1 evidence audit must count what is really linked, de-duplicate clones,
// say honestly what it cannot know, and never leak a secret or email from the scanned logs into its outputs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realTmpDir, repoRoot } from './helpers.js';

const script = path.join(repoRoot(), 'examples', 'reviewer-audit', 'm1-audit.mjs');
const FAKE_KEY = 'sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE0123';
const FAKE_EMAIL = 'someone.private@example.com';

const draft = (v: number) => `# Spec v${v}\n\n## Overview\n\nBuild the thing.\n\n### Requirements\n\n- requirement ${v}\n`;
const negotiationLog = [
  '---', 'run_id: r1', '---', '', '# Negotiation Log', '',
  '## Round 1', '', '### Draft Before Round', '', '```text', draft(1), '```', '',
  '### Reviewer 1: claude', '', 'Status: approved', '', 'Reason: fine.', '',
  '### Reviewer 2: codex', '', 'Status: revise', '', `Reason: missing idempotency; contact ${FAKE_EMAIL}; key ${FAKE_KEY} appears in the draft.`, '',
  'Replacement Spec:', '', '```text', draft(2), '```', '',
  '## Round 2', '', '### Draft Before Round', '', '```text', draft(2), '```', '',
  '### Reviewer 1: claude', '', 'Status: approved', '', 'Reason: ok.', '',
  '### Reviewer 2: codex', '', 'Status: approved', '', 'Reason: ok.', '',
  '## Final Outcome', '',
].join('\n');
const debate = [
  '# Debate', '', '**Question:** q', '',
  '## Round 1 -- claude', '', 'answer one', '',
  '## Round 1 -- codex', '', 'answer two', '',
  '## Round 2 -- claude', '', 'POSITION: ship it', 'status: approved', '',
  '## Round 2 -- codex', '', 'POSITION: not yet, the data is too thin', 'status: revise', '',
  '## Synthesis (claude)', '', 'FINAL ANSWER: wait', 'CONSENSUS: majority', 'DISSENT: Claude would ship.', '',
].join('\n');
const events = [
  { event: 'idea_proposed', idea_id: 'idea-1', source_run_id: 'r1', timestamp: '2026-10-01T00:00:00Z' },
  { event: 'implementation_completed', idea_id: 'idea-1', timestamp: '2026-10-02T00:00:00Z' },
  { event: 'outcome_recorded', idea_id: 'idea-1', outcome: { status: 'succeeded', verification: [{ command: 'npm test', exit_status: 0 }] }, timestamp: '2026-10-03T00:00:00Z' },
  { event: 'note_appended', idea_id: 'idea-1', kind: 'decision', evidence_ref: 'docs/debates/d1/transcript.md', text: 'verdict', timestamp: '2026-10-04T00:00:00Z' },
].map((e) => JSON.stringify(e)).join('\n');

function makeRepo(root: string, name: string): void {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, 'docs', 'debates', 'd1'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.e3d-pilot', 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'debates', 'd1', 'transcript.md'), debate);
  fs.writeFileSync(path.join(repo, '.e3d-pilot', 'runs', 'r1', 'negotiation-log.md'), negotiationLog);
  fs.writeFileSync(path.join(repo, '.e3d-pilot', 'runs', 'r1', 'spec-final.md'), draft(2));
  fs.writeFileSync(path.join(repo, '.e3d-pilot', 'events.jsonl'), `${events}\n`);
}

describe('M1 reviewer audit', () => {
  const root = realTmpDir('ebrain-m1-');
  makeRepo(root, 'e3d-fixture');
  makeRepo(root, 'e3d-fixture-clone'); // byte-identical clone: must not be counted twice

  it('counts linkage honestly, de-duplicates clones, and applies the kill criterion', async () => {
    const mod = (await import(pathToFileURL(script).href)) as { audit(o: Record<string, unknown>): Record<string, any> };
    const r = mod.audit({ root, prefix: 'e3d' });
    assert.equal(r.stats.debateTranscripts, 1);
    assert.equal(r.stats.negotiationLogs, 1);
    assert.equal(r.stats.duplicateFilesSkipped, 2);
    assert.equal(r.stats.debatesWithNamedDissent, 1);
    assert.equal(r.linkage.objectionsRecorded, 2); // one negotiate revise + one debate revise
    assert.equal(r.linkage.specChangedSameRound, 1); // only the negotiate round has spec text before and after
    assert.equal(r.linkage.distinctRoundsWithSpecChange, 1);
    assert.equal(r.linkage.linkedToIdea, 2);
    assert.equal(r.linkage.ideaImplementedOrMerged, 2);
    assert.equal(r.linkage.outcomeWithVerification, 2);
    assert.ok(r.killCriterion.verdict.startsWith('STOP'), 'one revised round is below the threshold of 30');
    assert.equal(r.providers.codex.trainingPermission, 'unknown');
    assert.ok(r.sensitive['api-key'] >= 1 && r.sensitive.email >= 1);
  });

  it('writes its report and never leaks a planted secret or email into any output', () => {
    const out = path.join(root, 'out');
    const run = spawnSync('node', [script, '--root', root, '--prefix', 'e3d', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    for (const f of ['report.md', 'inventory.json', 'sample-cases.json', 'missing-links.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
    const everything = [run.stdout, ...fs.readdirSync(out).map((f) => fs.readFileSync(path.join(out, f), 'utf8'))].join('\n');
    assert.ok(!everything.includes(FAKE_KEY), 'secret leaked');
    assert.ok(!everything.includes(FAKE_EMAIL), 'email leaked');
    const samples = JSON.parse(fs.readFileSync(path.join(out, 'sample-cases.json'), 'utf8')) as Array<{ claim: string }>;
    assert.ok(samples.some((s) => s.claim.includes('[REDACTED:api-key]')));
  });
});
