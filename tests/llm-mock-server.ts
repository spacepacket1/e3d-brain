// A mock LLM server on loopback for Phase 14 tests. It answers both
// OpenAI-compatible `/chat/completions` and Anthropic `/v1/messages`
// requests. Candidates are derived deterministically from the transcript in
// the request: every transcript line containing "decided", "prefer",
// "lesson", or "idea" becomes one candidate quoting that line. Each reply
// also carries one schema-invalid item and one item whose quote is not in
// the transcript, so dropping and counting is exercised on every call.
//
// Run directly (`node dist/tests/llm-mock-server.js <requests-log>`) it
// prints its port on the first line, appends every raw request body to the
// log, and serves until killed. Mode `garbage` (env LLM_MOCK_MODE) replies
// with non-JSON text.

import * as fs from 'node:fs';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

export type MockMode = 'normal' | 'garbage' | 'error';

export interface CapturedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface LlmMock {
  url: string;
  requests: CapturedRequest[];
  mode: MockMode;
  close(): Promise<void>;
}

const KINDS: [RegExp, string][] = [
  [/\bdecided\b/i, 'decision'],
  [/\bprefer\b/i, 'preference'],
  [/\blesson\b/i, 'lesson'],
  [/\bidea\b/i, 'idea'],
];

/** The JSON reply text for a user message holding a `Turn <n> (<role>):` transcript. */
export function mockReply(user: string): string {
  const candidates: unknown[] = [];
  let turn = 0;
  let firstTurn = 0;
  for (const line of user.split('\n')) {
    const m = /^Turn (\d+) \((?:user|assistant)\):$/.exec(line);
    if (m !== null) {
      turn = Number(m[1]);
      if (firstTurn === 0) firstTurn = turn;
      continue;
    }
    if (turn === 0 || line.startsWith('```')) continue;
    const kind = KINDS.find(([re]) => re.test(line))?.[1];
    if (kind === undefined) continue;
    const quote = line.trim().slice(0, 200);
    candidates.push({ kind, title: `${kind}: ${quote.slice(0, 60)}`, statement: quote, quote, turn_start: turn, turn_end: turn });
  }
  if (firstTurn !== 0) {
    candidates.push({ kind: 'fact', title: 'bad kind', statement: 'x', quote: 'x', turn_start: firstTurn, turn_end: firstTurn });
    candidates.push({ kind: 'idea', title: 'Invented', statement: 'Never said.', quote: 'this sentence appears nowhere in the transcript', turn_start: firstTurn, turn_end: firstTurn });
  }
  return JSON.stringify({ candidates });
}

function userText(pathName: string, body: unknown): string {
  const msgs = (body as { messages?: { role: string; content: string }[] }).messages ?? [];
  return msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
}

export function startLlmMock(onRequest?: (r: CapturedRequest) => void): Promise<LlmMock> {
  const requests: CapturedRequest[] = [];
  const state: { mode: MockMode } = { mode: 'normal' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const captured = { path: req.url ?? '', headers: req.headers, body: raw };
      requests.push(captured);
      onRequest?.(captured);
      if (state.mode === 'error') {
        res.writeHead(500).end('boom');
        return;
      }
      const body = JSON.parse(raw) as unknown;
      const text = state.mode === 'garbage' ? 'Sure! Here are some notes: decided things.' : mockReply(userText(req.url ?? '', body));
      const reply =
        req.url === '/v1/messages'
          ? { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
          : { id: 'c1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const mock: LlmMock = {
        url: `http://127.0.0.1:${port}`,
        requests,
        get mode() {
          return state.mode;
        },
        set mode(m: MockMode) {
          state.mode = m;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      };
      resolve(mock);
    });
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const log = process.argv[2];
  void startLlmMock((r) => {
    if (log !== undefined) fs.appendFileSync(log, `${r.body}\n`);
  }).then((m) => {
    m.mode = (process.env['LLM_MOCK_MODE'] as MockMode | undefined) ?? 'normal';
    console.log(new URL(m.url).port);
  });
}
