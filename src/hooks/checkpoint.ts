// The pre-compact checkpoint (Phase 13): extractive only (no LLM call). From
// a Claude Code transcript it takes the opening request and the most recent
// user turns, scrubs them (I5; redact, never reject: the payload is
// untrusted input, not an agent write), and writes one proposal to
// `_inbox/` (`origin: hook`, `kind: raw`, `untrusted_origin: true`).

import * as path from 'node:path';
import { ClaudeCodeCollector, type Conversation } from '../import/sources.js';
import { MAX_SOURCE_FILE_BYTES } from '../import/load.js';
import { cleanTitle, isoSeconds, renderProposal, toSlug } from '../inbox/note.js';
import { writeInboxFile } from '../inbox/writer.js';
import { fenceFor, truncateText } from '../mcp/fence.js';
import { ulid } from '../mcp/ulid.js';
import { openExternalFile, resolveInRoot, SafePathError } from '../safe-path.js';
import { scrub, scrubVersion, type ScrubFinding } from '../scrub/index.js';
import { decodeNote } from '../vault/parse.js';

/** Recent user turns kept after the opening request. */
export const CHECKPOINT_RECENT_TURNS = 5;
export const OPENING_MAX_CHARS = 2000;
export const TURN_MAX_CHARS = 1000;
const TITLE_PREFIX = 'Claude Code checkpoint';

export interface CheckpointInput {
  vaultPath: string;
  principalId: string;
  extraPatterns: readonly string[];
  /** The only directory transcripts may be read from. */
  projectsDir: string;
  transcriptPath: unknown;
  sessionId?: unknown;
  now?: () => Date;
}

export type CheckpointResult = { written: false; reason: string } | { written: true; relPath: string; findings: ScrubFinding[] };

function pickConversation(list: readonly Conversation[], sessionId: unknown): Conversation | undefined {
  if (typeof sessionId === 'string') {
    const exact = list.find((c) => c.conversationId === sessionId);
    if (exact !== undefined) return exact;
  }
  return list[list.length - 1];
}

function block(text: string): string {
  const f = fenceFor(text);
  return `${f}text\n${text}\n${f}`;
}

/** Load the transcript text if (and only if) the path resolves to a regular file under `projectsDir`. */
function readTranscript(projectsDir: string, transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath === '' || transcriptPath.includes('\0') || !path.isAbsolute(transcriptPath)) return undefined;
  try {
    const root = resolveInRoot(projectsDir, '');
    const file = openExternalFile(transcriptPath, [root]);
    try {
      if (file.stat.size > MAX_SOURCE_FILE_BYTES) return undefined;
      const d = decodeNote(file.readBuffer());
      return d.invalidUtf8 ? undefined : d.text;
    } finally {
      file.close();
    }
  } catch (err) {
    if (err instanceof SafePathError || (err as NodeJS.ErrnoException).code !== undefined) return undefined;
    throw err;
  }
}

/** Write one checkpoint proposal, or report why nothing was written. */
export function writeCheckpoint(input: CheckpointInput): CheckpointResult {
  const text = readTranscript(input.projectsDir, input.transcriptPath);
  if (text === undefined) return { written: false, reason: 'transcript not readable' };
  const collector = new ClaudeCodeCollector();
  collector.addFile(text, 'checkpoint');
  const conv = pickConversation(collector.conversations(), input.sessionId);
  const users = (conv?.turns ?? []).filter((t) => t.role === 'user');
  if (conv === undefined || users.length === 0) return { written: false, reason: 'no user turns' };

  const findings: ScrubFinding[][] = [];
  const clean = (s: string, max: number): string => {
    const r = scrub(truncateText(s, max), { extraPatterns: input.extraPatterns });
    if (!r.ok) throw new Error('unexpected scrub rejection');
    findings.push(r.findings);
    return r.text;
  };
  const opening = clean(users[0]!.text, OPENING_MAX_CHARS);
  const recent = users.slice(1).slice(-CHECKPOINT_RECENT_TURNS).map((t) => clean(t.text, TURN_MAX_CHARS));

  const now = (input.now ?? (() => new Date()))();
  const firstLine = cleanTitle(opening.split('\n')[0] ?? '');
  const title = cleanTitle(`${TITLE_PREFIX}: ${truncateText(firstLine, 80)}`);
  const body = [
    'Extractive checkpoint written before a Claude Code compaction. User turns only; unreviewed.',
    '',
    '## Opening request',
    block(opening),
    ...(recent.length === 0 ? [] : ['', '## Recent user turns', ...recent.flatMap((t, i) => [`${i === 0 ? '' : '\n'}${block(t)}`])]),
  ].join('\n');
  const note = renderProposal(
    {
      id: ulid(now.getTime()), title, kind: 'raw', created: isoSeconds(now), origin: 'hook', author: input.principalId, sources: [],
      scrubVersion, untrustedOrigin: true,
    },
    body,
  );
  const written = writeInboxFile(input.vaultPath, toSlug(title), now, note);
  const counts = new Map<string, number>();
  for (const f of findings.flat()) counts.set(f.type, (counts.get(f.type) ?? 0) + f.count);
  return { written: true, relPath: written.relPath, findings: [...counts].map(([type, count]) => ({ type, count }) as ScrubFinding) };
}
