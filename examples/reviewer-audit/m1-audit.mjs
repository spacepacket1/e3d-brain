#!/usr/bin/env node
// M1 audit for the "E3D Adversarial Spec Reviewer" RFC: how much usable evidence do our debate logs actually hold?
//
// READ-ONLY. It scans repo checkouts for debate transcripts, negotiation logs and e3d-pilot ledgers, de-duplicates
// clones, and reports how many reviewer objections can be traced to a spec revision, an implementation and an outcome.
// It writes only into --out. It never prints or stores raw transcript text: samples carry at most 280 characters of
// an objection's stated reason, with secrets and email addresses replaced.
//
//   node examples/reviewer-audit/m1-audit.mjs --root ~ --out ./m1-audit-out
//   options: --prefix e3d (directories to scan, name starts with it)   --sample 5   --seed 1
//            --permissions permissions.json   {"claude":"allowed","codex":"restricted"}   (default: every source "unknown")
//
// Linkage levels for an objection (a reviewer turn with status "revise"):
//   L0 recorded  L1 spec text differs after that round (heuristic: same round, not proof of cause)
//   L2 linked to an idea in a ledger   L3 that idea has an implementation or merge   L4 an outcome with verification.
// Missing edges are UNKNOWN, not evidence of no effect (RFC section 5.1).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const STOP_BELOW = 30; // the committee's kill criterion: fewer verifiable revision links than this -> capture prospectively

const sha = (s) => createHash('sha256').update(s).digest('hex');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// ---- sensitive-content counting and redaction (counts only; values are never kept) ---------------------------------
const SENSITIVE = {
  'private-key-block': /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  'api-key': /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g,
  'bearer-token': /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  'hex64-key': /(?:priv|secret|seed|mnemonic|key)[^\n]{0,40}(?:0x)?[0-9a-fA-F]{64}\b/gi,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
};
function countSensitive(text, into) {
  for (const [name, re] of Object.entries(SENSITIVE)) into[name] = (into[name] ?? 0) + (text.match(re)?.length ?? 0);
}
function redact(text) {
  let out = text;
  for (const [name, re] of Object.entries(SENSITIVE)) out = out.replace(re, name === 'email' ? '[EMAIL]' : `[REDACTED:${name}]`);
  return out;
}

// ---- discovery ---------------------------------------------------------------------------------------------------
function discoverRepos(root, prefix) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name === prefix || d.name.startsWith(`${prefix}-`)))
    .map((d) => path.join(root, d.name))
    .filter((r) => isDir(path.join(r, 'docs', 'debates')) || isDir(path.join(r, '.e3d-pilot')));
}

function family(repo) {
  try {
    const url = execFileSync('git', ['-C', repo, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (url) return url.replace(/^(?:git@[^:]+:|https?:\/\/[^/]+\/)/, '').replace(/\.git$/, '').toLowerCase();
  } catch { /* no remote */ }
  return path.basename(repo).toLowerCase();
}

// ---- parsers -----------------------------------------------------------------------------------------------------
function parseDebate(file, text) {
  const heads = [...text.matchAll(/^## Round (\d+) -- (\S+)\s*$/gm)];
  const rounds = heads.map((m, i) => {
    const body = text.slice(m.index + m[0].length, i + 1 < heads.length ? heads[i + 1].index : text.search(/^## Synthesis/m) >= 0 ? text.search(/^## Synthesis/m) : text.length);
    const status = [...body.matchAll(/^status:\s*(\w+)/gm)].pop()?.[1] ?? null;
    const position = body.match(/^POSITION:\s*(.+)$/m)?.[1] ?? null;
    return { n: Number(m[1]), provider: m[2], status, position };
  });
  const syn = text.slice(Math.max(0, text.search(/^## Synthesis/m)));
  return { rounds, namedDissent: /^DISSENT:\s*(?!none\b)\S/m.test(syn), consensus: syn.match(/^CONSENSUS:\s*(\w+)/m)?.[1] ?? null };
}

function parseNegotiation(text, runDir) {
  // Line-anchored on purpose: the spec text inside a log has its own "##"/"###" headings, so a heading-based split
  // would cut drafts in the wrong place. Markers used: "## Round N", "### Draft Before Round", "### Reviewer K: provider".
  const lines = text.split('\n');
  const roundAt = [];
  lines.forEach((l, i) => { const m = /^## Round (\d+)\s*$/.exec(l); if (m) roundAt.push({ n: Number(m[1]), i }); });
  const rounds = roundAt.map((r, k) => {
    const end = k + 1 < roundAt.length ? roundAt[k + 1].i : lines.length;
    const seg = lines.slice(r.i + 1, end);
    const draftAt = seg.findIndex((l) => /^### Draft Before Round\s*$/.test(l));
    const reviewerAt = [];
    seg.forEach((l, i) => { const m = /^### Reviewer \d+: (\S+)\s*$/.exec(l); if (m) reviewerAt.push({ provider: m[1], i }); });
    let draftHash = null;
    if (draftAt >= 0 && reviewerAt.length > 0) {
      const draft = seg.slice(draftAt + 1, reviewerAt[0].i).join('\n').replace(/^\s*```[a-z]*\n/, '').replace(/\n```\s*$/, '').trim();
      draftHash = draft ? sha(draft) : null;
    }
    const reviewers = reviewerAt.map((rv, j) => {
      const block = seg.slice(rv.i + 1, j + 1 < reviewerAt.length ? reviewerAt[j + 1].i : seg.length).join('\n');
      const head = block.split('\n').slice(0, 10).join('\n');
      return {
        provider: rv.provider,
        status: /^status:\s*(\w+)/mi.exec(head)?.[1]?.toLowerCase() ?? /^status:\s*(\w+)/mi.exec(block)?.[1]?.toLowerCase() ?? null,
        reason: /^reason:\s*(.+)$/mi.exec(head)?.[1] ?? /^reason:\s*(.+)$/mi.exec(block)?.[1] ?? '',
      };
    });
    return { n: r.n, draftHash, reviewers };
  });
  const final = read(path.join(runDir, 'spec-final.md')) ?? read(path.join(runDir, 'spec-draft.md'));
  return { rounds, finalHash: final ? sha(final.trim()) : null };
}

function loadLedger(repo) {
  const text = read(path.join(repo, '.e3d-pilot', 'events.jsonl'));
  const ideas = new Map();
  const runToIdea = new Map();
  const transcriptToIdea = new Map();
  let events = 0;
  let t0 = null;
  let t1 = null;
  for (const line of (text ?? '').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    events += 1;
    if (e.timestamp) { t0 = !t0 || e.timestamp < t0 ? e.timestamp : t0; t1 = !t1 || e.timestamp > t1 ? e.timestamp : t1; }
    const id = e.idea_id;
    if (!id) continue;
    const rec = ideas.get(id) ?? { events: new Set(), verifiedOutcome: false };
    rec.events.add(e.event);
    if (e.event === 'outcome_recorded' && /"verification"|exit_status/.test(JSON.stringify(e))) rec.verifiedOutcome = true;
    ideas.set(id, rec);
    if (e.source_run_id) runToIdea.set(e.source_run_id, id);
    const run = typeof e.text === 'string' ? e.text.match(/\brun_id=(\S+)/)?.[1] : null;
    if (run) runToIdea.set(run, id);
    const ref = e.evidence_ref ?? (typeof e.text === 'string' ? e.text.match(/docs\/debates\/[^\s/]+\/transcript\.md/)?.[0] : null);
    if (typeof ref === 'string') transcriptToIdea.set(ref, id);
  }
  return { ideas, runToIdea, transcriptToIdea, events, t0, t1 };
}

// ---- audit -------------------------------------------------------------------------------------------------------
export function audit({ root, prefix = 'e3d', permissions = {}, sample = 5, seed = 1 }) {
  const repos = discoverRepos(root, prefix);
  const seenFiles = new Map(); // content hash -> first path
  const sensitive = {};
  const providerTurns = {};
  const families = new Set();
  const objections = [];
  const stats = { repos: repos.length, debateTranscripts: 0, negotiationLogs: 0, duplicateFilesSkipped: 0, debatesWithNamedDissent: 0, ledgerEvents: 0, ideas: 0 };
  let tMin = null;
  let tMax = null;

  for (const repo of repos) {
    const fam = family(repo);
    const ledger = loadLedger(repo);
    stats.ledgerEvents += ledger.events;
    stats.ideas += ledger.ideas.size;
    for (const t of [ledger.t0, ledger.t1]) if (t) { tMin = !tMin || t < tMin ? t : tMin; tMax = !tMax || t > tMax ? t : tMax; }
    const levels = (ideaId) => {
      const rec = ideaId ? ledger.ideas.get(ideaId) : null;
      return {
        linkedIdea: Boolean(rec),
        implemented: Boolean(rec && (rec.events.has('implementation_completed') || rec.events.has('merge_completed'))),
        verifiedOutcome: Boolean(rec?.verifiedOutcome),
      };
    };

    const debDir = path.join(repo, 'docs', 'debates');
    for (const d of isDir(debDir) ? fs.readdirSync(debDir) : []) {
      const file = path.join(debDir, d, 'transcript.md');
      const text = read(file);
      if (text === null) continue;
      const h = sha(text);
      if (seenFiles.has(h)) { stats.duplicateFilesSkipped += 1; continue; }
      seenFiles.set(h, file);
      stats.debateTranscripts += 1;
      countSensitive(text, sensitive);
      families.add(fam);
      const parsed = parseDebate(file, text);
      if (parsed.namedDissent) stats.debatesWithNamedDissent += 1;
      const ideaId = ledger.transcriptToIdea.get(`docs/debates/${d}/transcript.md`);
      for (const r of parsed.rounds) {
        providerTurns[r.provider] = (providerTurns[r.provider] ?? 0) + 1;
        if (r.status !== 'revise') continue;
        objections.push({ source: 'debate', repo: path.basename(repo), family: fam, ref: `docs/debates/${d}`, round: r.n, provider: r.provider,
          reason: r.position ?? '', specBefore: null, specAfter: null, specChanged: null, ideaId, ...levels(ideaId) });
      }
    }

    const runsDir = path.join(repo, '.e3d-pilot', 'runs');
    for (const run of isDir(runsDir) ? fs.readdirSync(runsDir) : []) {
      const text = read(path.join(runsDir, run, 'negotiation-log.md'));
      if (text === null) continue;
      const h = sha(text);
      if (seenFiles.has(h)) { stats.duplicateFilesSkipped += 1; continue; }
      seenFiles.set(h, `${repo}/${run}`);
      stats.negotiationLogs += 1;
      countSensitive(text, sensitive);
      families.add(fam);
      const neg = parseNegotiation(text, path.join(runsDir, run));
      const ideaId = ledger.runToIdea.get(run);
      neg.rounds.forEach((round, i) => {
        const after = i + 1 < neg.rounds.length ? neg.rounds[i + 1].draftHash : neg.finalHash;
        for (const rv of round.reviewers) {
          providerTurns[rv.provider] = (providerTurns[rv.provider] ?? 0) + 1;
          if (rv.status !== 'revise') continue;
          objections.push({ source: 'negotiate', repo: path.basename(repo), family: fam, ref: `.e3d-pilot/runs/${run}`, round: round.n, provider: rv.provider,
            reason: rv.reason, specBefore: round.draftHash, specAfter: after,
            specChanged: round.draftHash && after ? round.draftHash !== after : null, ideaId, ...levels(ideaId) });
        }
      });
    }
  }

  const n = objections.length;
  const count = (f) => objections.filter(f).length;
  const linkage = {
    objectionsRecorded: n,
    withSpecBeforeAfter: count((o) => o.specBefore && o.specAfter),
    specChangedSameRound: count((o) => o.specChanged === true),
    linkedToIdea: count((o) => o.linkedIdea),
    ideaImplementedOrMerged: count((o) => o.implemented),
    outcomeWithVerification: count((o) => o.verifiedOutcome),
  };
  const missing = {
    'debate objections with no spec versions (debates argue questions, not spec drafts)': count((o) => o.source === 'debate'),
    'negotiate objections with no idea link': count((o) => o.source === 'negotiate' && !o.linkedIdea),
    'objections on ideas never implemented': count((o) => o.linkedIdea && !o.implemented),
    'implemented ideas with no verified outcome': count((o) => o.implemented && !o.verifiedOutcome),
    'objections where spec text did not change after the round': count((o) => o.specChanged === false),
  };
  // One revised round can carry several reviewers' objections (each ships a replacement spec), so count distinct rounds.
  const revisedRounds = new Set(objections.filter((o) => o.specChanged === true).map((o) => `${o.family}|${o.ref}#${o.round}`)).size;
  linkage.distinctRoundsWithSpecChange = revisedRounds;
  const verifiable = revisedRounds;
  const providers = Object.fromEntries(Object.entries(providerTurns).map(([p, turns]) => [p, { turns, trainingPermission: permissions[p] ?? 'unknown' }]));

  // deterministic sample of redacted candidate records (RFC 5.2 shape; unknown stays unknown)
  let state = seed >>> 0 || 1;
  const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const pool = [...objections.filter((o) => o.specChanged === true), ...objections.filter((o) => o.specChanged !== true)].slice(0, Math.max(sample * 4, sample));
  const picked = pool.map((o) => [rnd(), o]).sort((a, b) => a[0] - b[0]).slice(0, sample).map(([, o]) => o);
  const samples = picked.map((o, i) => ({
    case_id: `sample-${i + 1}`, task_id: o.ideaId ?? null, repo_ref: o.family,
    spec_before_ref: o.specBefore ? `sha256:${o.specBefore}` : null, spec_after_ref: o.specAfter ? `sha256:${o.specAfter}` : null,
    objection_ref: `${o.ref}#round-${o.round}`, model_identity: o.provider, defect_category: 'unknown',
    claim: redact(o.reason).slice(0, 280), failure_scenario: null, evidence_refs: [], proposed_spec_change: null,
    decision: o.specChanged === true ? 'unresolved' : 'unknown', validity: 'unknown', severity: 'unknown', uniqueness: 'unknown',
    outcome_evidence_refs: [], adjudicator: null, training_permission: permissions[o.provider] ?? 'unknown', confidence: 0, schema_version: '1.0',
  }));

  return {
    generatedAt: new Date().toISOString(),
    stats, linkage, missing, providers, sensitive,
    lineage: { distinctFamilies: families.size, ledgerTimeSpan: [tMin, tMax] },
    killCriterion: { verifiableRevisionLinks: verifiable, unit: 'distinct negotiation rounds whose spec text changed', threshold: STOP_BELOW,
      verdict: verifiable < STOP_BELOW ? 'STOP: capture objections and outcomes prospectively before any training' : 'enough revision links to continue to M2' },
    samples,
  };
}

function report(r) {
  const l = r.linkage;
  return [
    '# M1 audit: evidence inventory for the adversarial reviewer RFC', '',
    `Generated ${r.generatedAt}. Read-only scan; counts are after removing byte-identical clones.`, '',
    '## Inventory', '',
    `- repos scanned: ${r.stats.repos}; distinct lineage families (by git remote): ${r.lineage.distinctFamilies}`,
    `- debate transcripts: ${r.stats.debateTranscripts}; negotiation logs: ${r.stats.negotiationLogs}; clones skipped: ${r.stats.duplicateFilesSkipped}`,
    `- debates that kept a named dissent: ${r.stats.debatesWithNamedDissent}`,
    `- ledger events: ${r.stats.ledgerEvents}; ideas: ${r.stats.ideas}; ledger time span: ${r.lineage.ledgerTimeSpan.join(' to ') || 'unknown'}`, '',
    '## Linkage coverage (objection = a reviewer turn with status "revise")', '',
    `- objections recorded: ${l.objectionsRecorded}`,
    `- with spec text before and after the round: ${l.withSpecBeforeAfter}`,
    `- objections followed by a spec change in the same round (heuristic): ${l.specChangedSameRound}`,
    `- distinct rounds with a spec change (the unit the kill criterion counts): ${l.distinctRoundsWithSpecChange}`,
    '- CAUTION: in a negotiation a "revise" verdict ships a replacement spec, so a spec change is expected by construction. It shows a revision happened, not that the objection was correct or caused the change. Validity needs adjudication (M2).',
    `- linked to an idea in a ledger: ${l.linkedToIdea}`,
    `- idea has an implementation or merge: ${l.ideaImplementedOrMerged}`,
    `- idea has an outcome with verification: ${l.outcomeWithVerification}`, '',
    '## Kill criterion', '',
    `${r.killCriterion.verifiableRevisionLinks} ${r.killCriterion.unit} (threshold ${r.killCriterion.threshold}). Revision links only; validity is unlabelled.`,
    `**${r.killCriterion.verdict}**`, '',
    '## Rights and permissions', '',
    ...Object.entries(r.providers).map(([p, v]) => `- ${p}: ${v.turns} turns, training permission: ${v.trainingPermission}`),
    '', 'Unknown rights are excluded by default (RFC 5.3). Provider terms and confidentiality have not been reviewed; supply --permissions once they have.', '',
    '## Sensitive-content counts in the scanned text (values are never stored)', '',
    ...Object.entries(r.sensitive).map(([k, v]) => `- ${k}: ${v}`), '',
    '## Missing links (unknown, not evidence of no effect)', '',
    ...Object.entries(r.missing).map(([k, v]) => `- ${k}: ${v}`), '',
    `Sample redacted case records: ${r.samples.length} (see sample-cases.json).`, '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
  const root = path.resolve((opt('root', os.homedir())).replace(/^~(?=$|\/)/, os.homedir()));
  const out = path.resolve(opt('out', 'm1-audit-out'));
  const permFile = opt('permissions', null);
  const result = audit({
    root, prefix: opt('prefix', 'e3d'), sample: Number(opt('sample', 5)), seed: Number(opt('seed', 1)),
    permissions: permFile ? JSON.parse(fs.readFileSync(permFile, 'utf8')) : {},
  });
  fs.mkdirSync(out, { recursive: true });
  const { samples, ...inventory } = result;
  fs.writeFileSync(path.join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'sample-cases.json'), `${JSON.stringify(samples, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'missing-links.json'), `${JSON.stringify(result.missing, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'report.md'), report(result));
  console.log(report(result));
  console.log(`written to ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
