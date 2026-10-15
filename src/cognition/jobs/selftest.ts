// `selftest` (cognition Phase 2): a trivial built-in job that exercises the
// whole pipeline (run record, proposal schema, rejection memory, flood
// control, review accept/undo) without judging anything.
//
// Inputs: curated notes tagged `ebrain-selftest` that have an assigned id
// (C3: provisional ids are skipped and counted), are not `pinned`, and are
// not already `stale`, `superseded`, or `archived`; with `--since`, notes
// whose `created` is earlier are left out. For each, one `demote` proposal
// that sets `status: stale`, citing the note at its current revision.
// Priority: vault path, bytewise.
//
// With an LLM provider configured, the model is asked for a one-sentence
// description of each note (prompt `selftest.v1`); a valid reply is quoted
// in the rationale as unverified, an invalid one is dropped and counted, and
// a budget stop ends the run cleanly with the proposals gathered so far.

import { formatCitation } from '../../cite/citation.js';
import { allNoteRows, firstChunkText, tagsByPath } from '../../index/query.js';
import type { ItemSchema } from '../../llm/schema.js';
import { fenceFor, truncateText } from '../../mcp/fence.js';
import { compareBytes } from '../../vault/names.js';
import type { CognitionJob, Draft, JobContext, JobOutput } from '../run.js';

export const SELFTEST_TAG = 'ebrain-selftest';
const SKIP_STATUSES = new Set(['stale', 'superseded', 'archived', 'rejected', 'proposed', 'journal']);
const NOTE_CHARS = 2000;
const REASON_SCHEMA: ItemSchema = { reason: { type: 'string', min: 1, max: 200 } };

async function generate(ctx: JobContext): Promise<JobOutput> {
  const { db } = ctx.index;
  const tags = tagsByPath(db);
  const pinned = db.prepare('SELECT pinned FROM notes WHERE path = ?');
  const rows = allNoteRows(db)
    .filter((r) => r.folder_class === 'curated' && r.folder_hidden === 0 && (tags.get(r.path) ?? []).includes(SELFTEST_TAG))
    .sort((a, b) => compareBytes(a.path, b.path));
  const drafts: Draft[] = [];
  for (const r of rows) {
    if (r.provisional === 1) {
      ctx.count('skipped_provisional');
      continue;
    }
    if ((pinned.get(r.path) as { pinned: number | null } | undefined)?.pinned === 1) {
      ctx.count('skipped_pinned');
      continue;
    }
    if (r.status !== null && SKIP_STATUSES.has(r.status)) {
      ctx.count('skipped_status');
      continue;
    }
    if (ctx.sinceMs !== undefined && r.created !== null && Date.parse(r.created) < ctx.sinceMs) {
      ctx.count('skipped_since');
      continue;
    }
    ctx.input(r.id, r.rev);
    const lines = [
      `Self-test proposal for \`${r.path}\` (tagged #${SELFTEST_TAG}).`,
      '',
      'Accepting it sets `status: stale` on the note; `ebrain review undo` restores it byte for byte.',
    ];
    if (ctx.llm !== undefined) {
      const text = ctx.scrubText(truncateText(firstChunkText(db, r.path), NOTE_CHARS)) ?? '';
      const f = fenceFor(text);
      const res = await ctx.llm.ask<{ reason: string }>(`Note title: ${ctx.scrubText(r.title) ?? ''}\n\nNote text:\n${f}text\n${text}\n${f}`, 'items', REASON_SCHEMA, 1);
      if (res.stop !== undefined) return { drafts, stop: res.stop };
      if (res.items[0] !== undefined) lines.push('', `Model description (unverified): ${res.items[0].reason.replace(/\s+/g, ' ').trim()}`);
    }
    drafts.push({
      proposal_type: 'demote',
      title: `Self-test: demote ${r.title}`,
      rationale: lines.join('\n'),
      targets: [{ id: r.id, rev: r.rev, path_at_proposal: r.path }],
      evidence: [formatCitation({ kind: 'note', id: r.id, rev: r.rev })],
      ops: [{ op: 'set_frontmatter', target: r.id, key: 'status', value: 'stale' }],
    });
  }
  return { drafts };
}

export const SELFTEST_JOB: CognitionJob = {
  name: 'selftest',
  version: 1,
  description: `propose demoting every note tagged #${SELFTEST_TAG} (exercises the pipeline; optional LLM)`,
  llm: 'optional',
  generate,
};
