// Conversation parsers (Phase 10). Pure: bytes in, conversations out; no I/O.
//
// Only real human and assistant text is kept. Meta frames (`isMeta`, slash
// command wrappers, local command output, system reminders, interruptions),
// sidechains (subagent transcripts), tool calls and tool results, thinking
// and reasoning blocks, hidden and system messages are dropped. Unknown
// fields are ignored. Malformed JSONL lines and malformed conversation
// records are counted and skipped (I10), never fatal.

export const CONVERSATION_SOURCES = ['claude-code', 'claude-export', 'chatgpt-export'] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

export type TurnRole = 'user' | 'assistant';

export interface Turn {
  role: TurnRole;
  text: string;
  /** ISO 8601 UTC, second precision, when the source gives a valid time. */
  at?: string;
}

export interface Conversation {
  source: ConversationSource;
  /** The source's own conversation id (validated by CONVERSATION_ID_RE). */
  conversationId: string;
  title?: string;
  /** Source-level creation and update times (ISO seconds), when given. */
  created?: string;
  updated?: string;
  turns: Turn[];
}

export interface ParseStats {
  /** JSONL lines that are not a JSON object. */
  malformedLines: number;
  /** Records skipped as meta frames, sidechains, tool traffic, or non-text. */
  skippedFrames: number;
  /** Conversation records without a usable id or shape. */
  malformedConversations: number;
}

export function emptyStats(): ParseStats {
  return { malformedLines: 0, skippedFrames: 0, malformedConversations: 0 };
}

/** A conversation id usable in frontmatter and as hash input: ordinary id characters only. */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** ISO seconds (UTC) from an ISO string or epoch seconds, else undefined. */
export function toIso(v: unknown): string | undefined {
  let ms: number;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v * 1000;
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) ms = Date.parse(v);
  else return undefined;
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (y < 1970 || y > 9999) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Wrappers Claude Code writes as user frames that are not human text. */
const META_TEXT_RE =
  /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-memory-input)>|\[Request interrupted by user)/;
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(SYSTEM_REMINDER_RE, '').trim();
}

/** Text blocks (`{type: 'text', text}`) of a content array, joined; thinking, tool_use, tool_result, images dropped. */
function textBlocks(content: readonly unknown[]): string {
  return content
    .filter((b): b is Obj => isObj(b) && b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n\n');
}

function pushTurn(turns: Turn[], role: TurnRole, text: string, at: string | undefined): void {
  const t: Turn = { role, text };
  if (at !== undefined) t.at = at;
  turns.push(t);
}

// ---- Claude Code JSONL ----

interface CodeSession {
  turns: Turn[];
  title?: string;
  /** message.id of the last assistant turn, to merge streamed blocks of one message. */
  lastAssistantId?: string;
}

/** Accumulates Claude Code sessions across transcript files (keyed by `sessionId`). */
export class ClaudeCodeCollector {
  private readonly sessions = new Map<string, CodeSession>();
  readonly stats: ParseStats = emptyStats();

  /** Add one JSONL file. `fallbackId` (the file stem) is used for lines without a `sessionId`. */
  addFile(text: string, fallbackId: string): void {
    let summary: string | undefined;
    const touched = new Set<string>();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        this.stats.malformedLines++;
        continue;
      }
      if (!isObj(rec)) {
        this.stats.malformedLines++;
        continue;
      }
      const type = rec['type'];
      if (type === 'summary') {
        summary ??= str(rec['summary']);
        continue;
      }
      if (type !== 'user' && type !== 'assistant') {
        this.stats.skippedFrames++;
        continue;
      }
      if (rec['isMeta'] === true || rec['isSidechain'] === true || rec['isCompactSummary'] === true || rec['isApiErrorMessage'] === true) {
        this.stats.skippedFrames++;
        continue;
      }
      const sessionId = str(rec['sessionId']) ?? fallbackId;
      if (!CONVERSATION_ID_RE.test(sessionId)) {
        this.stats.malformedLines++;
        continue;
      }
      const msg = rec['message'];
      if (!isObj(msg)) {
        this.stats.malformedLines++;
        continue;
      }
      const role: TurnRole = type;
      const content = msg['content'];
      let text: string;
      if (typeof content === 'string') text = META_TEXT_RE.test(content) ? '' : cleanText(content);
      else if (Array.isArray(content)) text = cleanText(textBlocks(content));
      else {
        this.stats.malformedLines++;
        continue;
      }
      if (text === '' || (role === 'user' && META_TEXT_RE.test(text))) {
        this.stats.skippedFrames++;
        continue;
      }
      let session = this.sessions.get(sessionId);
      if (session === undefined) {
        session = { turns: [] };
        this.sessions.set(sessionId, session);
      }
      touched.add(sessionId);
      const at = toIso(rec['timestamp']);
      const msgId = str(msg['id']);
      const last = session.turns[session.turns.length - 1];
      if (role === 'assistant' && msgId !== undefined && last?.role === 'assistant' && session.lastAssistantId === msgId) {
        last.text = `${last.text}\n\n${text}`;
        continue;
      }
      pushTurn(session.turns, role, text, at);
      session.lastAssistantId = role === 'assistant' ? msgId : undefined;
    }
    if (summary !== undefined) {
      for (const id of touched) {
        const s = this.sessions.get(id)!;
        s.title ??= summary;
      }
    }
  }

  conversations(): Conversation[] {
    const out: Conversation[] = [];
    for (const [conversationId, s] of this.sessions) {
      const c: Conversation = { source: 'claude-code', conversationId, turns: s.turns };
      if (s.title !== undefined) c.title = s.title;
      out.push(c);
    }
    return out;
  }
}

// ---- Claude.ai export (conversations.json) ----

function parseRecords(json: string, stats: ParseStats): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('conversations JSON does not parse');
  }
  if (!Array.isArray(data)) throw new Error('conversations JSON is not an array');
  return data.filter((c) => {
    if (isObj(c)) return true;
    stats.malformedConversations++;
    return false;
  });
}

function withMeta(c: Conversation, title: unknown, created: unknown, updated: unknown): Conversation {
  const t = str(title);
  if (t !== undefined && t.trim() !== '') c.title = t;
  const cr = toIso(created);
  if (cr !== undefined) c.created = cr;
  const up = toIso(updated);
  if (up !== undefined) c.updated = up;
  return c;
}

/** Conversations from a Claude.ai data export's `conversations.json`. */
export function parseClaudeExport(json: string, stats: ParseStats): Conversation[] {
  const out: Conversation[] = [];
  for (const rec of parseRecords(json, stats) as Obj[]) {
    const id = str(rec['uuid']);
    const messages = rec['chat_messages'];
    if (id === undefined || !CONVERSATION_ID_RE.test(id) || !Array.isArray(messages)) {
      stats.malformedConversations++;
      continue;
    }
    const turns: Turn[] = [];
    for (const m of messages) {
      if (!isObj(m)) {
        stats.skippedFrames++;
        continue;
      }
      const sender = m['sender'];
      const role: TurnRole | undefined = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : undefined;
      const content = m['content'];
      const text = cleanText(Array.isArray(content) && content.length > 0 ? textBlocks(content) : (str(m['text']) ?? ''));
      if (role === undefined || text === '') {
        stats.skippedFrames++;
        continue;
      }
      pushTurn(turns, role, text, toIso(m['created_at']));
    }
    out.push(withMeta({ source: 'claude-export', conversationId: id, turns }, rec['name'], rec['created_at'], rec['updated_at']));
  }
  return out;
}

// ---- ChatGPT export (conversations.json) ----

/** Most nodes walked per conversation (guards cycles and absurd trees). */
const MAX_CHATGPT_NODES = 200_000;

/** The thread ending at `current_node` (or the last-child leaf), root first. */
function chatgptThread(mapping: Obj, current: unknown): Obj[] {
  let leaf = typeof current === 'string' && isObj(mapping[current]) ? current : undefined;
  if (leaf === undefined) {
    const root = Object.keys(mapping).find((k) => {
      const n = mapping[k];
      return isObj(n) && (n['parent'] === null || n['parent'] === undefined);
    });
    let at = root;
    for (let i = 0; at !== undefined && i < MAX_CHATGPT_NODES; i++) {
      const kids = (mapping[at] as Obj)['children'];
      const next = Array.isArray(kids) ? kids[kids.length - 1] : undefined;
      if (typeof next !== 'string' || !isObj(mapping[next])) break;
      at = next;
    }
    leaf = at;
  }
  const chain: Obj[] = [];
  const seen = new Set<string>();
  for (let id = leaf; id !== undefined && !seen.has(id) && chain.length < MAX_CHATGPT_NODES; ) {
    seen.add(id);
    const node = mapping[id];
    if (!isObj(node)) break;
    chain.push(node);
    const parent = node['parent'];
    id = typeof parent === 'string' ? parent : undefined;
  }
  return chain.reverse();
}

/** Conversations from a ChatGPT data export's `conversations.json`. */
export function parseChatgptExport(json: string, stats: ParseStats): Conversation[] {
  const out: Conversation[] = [];
  for (const rec of parseRecords(json, stats) as Obj[]) {
    const id = str(rec['conversation_id']) ?? str(rec['id']);
    const mapping = rec['mapping'];
    if (id === undefined || !CONVERSATION_ID_RE.test(id) || !isObj(mapping)) {
      stats.malformedConversations++;
      continue;
    }
    const turns: Turn[] = [];
    for (const node of chatgptThread(mapping, rec['current_node'])) {
      const m = node['message'];
      if (!isObj(m)) continue; // the synthetic root node has no message
      const author = isObj(m['author']) ? m['author']['role'] : undefined;
      const content = isObj(m['content']) ? m['content'] : undefined;
      const meta = isObj(m['metadata']) ? m['metadata'] : {};
      const ctype = content?.['content_type'];
      const role: TurnRole | undefined = author === 'user' ? 'user' : author === 'assistant' ? 'assistant' : undefined;
      const hidden = meta['is_visually_hidden_from_conversation'] === true || meta['is_user_system_message'] === true;
      const recipient = m['recipient'];
      if (role === undefined || hidden || (recipient !== undefined && recipient !== 'all') || (ctype !== 'text' && ctype !== 'multimodal_text')) {
        stats.skippedFrames++;
        continue;
      }
      const parts = Array.isArray(content?.['parts']) ? (content['parts'] as unknown[]) : [];
      const text = cleanText(parts.filter((p): p is string => typeof p === 'string').join('\n'));
      if (text === '') {
        stats.skippedFrames++;
        continue;
      }
      pushTurn(turns, role, text, toIso(m['create_time']));
    }
    out.push(withMeta({ source: 'chatgpt-export', conversationId: id, turns }, rec['title'], rec['create_time'], rec['update_time']));
  }
  return out;
}
