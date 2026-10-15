// `ebrain propose` (Phase 14): candidate notes from the raw archive, written
// only to `_inbox/` for the owner to review. The provider comes from the
// shared `src/llm/` layer; this module holds no provider or network code.
//
// For each archive note, turns are re-scrubbed (I5: only scrubbed text is
// ever sent, even if the owner edited an archive file), cut into windows,
// and sent with the versioned `propose` prompt. Each response is validated
// against a strict schema; invalid items, and items whose quote is not found
// verbatim in the cited turns, are dropped and counted. Survivors become
// `status: proposed` notes with `confidence: unrated` and a turn-range
// citation `note:<archive-id>@<rev>#turns-<a>-<b>` in `sources`.
//
// Idempotent: a candidate id is a hash of archive id, turn range, and
// normalized statement. Ids already present in `_inbox/` (including
// `_rejected/` and `_applied/`) or recorded in the state-dir ledger (so an
// accepted or deleted candidate is not proposed again) are skipped.

import { createHash } from 'node:crypto';
import { formatCitation } from '../cite/citation.js';
import type { Config } from '../config.js';
import { cleanTitle, isoSeconds, renderProposal, toSlug } from '../inbox/note.js';
import { INBOX_DIR, writeInboxFile } from '../inbox/writer.js';
import { realVaultDir } from '../journal/store.js';
import { RunBudget, type BudgetStop } from '../llm/budget.js';
import { LlmError } from '../llm/errors.js';
import { currentPrompt, promptId } from '../llm/prompts/index.js';
import type { ExtractionProvider } from '../llm/provider.js';
import { validateOutput, type ItemSchema } from '../llm/schema.js';
import { withLock } from '../lock.js';
import { fenceFor, truncateText } from '../mcp/fence.js';
import { ulid } from '../mcp/ulid.js';
import { appendSafe, readDirSafe, readFileSafe, readFileWithStatSafe, resolveInState, resolveInVault, statSafe, type SafePath } from '../safe-path.js';
import { DETECTOR_TYPES, scrub, scrubVersion, type DetectorType, type ScrubFinding } from '../scrub/index.js';
import { splitFrontmatter } from '../vault/parse.js';
import { readArchive, type ArchiveFilter, type ArchiveNote, type ArchiveTurn } from './archive-reader.js';

export const PROPOSE_AUTHOR = 'ebrain-propose';
export const CANDIDATE_KINDS = ['decision', 'preference', 'lesson', 'idea'] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];
export const CANDIDATE_ID_RE = /^cand_[0-9a-f]{32}$/;
/** State-dir ledger of every candidate id ever written (ids and note ids only, no text). */
export const LEDGER_FILE = 'propose-candidates.jsonl';
/** Longest turn text sent, in characters. */
export const TURN_MAX_CHARS = 4000;
/** Archive text per provider call, in characters (one window). */
export const WINDOW_CHARS = 12_000;
/** Candidates kept per response; the rest are dropped and counted. */
export const MAX_ITEMS_PER_RESPONSE = 20;

export interface ModelCandidate {
  kind: CandidateKind;
  title: string;
  statement: string;
  quote: string;
  turn_start: number;
  turn_end: number;
}

export interface ProposeOptions {
  config: Config;
  stateDir: SafePath;
  provider: ExtractionProvider;
  filter?: ArchiveFilter;
  now?: () => Date;
}

export interface ProposeResult {
  archives: number;
  malformedArchives: number;
  filteredArchives: number;
  calls: number;
  inputChars: number;
  windowsSkipped: number;
  created: string[];
  duplicates: number;
  /** Responses that were not JSON in the expected envelope. */
  invalidResponses: number;
  /** Items dropped for failing the schema or the turn bounds. */
  invalidItems: number;
  /** Items dropped because the quote is not in the cited turns. */
  unsupportedQuotes: number;
  stop?: BudgetStop;
  error?: string;
  /** Findings when re-scrubbing archive text before sending (counts by type only). */
  findings: ScrubFinding[];
}

interface Window {
  note: ArchiveNote;
  turns: ArchiveTurn[];
  text: string;
}

interface Candidate {
  id: string;
  note: ArchiveNote;
  item: ModelCandidate;
}

function norm(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Stable candidate id: archive id + turn range + hash of the normalized statement. */
export function candidateId(archiveId: string, from: number, to: number, statement: string): string {
  return `cand_${sha(`${archiveId}\n${from}-${to}\n${sha(norm(statement).toLowerCase())}`).slice(0, 32)}`;
}

function itemSchema(first: number, last: number): ItemSchema {
  return {
    kind: { type: 'enum', values: CANDIDATE_KINDS },
    title: { type: 'string', min: 1, max: 120 },
    statement: { type: 'string', min: 1, max: 1000 },
    quote: { type: 'string', min: 1, max: 500 },
    turn_start: { type: 'int', min: first, max: last },
    turn_end: { type: 'int', min: first, max: last },
  };
}

function turnBlock(t: ArchiveTurn): string {
  const f = fenceFor(t.text);
  return `Turn ${t.n} (${t.role}):\n${f}text\n${t.text}\n${f}\n`;
}

/** Scrubbed turns of one note, cut into windows of at most WINDOW_CHARS. */
function windowsOf(note: ArchiveNote, scrubText: (s: string) => string): Window[] {
  const out: Window[] = [];
  let cur: ArchiveTurn[] = [];
  let size = 0;
  const flush = (): void => {
    if (cur.length > 0) out.push({ note, turns: cur, text: cur.map(turnBlock).join('\n') });
    cur = [];
    size = 0;
  };
  for (const t of note.turns) {
    const clean: ArchiveTurn = { ...t, text: truncateText(scrubText(t.text), TURN_MAX_CHARS) };
    const block = turnBlock(clean).length + 1;
    if (size + block > WINDOW_CHARS) flush();
    cur.push(clean);
    size += block;
  }
  flush();
  return out;
}

/** Candidate ids already in `_inbox/` (one level of subfolders) or in the ledger. */
function existingIds(vaultPath: string, stateDir: SafePath): Set<string> {
  const ids = new Set<string>();
  const ledger = resolveInState(stateDir, LEDGER_FILE);
  if (statSafe(ledger) !== undefined) {
    for (const line of readFileSafe(ledger, 'utf8').split('\n')) {
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        if (typeof id === 'string' && CANDIDATE_ID_RE.test(id)) ids.add(id);
      } catch {
        // a torn or foreign line: ignored
      }
    }
  }
  if (realVaultDir(vaultPath, INBOX_DIR, false) === undefined) return ids;
  const scan = (rel: string, depth: number): void => {
    for (const e of readDirSafe(resolveInVault(vaultPath, rel))) {
      if (e.name.startsWith('.')) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory() && depth > 0) scan(child, depth - 1);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const { yaml } = splitFrontmatter(readFileWithStatSafe(resolveInVault(vaultPath, child), { maxBytes: 1024 * 1024 }).data.toString('utf8'));
          const m = yaml === null ? null : /^candidate_id:\s*['"]?(cand_[0-9a-f]{32})['"]?\s*$/m.exec(yaml);
          if (m !== null) ids.add(m[1]!);
        } catch {
          // unreadable or oversized: not a candidate of ours
        }
      }
    }
  };
  scan(INBOX_DIR, 1);
  return ids;
}

function renderCandidate(c: Candidate, provider: ExtractionProvider, prompt: string, now: Date, scrubText: (s: string) => string): { title: string; text: string } {
  const { item, note } = c;
  const title = cleanTitle(scrubText(item.title)) || 'Candidate note';
  const statement = scrubText(item.statement).trim();
  const quote = scrubText(item.quote).trim();
  const range = item.turn_start === item.turn_end ? `turn ${item.turn_start}` : `turns ${item.turn_start}-${item.turn_end}`;
  const citation = formatCitation({ kind: 'note', id: note.id, rev: note.rev, turns: { from: item.turn_start, to: item.turn_end } });
  const f = fenceFor(quote);
  const body = [
    statement,
    '',
    `Supporting quote (${range} of the archived conversation):`,
    '',
    `${f}text`,
    quote,
    f,
    '',
    `Source: ${cleanTitle(note.title)} (\`${note.relPath}\`), ${range}.`,
    `Extracted by ${provider.provider} model ${cleanTitle(provider.model)} with prompt ${prompt}. Unverified and unrated: check the cited turns before accepting.`,
  ].join('\n');
  const text = renderProposal(
    {
      id: ulid(now.getTime()), title, kind: item.kind, created: isoSeconds(now), origin: 'cli', author: PROPOSE_AUTHOR, sources: [citation], scrubVersion,
      extra: { candidate_id: c.id, confidence: 'unrated', extraction_prompt: prompt, extraction_model: `${provider.provider}:${provider.model}` },
    },
    body,
  );
  return { title, text };
}

/** Run the job. Provider failures stop further calls but keep the candidates gathered so far. */
export async function propose(opts: ProposeOptions): Promise<ProposeResult> {
  const { config, provider } = opts;
  if (config.mode !== 'inbox' || config.principal.type !== 'human') throw new Error('propose needs mode inbox and a human principal');
  const now = (opts.now ?? (() => new Date()))();
  const prompt = currentPrompt('propose');
  const pid = promptId(prompt);
  const counts = new Map<DetectorType, number>();
  const scrubText = (s: string): string => {
    const r = scrub(s, { principal: { type: 'human' }, extraPatterns: config.scrub.extraPatterns });
    if (!r.ok) throw new Error('unexpected scrub rejection');
    for (const f of r.findings) counts.set(f.type, (counts.get(f.type) ?? 0) + f.count);
    return r.text;
  };

  const read = readArchive(config.vaultPath, opts.filter ?? {});
  const result: ProposeResult = {
    archives: read.notes.length, malformedArchives: read.malformed, filteredArchives: read.filtered, calls: 0, inputChars: 0, windowsSkipped: 0,
    created: [], duplicates: 0, invalidResponses: 0, invalidItems: 0, unsupportedQuotes: 0, findings: [],
  };
  const budget = new RunBudget(config.llm.maxCallsPerRun, config.llm.maxInputCharsPerRun);
  const candidates: Candidate[] = [];
  const windows = read.notes.flatMap((n) => windowsOf(n, scrubText));
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const user = `${prompt.instructions}\n\nConversation title: ${cleanTitle(scrubText(w.note.title))}\n\nTranscript:\n\n${w.text}`;
    const chars = prompt.system.length + user.length;
    const stop = budget.check(chars);
    if (stop !== undefined) {
      result.stop = stop;
      result.windowsSkipped = windows.length - i;
      break;
    }
    budget.record(chars);
    let reply: string;
    try {
      reply = await provider.complete({ system: prompt.system, user, maxOutputTokens: config.llm.maxOutputTokens });
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      result.error = err.message;
      result.windowsSkipped = windows.length - i;
      break;
    }
    const first = w.turns[0]!.n;
    const last = w.turns[w.turns.length - 1]!.n;
    const v = validateOutput<ModelCandidate>(reply, 'candidates', itemSchema(first, last), MAX_ITEMS_PER_RESPONSE);
    if (!v.parsed) {
      result.invalidResponses++;
      continue;
    }
    result.invalidItems += v.invalid;
    for (const item of v.items) {
      if (item.turn_end < item.turn_start) {
        result.invalidItems++;
        continue;
      }
      const cited = norm(w.turns.filter((t) => t.n >= item.turn_start && t.n <= item.turn_end).map((t) => t.text).join('\n'));
      if (!cited.includes(norm(item.quote))) {
        result.unsupportedQuotes++;
        continue;
      }
      candidates.push({ id: candidateId(w.note.id, item.turn_start, item.turn_end, item.statement), note: w.note, item });
    }
  }
  result.calls = budget.calls;
  result.inputChars = budget.inputChars;

  if (candidates.length > 0) {
    withLock(opts.stateDir, 'propose', () => {
      const seen = existingIds(config.vaultPath, opts.stateDir);
      const ledger = resolveInState(opts.stateDir, LEDGER_FILE);
      for (const c of candidates) {
        if (seen.has(c.id)) {
          result.duplicates++;
          continue;
        }
        seen.add(c.id);
        const { title, text } = renderCandidate(c, provider, pid, now, scrubText);
        const written = writeInboxFile(config.vaultPath, toSlug(title), now, text);
        appendSafe(ledger, `${JSON.stringify({ id: c.id, path: written.relPath, at: isoSeconds(now) })}\n`);
        result.created.push(written.relPath);
      }
    });
  }
  result.findings = DETECTOR_TYPES.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type)! }));
  return result;
}
