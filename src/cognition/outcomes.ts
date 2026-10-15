// Later owner actions and best-effort structural matching (cognition Phase 9).
// Used by `ebrain cognition report` to compare shadow proposals with what the
// owner later did by hand, and by `ebrain eval replay` to score a replayed
// job against the changes made after the replay point.
//
// A note's facts come from the index (assigned ids only). A *later action* is
// a change between a "before" and an "after" snapshot of those facts:
//
//   superseded  status became `superseded`
//   merged      status became `archived` (or the note moved under `_archive/`) with `merged_into` set
//   archived    the same without `merged_into`
//   demoted     status became `stale`
//   lesson      a new note (id absent before) with `kind: lesson`
//   summary     a new note with `kind: summary`
//
// A proposal *matches* an action structurally, never by text:
//
//   - a `set_frontmatter status <v>` op on target T matches a status action on
//     T reaching <v> (`stale` also matches `archived`/`merged`: the owner went
//     further); a `move_note` op on T matches T becoming archived or merged;
//   - a `create_note` op whose content has `kind: lesson|summary` matches a
//     new note of that kind whose `derived_from`/`sources` share citations
//     with the proposal's evidence (by `kind:id`, ignoring revisions): at
//     least one for a lesson, at least two (or all, when fewer are cited)
//     for a summary.
//
// Without a "before" snapshot (the online shadow comparison), a status action
// counts when the target's current status is the expected one, and a new note
// counts when it was created or occurred no earlier than the day before the
// proposal (dates without a time are midnight).

import { parseDocument } from 'yaml';
import type Database from 'better-sqlite3';
import { parseCitation } from '../cite/citation.js';
import type { ChangeOp, ProposalTarget, ProposalType } from '../review/proposal.js';
import { splitFrontmatter } from '../vault/parse.js';

export type ActionKind = 'superseded' | 'merged' | 'archived' | 'demoted' | 'lesson' | 'summary';
export const ACTION_KINDS: readonly ActionKind[] = ['superseded', 'merged', 'archived', 'demoted', 'lesson', 'summary'];

/** Which later actions count toward a job's recall in replay evaluation (gaps changes nothing; selftest only demotes). */
export const JOB_ACTIONS: Readonly<Record<string, readonly ActionKind[]>> = {
  selftest: ['demoted'],
  supersede: ['superseded'],
  consolidate: ['merged', 'summary'],
  reflect: ['lesson'],
  forget: ['demoted', 'archived'],
  gaps: [],
};

export interface NoteFacts {
  id: string;
  path: string;
  /** Effective lifecycle status: `archived` for anything under `_archive/`. */
  status: string | null;
  kind: string | null;
  /** Epoch ms of `created` (else `occurred`), or undefined. */
  timeMs: number | undefined;
  merged_into: string | null;
  /** `kind:id` of every citation in `derived_from` and `sources`. */
  cites: Set<string>;
}

export interface LaterAction {
  kind: ActionKind;
  id: string;
  path: string;
}

/** The facts a proposal is matched on (a parsed proposal satisfies this). */
export interface MatchableProposal {
  proposal_type: ProposalType;
  created: string;
  targets: readonly ProposalTarget[];
  evidence: readonly string[];
  ops: readonly ChangeOp[];
}

export const actionKey = (a: Pick<LaterAction, 'kind' | 'id'>): string => `${a.kind}:${a.id}`;

function citeBase(c: string): string | undefined {
  const p = parseCitation(c);
  if (!p.ok) return undefined;
  const k = p.citation;
  return k.kind === 'note' || k.kind === 'thesis' || k.kind === 'outcome' ? `${k.kind}:${k.id}` : undefined;
}

function jsonArray(s: string | null): string[] {
  if (s === null) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function timeOf(...vals: (string | null)[]): number | undefined {
  for (const v of vals) {
    if (v === null) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** Facts for every indexed note with an assigned id, outside `_inbox/` (proposals are not owner actions). */
export function noteFacts(db: Database.Database): Map<string, NoteFacts> {
  const rows = db.prepare(
    `SELECT id, path, folder_class, status, kind, created, occurred, merged_into, derived_from, sources
       FROM notes WHERE provisional = 0 AND folder_class != 'inbox' ORDER BY path`,
  ).all() as {
    id: string; path: string; folder_class: string; status: string | null; kind: string | null; created: string | null; occurred: string | null;
    merged_into: string | null; derived_from: string; sources: string;
  }[];
  const out = new Map<string, NoteFacts>();
  for (const r of rows) {
    if (out.has(r.id)) continue; // a duplicated id: the first path wins, like the index
    const cites = new Set<string>();
    for (const c of [...jsonArray(r.derived_from), ...jsonArray(r.sources)]) {
      const b = citeBase(c);
      if (b !== undefined) cites.add(b);
    }
    out.set(r.id, {
      id: r.id, path: r.path, status: r.folder_class === 'archive' ? 'archived' : r.status, kind: r.kind,
      timeMs: timeOf(r.created, r.occurred), merged_into: r.merged_into, cites,
    });
  }
  return out;
}

function statusAction(f: NoteFacts): ActionKind | undefined {
  if (f.status === 'superseded') return 'superseded';
  if (f.status === 'archived') return f.merged_into !== null ? 'merged' : 'archived';
  if (f.status === 'stale') return 'demoted';
  return undefined;
}

/** The owner's actions between two snapshots, in a stable order. */
export function laterActions(before: ReadonlyMap<string, NoteFacts>, after: ReadonlyMap<string, NoteFacts>): LaterAction[] {
  const out: LaterAction[] = [];
  for (const f of after.values()) {
    const b = before.get(f.id);
    if (b === undefined) {
      if (f.kind === 'lesson' || f.kind === 'summary') out.push({ kind: f.kind, id: f.id, path: f.path });
      continue;
    }
    const now = statusAction(f);
    if (now !== undefined && now !== statusAction(b)) out.push({ kind: now, id: f.id, path: f.path });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** `kind:` of a create_note op's content, if it is a lesson or summary. */
function createdKind(content: string): 'lesson' | 'summary' | undefined {
  const { yaml } = splitFrontmatter(content);
  if (yaml === null) return undefined;
  try {
    const fm = parseDocument(yaml, { schema: 'core', prettyErrors: false }).toJS({ maxAliasCount: 0 }) as unknown;
    const kind = typeof fm === 'object' && fm !== null ? (fm as Record<string, unknown>)['kind'] : undefined;
    return kind === 'lesson' || kind === 'summary' ? kind : undefined;
  } catch {
    return undefined;
  }
}

const STATUS_EXPECT: Readonly<Record<string, readonly ActionKind[]>> = {
  superseded: ['superseded'],
  archived: ['archived', 'merged'],
  stale: ['demoted', 'archived', 'merged'],
};

/**
 * The later actions this proposal structurally matches (see the module
 * comment). With `before`, only actions in the before -> after diff count;
 * without it, the current state is judged against the proposal's time.
 */
export function matchProposal(p: MatchableProposal, after: ReadonlyMap<string, NoteFacts>, before?: ReadonlyMap<string, NoteFacts>): LaterAction[] {
  const diff = before === undefined ? undefined : new Set(laterActions(before, after).map(actionKey));
  const counts = (a: LaterAction): boolean => (diff === undefined ? true : diff.has(actionKey(a)));
  const out = new Map<string, LaterAction>();
  const expectOn = (target: string, kinds: readonly ActionKind[]): void => {
    const f = after.get(target);
    if (f === undefined) return;
    const k = statusAction(f);
    if (k === undefined || !kinds.includes(k)) return;
    const a = { kind: k, id: f.id, path: f.path };
    if (counts(a)) out.set(actionKey(a), a);
  };
  const sinceMs = Date.parse(p.created);
  const evidence = new Set(p.evidence.map(citeBase).filter((x): x is string => x !== undefined));
  for (const op of p.ops) {
    if (op.op === 'set_frontmatter' && op.key === 'status' && typeof op.value === 'string' && STATUS_EXPECT[op.value] !== undefined) {
      expectOn(op.target, STATUS_EXPECT[op.value]!);
    } else if (op.op === 'move_note') {
      expectOn(op.target, ['archived', 'merged']);
    } else if (op.op === 'create_note') {
      const kind = createdKind(op.content);
      if (kind === undefined) continue;
      const need = kind === 'lesson' ? 1 : Math.min(2, evidence.size);
      if (need === 0) continue;
      for (const f of after.values()) {
        if (f.kind !== kind) continue;
        if (before !== undefined ? before.has(f.id) : !(Number.isFinite(sinceMs) && f.timeMs !== undefined && f.timeMs >= sinceMs - 86_400_000)) continue;
        let shared = 0;
        for (const c of f.cites) if (evidence.has(c)) shared++;
        if (shared < need) continue;
        const a = { kind, id: f.id, path: f.path };
        if (counts(a)) out.set(actionKey(a), a);
      }
    }
  }
  return [...out.values()];
}
