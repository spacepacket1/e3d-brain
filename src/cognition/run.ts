// The cognition run framework (cognition Phase 2, G9, G10, G11, C1-C8).
// `ebrain cognition run <job>` is the only way a job starts (C2): no MCP
// tool reaches this module. A run:
//
//   - refuses to start while another run of the same job holds the
//     `cognition-<job>` lock (`src/lock.ts`);
//   - asks the job for drafts in its documented deterministic priority order
//     (never by model score);
//   - skips drafts whose proposal key (C5) is already in `_inbox/` (open or
//     `_applied/`), and keys in `rejections.json` unless `--reconsider`;
//   - stops cleanly at `--max-proposals` (C6), at `inbox.maxPendingProposals`
//     open proposals (flood control), or when the LLM budget runs out;
//   - scrubs every text it writes (C7), propagates taint from untrusted
//     targets and cited notes (C8), validates each proposal by parsing what
//     it rendered, records its id and immutable digest in the run record,
//     and only then creates the file in `_inbox/` (C1, any mode: C11);
//   - writes `<stateDir>/runs/<run-id>.json` with ids, revs, hashes, counts,
//     and settings only.

import { createHash } from 'node:crypto';
import { parseCitation } from '../cite/citation.js';
import type { Config } from '../config.js';
import { cleanTitle, isoSeconds, toSlug } from '../inbox/note.js';
import { writeInboxFile } from '../inbox/writer.js';
import { refreshIndex, type IndexHandle } from '../index/indexer.js';
import { allNoteRows, type NoteRow } from '../index/query.js';
import { LlmSession } from '../llm/session.js';
import type { ExtractionProvider } from '../llm/provider.js';
import { acquireLock, LockError } from '../lock.js';
import { ulid } from '../mcp/ulid.js';
import {
  immutableDigest, parseProposal, ProposalError, proposalKey, renderProposalNote, type ChangeOp, type ProposalTarget, type ProposalType,
} from '../review/proposal.js';
import { readFileWithStatSafe, resolveInVault, type SafePath } from '../safe-path.js';
import { scrub, scrubVersion } from '../scrub/index.js';
import { splitFrontmatter } from '../vault/parse.js';
import { loadPrompt } from './prompts.js';
import { rejectedKeys } from './rejections.js';
import { newRunId, writeRunRecord, type RunRecord } from './runs.js';

export class CognitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CognitionError';
  }
}

/** One proposal a job wants to make, before keys, scrubbing, and rendering. */
export interface Draft {
  proposal_type: ProposalType;
  title: string;
  rationale: string;
  targets: ProposalTarget[];
  evidence: string[];
  ops: ChangeOp[];
  untrusted_origin?: boolean;
  taint_sources?: string[];
}

export interface JobContext {
  config: Config;
  index: IndexHandle;
  now: Date;
  /** `--since` as epoch ms. */
  sinceMs?: number;
  /** Present when the job may use a model and a provider is configured. */
  llm?: LlmSession;
  /** Scrub text under the principal's rules; undefined when strict rules reject it. */
  scrubText(text: string): string | undefined;
  /** Record an input note (id and rev only). */
  input(id: string, rev: string): void;
  count(name: string, n?: number): void;
}

export interface JobOutput {
  /** In the job's deterministic priority order. */
  drafts: Draft[];
  /** Why the job stopped early (for example an LLM budget cap). */
  stop?: string;
}

export interface CognitionJob {
  name: string;
  version: number;
  /** One line for `ebrain cognition run --help`. */
  description: string;
  /** Whether the job can use a model: `never`, `optional` (works without one), or `required`. */
  llm: 'never' | 'optional' | 'required';
  generate(ctx: JobContext): Promise<JobOutput>;
}

export interface RunOptions {
  config: Config;
  stateDir: SafePath;
  index: IndexHandle;
  job: CognitionJob;
  provider?: ExtractionProvider;
  sinceMs?: number;
  since?: string;
  maxProposals?: number;
  dryRun?: boolean;
  reconsider?: boolean;
  now?: () => Date;
}

export interface RunResult {
  record: RunRecord;
  created: { id: string; path: string }[];
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const KEY_LINE_RE = /^proposal_key:\s*['"]?(pk_[0-9a-f]{32})['"]?\s*$/m;

/** Proposal keys in `_inbox/` (open and `_applied/`, not `_rejected/`), and the count of open `proposed` ones. */
function inboxState(config: Config, rows: readonly NoteRow[]): { keys: Set<string>; pending: number } {
  const keys = new Set<string>();
  let pending = 0;
  for (const r of rows) {
    if (r.folder_class !== 'inbox' || r.kind !== 'proposal' || r.path.startsWith('_inbox/_rejected/')) continue;
    if (r.folder_hidden === 0 && r.status === 'proposed') pending++;
    try {
      const { yaml } = splitFrontmatter(readFileWithStatSafe(resolveInVault(config.vaultPath, r.path), { maxBytes: 4 * 1024 * 1024 }).data.toString('utf8'));
      const m = yaml === null ? null : KEY_LINE_RE.exec(yaml);
      if (m !== null) keys.add(m[1]!);
    } catch {
      // unreadable: not a proposal of ours
    }
  }
  return { keys, pending };
}

/** A human-readable summary of the ops (the file's "Preview" section; `review show` renders the live diff). */
function previewOf(d: Draft): string {
  const where = (id: string) => d.targets.find((t) => t.id === id)?.path_at_proposal ?? id;
  return d.ops.map((op) => {
    switch (op.op) {
      case 'set_frontmatter':
        return `- set \`${op.key}: ${Array.isArray(op.value) ? `[${op.value.join(', ')}]` : op.value}\` on \`${where(op.target)}\``;
      case 'create_note':
        return `- create \`${op.path}\` (${op.content.length} characters)`;
      case 'move_note':
        return `- move \`${where(op.target)}\` to \`${op.to}\``;
      case 'append_section':
        return `- append a section (${op.text.length} characters) to \`${where(op.target)}\``;
    }
  }).join('\n');
}

/** Run one job (see the module comment). Throws CognitionError when it cannot start. */
export async function runJob(opts: RunOptions): Promise<RunResult> {
  const { config, job, stateDir } = opts;
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(stateDir, `cognition-${job.name}`, { waitMs: 0 });
  } catch (err) {
    if (err instanceof LockError && err.code === 'timeout') throw new CognitionError(`another run of job ${job.name} is in progress (lock cognition-${job.name}); refusing to start`);
    throw err;
  }
  try {
    let llm: LlmSession | undefined;
    if (job.llm === 'required' && opts.provider === undefined) throw new CognitionError(`job ${job.name} needs an LLM provider (llm.provider is "none")`);
    if (job.llm !== 'never' && opts.provider !== undefined) {
      llm = new LlmSession(opts.provider, loadPrompt(job.name), {
        maxCalls: config.llm.maxCallsPerRun, maxInputChars: config.llm.maxInputCharsPerRun, maxOutputTokens: config.llm.maxOutputTokens,
      });
    }
    const maxProposals = opts.maxProposals ?? config.cognition.maxProposalsPerRun;
    const counts: Record<string, number> = {};
    const count = (name: string, n = 1): void => {
      counts[name] = (counts[name] ?? 0) + n;
    };
    const inputs = new Map<string, string>();
    const record: RunRecord = {
      run_id: newRunId(now),
      job: job.name,
      job_version: job.version,
      prompt: llm === undefined ? null : { id: llm.promptId, sha256: llm.promptSha256 },
      provider: opts.provider === undefined || llm === undefined ? null : { provider: opts.provider.provider, model: opts.provider.model },
      started: isoSeconds(now),
      finished: null,
      status: 'running',
      options: { since: opts.since ?? null, max_proposals: maxProposals, dry_run: opts.dryRun === true, reconsider: opts.reconsider === true },
      budget: {
        max_llm_calls: config.llm.maxCallsPerRun, max_input_chars: config.llm.maxInputCharsPerRun, max_proposals: maxProposals,
        max_pending: config.inbox.maxPendingProposals,
      },
      inputs: { count: 0, sha256: sha256(''), notes: [] },
      counts,
      stop_reason: null,
      llm_requests: [],
      proposals: [],
    };
    const scrubText = (text: string): string | undefined => {
      const r = scrub(text, { principal: { type: config.principal.type }, extraPatterns: config.scrub.extraPatterns });
      if (!r.ok) return undefined;
      if (r.findings.length > 0) count('scrub_redactions', r.findings.reduce((a, f) => a + f.count, 0));
      return r.text;
    };
    const flush = (): void => {
      const notes = [...inputs].map(([id, rev]) => ({ id, rev })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      record.inputs = { count: notes.length, sha256: sha256(notes.map((n) => `${n.id}@${n.rev}`).join('\n')), notes };
      if (llm !== undefined) {
        record.llm_requests = [...llm.log];
        counts['llm_calls'] = llm.budget.calls;
        counts['llm_input_chars'] = llm.budget.inputChars;
        counts['llm_invalid_items'] = llm.invalidItems;
        counts['llm_invalid_responses'] = llm.invalidResponses;
      }
      writeRunRecord(stateDir, record);
    };
    const created: { id: string; path: string }[] = [];
    try {
      flush();
      refreshIndex(opts.index);
      const ctx: JobContext = {
        config, index: opts.index, now, scrubText,
        input: (id, rev) => void inputs.set(id, rev),
        count,
        ...(opts.sinceMs === undefined ? {} : { sinceMs: opts.sinceMs }),
        ...(llm === undefined ? {} : { llm }),
      };
      const out = await job.generate(ctx);
      count('drafts', out.drafts.length);

      refreshIndex(opts.index);
      const rows = allNoteRows(opts.index.db);
      const byId = new Map(rows.filter((r) => r.provisional === 0).map((r) => [r.id, r]));
      const state = inboxState(config, rows);
      const rejected = rejectedKeys(stateDir);
      let stop: string | undefined;
      for (const d of out.drafts) {
        const key = proposalKey(job.name, d.proposal_type, d.evidence);
        if (state.keys.has(key)) {
          count('duplicates');
          continue;
        }
        if (rejected.has(key)) {
          if (opts.reconsider !== true) {
            count('rejected_skipped');
            continue;
          }
          count('reconsidered');
        }
        if (created.length + (counts['would_create'] ?? 0) >= maxProposals) {
          stop = 'max-proposals';
          break;
        }
        if (state.pending >= config.inbox.maxPendingProposals) {
          stop = 'max-pending';
          break;
        }
        // C8: taint from any untrusted target or cited note.
        const taint = new Set(d.taint_sources ?? []);
        for (const t of d.targets) if (byId.get(t.id)?.untrusted_origin === 1) taint.add(`note:${t.id}@${t.rev}`);
        for (const c of d.evidence) {
          const p = parseCitation(c);
          if (p.ok && p.citation.kind === 'note' && byId.get(p.citation.id)?.untrusted_origin === 1) taint.add(c);
        }
        // C7: everything written is scrubbed.
        const title = scrubText(d.title);
        const rationale = scrubText(d.rationale);
        let opsOk = title !== undefined && rationale !== undefined;
        const ops: ChangeOp[] = d.ops.map((op) => {
          if (op.op === 'create_note' || op.op === 'append_section') {
            const field = op.op === 'create_note' ? op.content : op.text;
            const s = scrubText(field);
            if (s === undefined) opsOk = false;
            return op.op === 'create_note' ? { ...op, content: s ?? '' } : { ...op, text: s ?? '' };
          }
          return op;
        });
        if (!opsOk) {
          count('scrub_rejected');
          continue;
        }
        const id = ulid(now.getTime());
        const draft: Draft = { ...d, ops };
        const text = renderProposalNote({
          meta: {
            id, title: cleanTitle(title!) || `${job.name} proposal`, proposal_type: d.proposal_type, job: job.name, job_version: job.version,
            created: isoSeconds(now), author: `ebrain-${job.name}`, origin: 'cli', targets: d.targets, evidence: d.evidence,
            untrusted_origin: d.untrusted_origin === true || taint.size > 0, taint_sources: [...taint].sort(), proposal_key: key,
          },
          ops,
          rationale: rationale!,
          preview: previewOf(draft),
          scrubVersion,
        });
        let digest: string;
        try {
          const parsed = parseProposal(text);
          digest = immutableDigest(parsed.meta, parsed.ops);
        } catch (err) {
          if (!(err instanceof ProposalError)) throw err;
          count('invalid_drafts');
          continue;
        }
        state.keys.add(key);
        if (opts.dryRun === true) {
          count('would_create');
          continue;
        }
        // Recorded before the file exists, so every proposal on disk is authenticated by a record.
        record.proposals.push({ id, proposal_key: key, digest });
        flush();
        const written = writeInboxFile(config.vaultPath, toSlug(cleanTitle(title!) || job.name), now, text);
        created.push({ id, path: written.relPath });
        state.pending++;
      }
      count('created', created.length);
      record.stop_reason = stop ?? out.stop ?? 'complete';
      record.status = 'finished';
      record.finished = isoSeconds(clock());
      flush();
      return { record, created };
    } catch (err) {
      record.status = 'failed';
      record.stop_reason = 'error';
      record.finished = isoSeconds(clock());
      flush();
      throw err;
    }
  } finally {
    lock.release();
  }
}
