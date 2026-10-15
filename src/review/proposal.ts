// Typed cognition proposals (cognition Phase 2, G6): the frontmatter schema,
// the closed change-block grammar, the immutable-field digest, and the
// proposal key (C5). Pure: no I/O.
//
// A proposal is a Markdown note in `_inbox/`:
//
//   ---
//   schema: 1
//   id: <ULID>
//   title: <text>
//   status: proposed            (stale once a target changed; accepted in _inbox/_applied/)
//   kind: proposal
//   proposal_type: merge | supersede | summary | archive | demote | lesson | gap
//   job: <job>
//   job_version: <n>
//   created: <ts>
//   author: ebrain-<job>
//   origin: cli
//   targets: [{id, rev, path_at_proposal}]
//   evidence: [<citation>, ...]
//   untrusted_origin: false
//   taint_sources: [<citation>, ...]
//   confidence: unrated
//   proposal_key: pk_<32 hex>
//   needs_review: unadjudicated  (optional: no model judged it; supersede without a provider)
//   scrubVersion: <n>
//   ---
//   # <title>
//   <rationale>
//   ## Change
//   ```ebrain-change
//   {"version": 1, "ops": [...]}
//   ```
//   ## Preview
//   <rendered at creation; `ebrain review show` renders the live diff>
//
// The change block is JSON in exactly one fenced block with the info string
// `ebrain-change`. Its ops form a closed grammar; each op names a target
// listed in `targets` (create_note names a new path instead):
//
//   {"op": "set_frontmatter", "target": <id>, "key": <allowlisted key>, "value": <typed value>}
//   {"op": "create_note", "path": <vault-relative .md path>, "content": <full note text>}
//   {"op": "move_note", "target": <id>, "to": <C10 archive path or lessons/<principal-id>/...>}
//   {"op": "append_section", "target": <id>, "text": <Markdown appended to the body>}
//
// Unknown ops or fields, ops outside the proposal type's allowlist, unknown
// targets, and unsafe paths invalidate the whole proposal. Frontmatter
// claims (`origin`, `author`, `kind`) are never trusted: `accept` applies a
// proposal only when its id and immutable digest appear in a run record.

import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { isRev, parseCitation } from '../cite/citation.js';
import { PRINCIPAL_ID_RE } from '../config.js';
import { ULID_RE } from '../mcp/ulid.js';
import { foldKey } from '../vault/names.js';
import { canonicalJson, explicitId, isIsoDate, splitFrontmatter } from '../vault/parse.js';

export const PROPOSAL_TYPES = ['merge', 'supersede', 'summary', 'archive', 'demote', 'lesson', 'gap'] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const OP_NAMES = ['set_frontmatter', 'create_note', 'move_note', 'append_section'] as const;
export type OpName = (typeof OP_NAMES)[number];

/**
 * The ops each proposal type may use (a `gap` changes nothing). A `supersede`
 * may create a note only under `lessons/<principal-id>/` (the replacing
 * lesson of a `reflect` contradiction, cognition Phase 6).
 */
export const ALLOWED_OPS: Readonly<Record<ProposalType, readonly OpName[]>> = {
  merge: ['set_frontmatter', 'append_section', 'move_note', 'create_note'],
  supersede: ['set_frontmatter', 'append_section', 'create_note'],
  summary: ['create_note', 'set_frontmatter'],
  archive: ['set_frontmatter', 'move_note'],
  demote: ['set_frontmatter'],
  lesson: ['create_note', 'set_frontmatter', 'move_note', 'append_section'],
  gap: [],
};

/** Frontmatter keys `set_frontmatter` may set. */
export const FRONTMATTER_KEYS = ['status', 'superseded_by', 'superseded_at', 'supersedes', 'valid_until', 'archived_at', 'merged_into'] as const;
export type FrontmatterKey = (typeof FRONTMATTER_KEYS)[number];
/** Statuses `set_frontmatter` may set (never `proposed` or `journal`). */
export const SETTABLE_STATUSES = ['accepted', 'superseded', 'archived', 'stale'] as const;

/** Proposal statuses this module recognizes. */
export const PROPOSAL_STATUSES = ['proposed', 'stale', 'accepted', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Values of the optional `needs_review` flag. */
export const NEEDS_REVIEW_VALUES = ['unadjudicated'] as const;
export type NeedsReview = (typeof NEEDS_REVIEW_VALUES)[number];

export const CHANGE_FENCE_INFO = 'ebrain-change';
export const CHANGE_VERSION = 1;
export const PROPOSAL_KEY_RE = /^pk_[0-9a-f]{32}$/;
export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const JOB_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_TARGETS = 50;
export const MAX_EVIDENCE = 200;
export const MAX_OPS = 100;
export const MAX_CREATE_CHARS = 200_000;
export const MAX_APPEND_CHARS = 50_000;
/** Top-level folders a created or moved note may never land in (moves to the C10 archive paths are checked separately). */
const FORBIDDEN_CREATE_ROOTS = ['_inbox', 'journal', '_raw', '_archive'];

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalError';
  }
}

export interface ProposalTarget {
  id: string;
  rev: string;
  path_at_proposal: string;
}

export type SetFrontmatterOp = { op: 'set_frontmatter'; target: string; key: FrontmatterKey; value: string | string[] };
export type CreateNoteOp = { op: 'create_note'; path: string; content: string };
export type MoveNoteOp = { op: 'move_note'; target: string; to: string };
export type AppendSectionOp = { op: 'append_section'; target: string; text: string };
export type ChangeOp = SetFrontmatterOp | CreateNoteOp | MoveNoteOp | AppendSectionOp;

/** The immutable and descriptive frontmatter of a proposal. */
export interface ProposalMeta {
  id: string;
  title: string;
  status: ProposalStatus;
  proposal_type: ProposalType;
  job: string;
  job_version: number;
  created: string;
  author: string;
  origin: string;
  targets: ProposalTarget[];
  evidence: string[];
  untrusted_origin: boolean;
  taint_sources: string[];
  confidence: 'unrated';
  proposal_key: string;
  /** Set when no model adjudicated the proposal (descriptive; not an immutable field). */
  needs_review?: NeedsReview;
}

export interface ParsedProposal {
  meta: ProposalMeta;
  ops: ChangeOp[];
  /** Body text with the change block (prose, preview). */
  body: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** A note id a proposal may target: an assigned (explicit, non-provisional) id. */
export function isAssignedId(id: unknown): id is string {
  return typeof id === 'string' && explicitId(id) !== null;
}

/**
 * C10 archive destination of a note: `_archive/<path>`, except journal
 * entries (`journal/<principal>/<rest>`), which go to `journal/_archive/<principal>/<rest>`.
 */
export function archiveDestination(relPath: string): string {
  const parts = relPath.split('/');
  if (foldKey(parts[0] ?? '') === 'journal' && parts.length >= 3 && parts[1] !== '_archive') {
    return ['journal', '_archive', ...parts.slice(1)].join('/');
  }
  return `_archive/${relPath}`;
}

/** Reasons a vault-relative note path is not acceptable to a change op, or undefined. Lexical only; apply re-resolves through safe-path. */
export function notePathError(rel: string): string | undefined {
  if (rel === '' || rel.length > 1024) return 'path is empty or too long';
  if (/[\u0000-\u001f\u007f\\]/.test(rel)) return 'path contains control characters or backslashes';
  if (rel.startsWith('/')) return 'path must be vault-relative';
  if (!/\.md$/.test(rel)) return 'path must end in .md';
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return 'path has empty, dot, or dot-directory segments';
  return undefined;
}

/** `lessons/<principal-id>/<name>.md` (one level, a valid principal id). */
export function isLessonPath(rel: string): boolean {
  const segs = rel.split('/');
  return segs.length === 3 && segs[0] === 'lessons' && PRINCIPAL_ID_RE.test(segs[1]!) && notePathError(rel) === undefined;
}

function createPathError(rel: string, type: ProposalType): string | undefined {
  const e = notePathError(rel);
  if (e !== undefined) return e;
  if ((type === 'lesson' || type === 'supersede') && !isLessonPath(rel)) return `a ${type} proposal creates notes only under lessons/<principal-id>/`;
  if (FORBIDDEN_CREATE_ROOTS.includes(foldKey(rel.split('/')[0]!))) return `notes may not be created under ${rel.split('/')[0]}/`;
  return undefined;
}

function valueError(key: FrontmatterKey, value: unknown): string | undefined {
  switch (key) {
    case 'status':
      return typeof value === 'string' && (SETTABLE_STATUSES as readonly string[]).includes(value) ? undefined : `status must be one of ${SETTABLE_STATUSES.join(', ')}`;
    case 'superseded_by':
    case 'merged_into':
      return isAssignedId(value) ? undefined : `${key} must be an assigned note id`;
    case 'supersedes':
      return Array.isArray(value) && value.length >= 1 && value.length <= MAX_TARGETS && value.every(isAssignedId) ? undefined : 'supersedes must be a list of assigned note ids';
    case 'superseded_at':
    case 'valid_until':
    case 'archived_at':
      return typeof value === 'string' && isIsoDate(value) ? undefined : `${key} must be an ISO 8601 date`;
  }
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[], label: string): void {
  const have = Object.keys(o);
  for (const k of have) if (!keys.includes(k)) throw new ProposalError(`${label}: unknown field "${k.slice(0, 40)}"`);
  for (const k of keys) if (!Object.hasOwn(o, k)) throw new ProposalError(`${label}: missing field "${k}"`);
}

/** Validate a change block's ops against the proposal type and targets. */
export function validateOps(raw: unknown, type: ProposalType, targets: readonly ProposalTarget[]): ChangeOp[] {
  if (!Array.isArray(raw)) throw new ProposalError('change block "ops" must be a list');
  if (raw.length > MAX_OPS) throw new ProposalError(`change block has more than ${MAX_OPS} ops`);
  const targetIds = new Set(targets.map((t) => t.id));
  const allowed = ALLOWED_OPS[type];
  const created = new Set<string>();
  const moved = new Set<string>();
  const ops: ChangeOp[] = [];
  raw.forEach((o, i) => {
    const label = `op ${i}`;
    if (!isObject(o)) throw new ProposalError(`${label} is not an object`);
    const name = o['op'];
    if (typeof name !== 'string' || !(OP_NAMES as readonly string[]).includes(name)) throw new ProposalError(`${label}: unknown op`);
    if (!(allowed as readonly string[]).includes(name)) throw new ProposalError(`${label}: ${name} is not allowed in a ${type} proposal`);
    const target = (): string => {
      const t = o['target'];
      if (typeof t !== 'string' || !targetIds.has(t)) throw new ProposalError(`${label}: target is not one of the proposal's targets`);
      return t;
    };
    const text = (k: string, max: number): string => {
      const v = o[k];
      if (typeof v !== 'string' || v.length > max) throw new ProposalError(`${label}: ${k} must be text of at most ${max} characters`);
      if (/\u0000/.test(v)) throw new ProposalError(`${label}: ${k} contains a NUL character`);
      return v;
    };
    switch (name as OpName) {
      case 'set_frontmatter': {
        exactKeys(o, ['op', 'target', 'key', 'value'], label);
        const key = o['key'];
        if (typeof key !== 'string' || !(FRONTMATTER_KEYS as readonly string[]).includes(key)) throw new ProposalError(`${label}: key is not in the allowlist`);
        const e = valueError(key as FrontmatterKey, o['value']);
        if (e !== undefined) throw new ProposalError(`${label}: ${e}`);
        ops.push({ op: 'set_frontmatter', target: target(), key: key as FrontmatterKey, value: o['value'] as string | string[] });
        break;
      }
      case 'create_note': {
        exactKeys(o, ['op', 'path', 'content'], label);
        const p = o['path'];
        if (typeof p !== 'string') throw new ProposalError(`${label}: path must be text`);
        const e = createPathError(p, type);
        if (e !== undefined) throw new ProposalError(`${label}: ${e}`);
        if (created.has(foldKey(p))) throw new ProposalError(`${label}: path is created twice`);
        created.add(foldKey(p));
        ops.push({ op: 'create_note', path: p, content: text('content', MAX_CREATE_CHARS) });
        break;
      }
      case 'move_note': {
        exactKeys(o, ['op', 'target', 'to'], label);
        const t = target();
        if (moved.has(t)) throw new ProposalError(`${label}: target is moved twice`);
        moved.add(t);
        const to = o['to'];
        if (typeof to !== 'string' || notePathError(to) !== undefined) throw new ProposalError(`${label}: to is not a safe note path`);
        const from = targets.find((x) => x.id === t)!.path_at_proposal;
        if (to !== archiveDestination(from) && !isLessonPath(to)) {
          throw new ProposalError(`${label}: to must be the C10 archive path (${archiveDestination(from)}) or under lessons/<principal-id>/`);
        }
        ops.push({ op: 'move_note', target: t, to });
        break;
      }
      case 'append_section': {
        exactKeys(o, ['op', 'target', 'text'], label);
        const t = target();
        const v = text('text', MAX_APPEND_CHARS);
        if (v.trim() === '') throw new ProposalError(`${label}: text is empty`);
        ops.push({ op: 'append_section', target: t, text: v });
        break;
      }
    }
  });
  return ops;
}

function parseTargets(raw: unknown): ProposalTarget[] {
  if (!Array.isArray(raw) || raw.length > MAX_TARGETS) throw new ProposalError(`targets must be a list of at most ${MAX_TARGETS}`);
  const seen = new Set<string>();
  return raw.map((t, i) => {
    if (!isObject(t)) throw new ProposalError(`targets/${i} is not an object`);
    exactKeys(t, ['id', 'rev', 'path_at_proposal'], `targets/${i}`);
    const { id, rev, path_at_proposal: p } = t;
    if (!isAssignedId(id)) throw new ProposalError(`targets/${i}: id must be an assigned note id (run ebrain ids assign)`);
    if (typeof rev !== 'string' || !isRev(rev)) throw new ProposalError(`targets/${i}: rev must be 16 lowercase hex`);
    if (typeof p !== 'string' || notePathError(p) !== undefined) throw new ProposalError(`targets/${i}: path_at_proposal is not a safe note path`);
    if (seen.has(id)) throw new ProposalError(`targets/${i}: duplicate target`);
    seen.add(id);
    return { id, rev, path_at_proposal: p };
  });
}

function citationList(raw: unknown, label: string, max: number): string[] {
  if (!Array.isArray(raw) || raw.length > max) throw new ProposalError(`${label} must be a list of at most ${max} citations`);
  return raw.map((c, i) => {
    if (!parseCitation(c).ok) throw new ProposalError(`${label}/${i} is not a well-formed citation`);
    return c as string;
  });
}

/** Find the single `ebrain-change` fenced block in a body. */
export function extractChangeBlock(body: string): { json: string; start: number; end: number } {
  const lines = body.split('\n');
  const found: { json: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(`{3,})(\S*)[ \t]*$/.exec(lines[i]!);
    if (m === null) continue;
    const fence = m[1]!;
    let j = i + 1;
    const closes = (l: string): boolean => /^`{3,}[ \t]*$/.test(l) && l.trim().length >= fence.length;
    while (j < lines.length && !closes(lines[j]!)) j++;
    if (m[2] === CHANGE_FENCE_INFO) found.push({ json: lines.slice(i + 1, j).join('\n'), start: i, end: j });
    i = j;
  }
  if (found.length !== 1) throw new ProposalError(found.length === 0 ? 'no ebrain-change block' : 'more than one ebrain-change block');
  return found[0]!;
}

/** Parse the JSON of a change block: exactly `{"version": 1, "ops": [...]}`. */
export function parseChangeJson(json: string, type: ProposalType, targets: readonly ProposalTarget[]): ChangeOp[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ProposalError('change block is not valid JSON');
  }
  if (!isObject(raw)) throw new ProposalError('change block must be a JSON object');
  exactKeys(raw, ['version', 'ops'], 'change block');
  if (raw['version'] !== CHANGE_VERSION) throw new ProposalError(`change block version must be ${CHANGE_VERSION}`);
  return validateOps(raw['ops'], type, targets);
}

/** Parse and validate a proposal's full note text. Throws ProposalError. */
export function parseProposal(text: string): ParsedProposal {
  const split = splitFrontmatter(text);
  if (split.yaml === null) throw new ProposalError('no frontmatter');
  const doc = parseDocument(split.yaml, { schema: 'core', prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) throw new ProposalError('malformed frontmatter');
  const fm: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!isObject(fm)) throw new ProposalError('frontmatter is not a mapping');
  if (fm['kind'] !== 'proposal') throw new ProposalError('not a proposal (kind is not "proposal")');
  const id = fm['id'];
  if (typeof id !== 'string' || !ULID_RE.test(id)) throw new ProposalError('id must be a ULID');
  const type = fm['proposal_type'];
  if (typeof type !== 'string' || !(PROPOSAL_TYPES as readonly string[]).includes(type)) throw new ProposalError('unknown proposal_type');
  const status = fm['status'];
  if (typeof status !== 'string' || !(PROPOSAL_STATUSES as readonly string[]).includes(status)) throw new ProposalError('unknown proposal status');
  const job = fm['job'];
  if (typeof job !== 'string' || !JOB_NAME_RE.test(job)) throw new ProposalError('job is not a job name');
  const jobVersion = fm['job_version'];
  if (typeof jobVersion !== 'number' || !Number.isInteger(jobVersion) || jobVersion < 1) throw new ProposalError('job_version must be a positive integer');
  const key = fm['proposal_key'];
  if (typeof key !== 'string' || !PROPOSAL_KEY_RE.test(key)) throw new ProposalError('proposal_key is malformed');
  if (fm['confidence'] !== 'unrated') throw new ProposalError('confidence must be "unrated" (C4)');
  const untrusted = fm['untrusted_origin'];
  if (typeof untrusted !== 'boolean') throw new ProposalError('untrusted_origin must be true or false');
  const targets = parseTargets(fm['targets']);
  const evidence = citationList(fm['evidence'], 'evidence', MAX_EVIDENCE);
  const taint = citationList(fm['taint_sources'] ?? [], 'taint_sources', MAX_EVIDENCE);
  const created = typeof fm['created'] === 'string' ? fm['created'] : '';
  const needsReview = fm['needs_review'];
  if (needsReview !== undefined && (typeof needsReview !== 'string' || !(NEEDS_REVIEW_VALUES as readonly string[]).includes(needsReview))) {
    throw new ProposalError(`needs_review must be one of ${NEEDS_REVIEW_VALUES.join(', ')}`);
  }
  const block = extractChangeBlock(split.body);
  const ops = parseChangeJson(block.json, type as ProposalType, targets);
  return {
    meta: {
      id, title: typeof fm['title'] === 'string' ? fm['title'] : '', status: status as ProposalStatus, proposal_type: type as ProposalType,
      job, job_version: jobVersion, created, author: typeof fm['author'] === 'string' ? fm['author'] : '',
      origin: typeof fm['origin'] === 'string' ? fm['origin'] : '', targets, evidence, untrusted_origin: untrusted, taint_sources: taint,
      confidence: 'unrated', proposal_key: key,
      ...(needsReview === undefined ? {} : { needs_review: needsReview as NeedsReview }),
    },
    ops,
    body: split.body,
  };
}

/** The op fields that are immutable: everything except create_note content and append_section text. */
function opShape(op: ChangeOp): Record<string, unknown> {
  switch (op.op) {
    case 'set_frontmatter':
      return { op: op.op, target: op.target, key: op.key, value: op.value };
    case 'create_note':
      return { op: op.op, path: op.path };
    case 'move_note':
      return { op: op.op, target: op.target, to: op.to };
    case 'append_section':
      return { op: op.op, target: op.target };
  }
}

/**
 * SHA-256 (hex) over the immutable fields: id, targets, evidence,
 * proposal_key, proposal_type, job, and the ops' targets and parameters.
 * Recorded in the run record; `accept` refuses a proposal whose digest differs.
 */
export function immutableDigest(meta: Pick<ProposalMeta, 'id' | 'targets' | 'evidence' | 'proposal_key' | 'proposal_type' | 'job'>, ops: readonly ChangeOp[]): string {
  return sha256hex(canonicalJson({
    id: meta.id,
    targets: meta.targets.map((t) => ({ id: t.id, rev: t.rev, path_at_proposal: t.path_at_proposal })),
    evidence: [...meta.evidence],
    proposal_key: meta.proposal_key,
    proposal_type: meta.proposal_type,
    job: meta.job,
    ops: ops.map(opShape),
  }));
}

/** C5: a stable function of (job, sorted evidence, proposal type). */
export function proposalKey(job: string, type: ProposalType, evidence: readonly string[]): string {
  const sorted = [...new Set(evidence)].sort();
  return `pk_${sha256hex(`${job}\n${type}\n${sorted.join('\n')}`).slice(0, 32)}`;
}

/** The fenced change block for `ops` (JSON lines never start with a backtick, so a triple fence is safe). */
export function renderChangeBlock(ops: readonly ChangeOp[]): string {
  return `\`\`\`${CHANGE_FENCE_INFO}\n${JSON.stringify({ version: CHANGE_VERSION, ops }, null, 2)}\n\`\`\``;
}

export interface RenderInput {
  meta: Omit<ProposalMeta, 'status' | 'confidence'>;
  ops: readonly ChangeOp[];
  rationale: string;
  preview: string;
  scrubVersion: number;
}

/** The full note text of a new proposal (status `proposed`). */
export function renderProposalNote(r: RenderInput): string {
  const m = r.meta;
  const fm: Record<string, unknown> = {
    schema: 1,
    id: m.id,
    title: m.title,
    status: 'proposed',
    kind: 'proposal',
    proposal_type: m.proposal_type,
    job: m.job,
    job_version: m.job_version,
    created: m.created,
    author: m.author,
    origin: m.origin,
    targets: m.targets.map((t) => ({ id: t.id, rev: t.rev, path_at_proposal: t.path_at_proposal })),
    evidence: [...m.evidence],
    untrusted_origin: m.untrusted_origin,
    taint_sources: [...m.taint_sources],
    confidence: 'unrated',
    proposal_key: m.proposal_key,
    ...(m.needs_review === undefined ? {} : { needs_review: m.needs_review }),
    scrubVersion: r.scrubVersion,
  };
  const yaml = stringify(fm, { lineWidth: 0 });
  const rationale = r.rationale.replace(/\r\n?/g, '\n').trim();
  const banner = (m.untrusted_origin ? '> **Untrusted origin:** derived from untrusted sources; check them before accepting.\n\n' : '') +
    (m.needs_review === 'unadjudicated' ? '> **Needs review (unadjudicated):** no model judged this pair; read both notes before accepting.\n\n' : '');
  return [
    `---\n${yaml}---`,
    `# ${m.title}`,
    '',
    `${banner}${rationale === '' ? '(no rationale)' : rationale}`,
    '',
    '## Change',
    '',
    renderChangeBlock(r.ops),
    '',
    '## Preview',
    '',
    r.preview.trim() === '' ? '(no changes: this proposal is a report)' : r.preview.trim(),
    '',
  ].join('\n');
}
