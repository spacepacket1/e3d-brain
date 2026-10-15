// Phase 10 fixtures: small synthetic Claude Code transcripts, a Claude.ai
// export, a ChatGPT export, and hostile zip archives. Fake secrets are
// assembled at runtime (tests/scrub-fixtures.ts) so the repository holds no
// scanner-triggering literal. Run directly to materialize them for the shell
// test: `node dist/tests/conversation-fixtures.js <dir>` prints a JSON
// manifest.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fake } from './scrub-fixtures.js';
import { buildZip, type ZipEntrySpec } from './zip-writer.js';

export const CODE_SESSION_A = '0b8a3c1e-5f6d-4e7a-9b8c-1d2e3f4a5b6c';
export const CODE_SESSION_B = '7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f';

export interface FixtureManifest {
  projectsDir: string;
  claudeExportDir: string;
  claudeExportZip: string;
  chatgptExportZip: string;
  hostile: { zipSlip: string; absolute: string; backslash: string; oversized: string; tooMany: string; bomb: string };
  /** Fake secrets planted in the fixtures (must never reach the vault). */
  secrets: string[];
  expected: Record<'claude-code' | 'claude-export' | 'chatgpt-export', { conversations: number; turns: number; malformed: number }>;
  /** Conversation start (occurred) per source and conversation id. */
  starts: Record<string, string>;
}

const jsonl = (records: readonly unknown[]): string => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

function claudeCode(dir: string, secrets: string[]): void {
  const aws = fake.awsId();
  const openai = fake.openai();
  secrets.push(aws, openai);
  const base = { cwd: '/home/u/proj', version: '2.1.0', gitBranch: 'main', userType: 'external' };
  const a = (extra: Record<string, unknown>) => ({ ...base, sessionId: CODE_SESSION_A, isSidechain: false, ...extra });
  const projA = path.join(dir, '-home-u-proj');
  fs.mkdirSync(projA, { recursive: true });
  fs.writeFileSync(
    path.join(projA, `${CODE_SESSION_A}.jsonl`),
    jsonl([
      { type: 'summary', summary: 'Deploying the service', leafUuid: 'x1' },
      a({ type: 'user', isMeta: true, timestamp: '2026-03-01T09:59:00.000Z', message: { role: 'user', content: 'Caveat: local commands below' } }),
      a({ type: 'user', timestamp: '2026-03-01T09:59:30.000Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      a({ type: 'user', timestamp: '2026-03-01T10:00:00.000Z', message: { role: 'user', content: `Please help deploy. My key id is ${aws} for now.` } }),
      a({
        type: 'assistant', timestamp: '2026-03-01T10:00:05.000Z',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'secret plan thoughts' }, { type: 'text', text: 'Sure, first rotate that key.' }] },
      }),
      a({ type: 'assistant', timestamp: '2026-03-01T10:00:06.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
      a({ type: 'user', timestamp: '2026-03-01T10:00:07.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tool output text' }] } }),
      a({ type: 'assistant', timestamp: '2026-03-01T10:00:08.000Z', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Deployment finished.' }] } }),
      '{not json at all',
      '[1, 2, 3]',
      a({ type: 'user', timestamp: '2026-03-01T10:01:00.000Z', futureField: { nested: true }, message: { role: 'user', content: [{ type: 'text', text: 'Thanks, codecheckmarker.' }], extra: 1 } }),
      a({ type: 'assistant', isSidechain: true, timestamp: '2026-03-01T10:01:01.000Z', message: { id: 'msg_s', role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
      { type: 'file-history-snapshot', messageId: 'z', snapshot: {} },
    ]),
  );
  const projB = path.join(dir, '-home-u-other');
  fs.mkdirSync(path.join(projB, CODE_SESSION_B, 'subagents'), { recursive: true });
  const b = (extra: Record<string, unknown>) => ({ ...base, sessionId: CODE_SESSION_B, ...extra });
  fs.writeFileSync(
    path.join(projB, `${CODE_SESSION_B}.jsonl`),
    jsonl([
      b({ type: 'user', timestamp: '2025-12-31T23:50:00Z', message: { role: 'user', content: 'What is the release plan?' } }),
      b({ type: 'assistant', timestamp: '2025-12-31T23:51:00Z', message: { id: 'msg_b1', role: 'assistant', content: [{ type: 'text', text: `Use the token ${openai} only in CI.` }] } }),
    ]),
  );
  fs.writeFileSync(
    path.join(projB, CODE_SESSION_B, 'subagents', 'agent-1.jsonl'),
    jsonl([b({ type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'side' }] } })]),
  );
  // A session with only meta frames produces no conversation.
  fs.writeFileSync(path.join(projB, 'meta-only.jsonl'), jsonl([{ type: 'user', isMeta: true, sessionId: 'meta-only', message: { role: 'user', content: 'x' } }]));
}

function claudeExportJson(secrets: string[]): string {
  const gh = fake.github();
  secrets.push(gh);
  return JSON.stringify([
    {
      uuid: 'c1a2b3c4-0000-4000-8000-000000000001', name: 'Planning session', created_at: '2026-02-10T08:00:00.000000Z', updated_at: '2026-02-10T09:00:00Z',
      account: { uuid: 'acct' },
      chat_messages: [
        { uuid: 'm1', sender: 'human', text: 'ignored when content exists', created_at: '2026-02-10T08:00:10Z', content: [{ type: 'text', text: `My token is ${gh}, keep it safe. exportmarker` }] },
        {
          uuid: 'm2', sender: 'assistant', created_at: '2026-02-10T08:00:20Z',
          content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'tool_use', name: 'web_search', input: {} }, { type: 'text', text: 'Noted; revoke it.' }],
        },
      ],
    },
    {
      uuid: 'c1a2b3c4-0000-4000-8000-000000000002', name: '', created_at: '2026-02-11T08:00:00Z', updated_at: '2026-02-11T08:05:00Z',
      chat_messages: [
        { sender: 'human', text: 'Older export format, text only.', created_at: '2026-02-11T08:00:01Z' },
        { sender: 'assistant', text: 'Reply one.', created_at: '2026-02-11T08:00:02Z' },
        { sender: 'human', text: 'Follow-up.', created_at: '2026-02-11T08:00:03Z' },
      ],
    },
    { uuid: 'c1a2b3c4-0000-4000-8000-000000000003', name: 'Empty', created_at: '2026-02-12T08:00:00Z', chat_messages: [] },
    42,
    { name: 'no uuid', chat_messages: [] },
  ]);
}

function chatgptExportJson(secrets: string[]): string {
  const stripe = fake.stripe();
  secrets.push(stripe);
  const msg = (id: string, role: string, parts: unknown[], t: number, extra: Record<string, unknown> = {}) => ({
    id, author: { role }, create_time: t, content: { content_type: 'text', parts }, metadata: {}, recipient: 'all', ...extra,
  });
  const t0 = 1767225600; // 2026-01-01T00:00:00Z
  return JSON.stringify([
    {
      id: 'g1', conversation_id: '6a7b8c9d-0000-4000-8000-0000000000a1', title: 'Budget review', create_time: t0, update_time: t0 + 600,
      current_node: 'n7',
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['n1'] },
        n1: { id: 'n1', parent: 'root', children: ['n2'], message: msg('n1', 'system', ['You are ChatGPT'], t0, { metadata: { is_visually_hidden_from_conversation: true } }) },
        n2: { id: 'n2', parent: 'n1', children: ['n3', 'alt'], message: msg('n2', 'user', ['Review the budget. chatgptmarker'], t0 + 10) },
        alt: { id: 'alt', parent: 'n2', children: [], message: msg('alt', 'assistant', ['abandoned branch'], t0 + 11) },
        n3: { id: 'n3', parent: 'n2', children: ['n4'], message: msg('n3', 'assistant', ['search("budget")'], t0 + 12, { recipient: 'browser', content: { content_type: 'code', text: 'x' } }) },
        n4: { id: 'n4', parent: 'n3', children: ['n5'], message: msg('n4', 'tool', ['tool result'], t0 + 13) },
        n5: { id: 'n5', parent: 'n4', children: ['n6'], message: msg('n5', 'assistant', ['The budget looks fine.', { asset_pointer: 'file-x' }], t0 + 14) },
        n6: { id: 'n6', parent: 'n5', children: ['n7'], message: msg('n6', 'user', [`Charge it with ${stripe} please.`], t0 + 20) },
        n7: { id: 'n7', parent: 'n6', children: [], message: msg('n7', 'assistant', ['Never share that key.'], t0 + 30) },
      },
    },
    {
      id: '6a7b8c9d-0000-4000-8000-0000000000a2', title: 'Quick question', create_time: t0 + 86400, update_time: t0 + 86500,
      mapping: {
        r: { id: 'r', message: null, parent: null, children: ['q'] },
        q: { id: 'q', parent: 'r', children: ['th'], message: msg('q', 'user', ['How long is a year?'], t0 + 86410) },
        th: { id: 'th', parent: 'q', children: ['ans'], message: { ...msg('th', 'assistant', [], t0 + 86411), content: { content_type: 'thoughts', thoughts: [] } } },
        ans: { id: 'ans', parent: 'th', children: [], message: msg('ans', 'assistant', ['About 365 days.'], t0 + 86420) },
      },
    },
    { title: 'missing id', mapping: {} },
  ]);
}

export function writeConversationFixtures(dir: string): FixtureManifest {
  const secrets: string[] = [];
  const projectsDir = path.join(dir, 'projects');
  claudeCode(projectsDir, secrets);
  const claudeExportDir = path.join(dir, 'claude-export');
  fs.mkdirSync(claudeExportDir, { recursive: true });
  const claudeJson = claudeExportJson(secrets);
  fs.writeFileSync(path.join(claudeExportDir, 'conversations.json'), claudeJson);
  fs.writeFileSync(path.join(claudeExportDir, 'users.json'), '[]');
  const claudeExportZip = path.join(dir, 'claude-export.zip');
  fs.writeFileSync(claudeExportZip, buildZip([{ name: 'conversations.json', data: claudeJson }, { name: 'users.json', data: '[]' }, { name: 'projects/', data: '', method: 0 }]));
  const chatgptExportZip = path.join(dir, 'chatgpt-export.zip');
  fs.writeFileSync(
    chatgptExportZip,
    buildZip([{ name: 'conversations.json', data: chatgptExportJson(secrets) }, { name: 'chat.html', data: '<html></html>' }, { name: 'file-x.png', data: Buffer.alloc(64), method: 0 }]),
  );

  const hostileDir = path.join(dir, 'hostile');
  fs.mkdirSync(hostileDir, { recursive: true });
  const write = (name: string, entries: ZipEntrySpec[]): string => {
    const p = path.join(hostileDir, name);
    fs.writeFileSync(p, buildZip(entries));
    return p;
  };
  const ok: ZipEntrySpec = { name: 'conversations.json', data: '[]' };
  const tooMany: ZipEntrySpec[] = [ok];
  for (let i = 0; i < 50_000; i++) tooMany.push({ name: `f/${i}.txt`, data: '', method: 0 });
  const hostile = {
    zipSlip: write('zip-slip.zip', [ok, { name: '../../evil.md', data: 'evil' }]),
    absolute: write('absolute.zip', [ok, { name: '/tmp/evil.md', data: 'evil' }]),
    backslash: write('backslash.zip', [ok, { name: '..\\..\\evil.md', data: 'evil' }]),
    oversized: write('oversized.zip', [{ name: 'conversations.json', data: '[]', declaredSize: 600 * 1024 * 1024 }]),
    tooMany: write('too-many.zip', tooMany),
    // Real data that inflates to 4 MB while the header claims 2 bytes.
    bomb: write('bomb.zip', [{ name: 'conversations.json', data: Buffer.alloc(4 * 1024 * 1024, 0x20), declaredSize: 2 }]),
  };
  return {
    projectsDir,
    claudeExportDir,
    claudeExportZip,
    chatgptExportZip,
    hostile,
    secrets,
    expected: {
      'claude-code': { conversations: 2, turns: 6, malformed: 2 },
      'claude-export': { conversations: 2, turns: 5, malformed: 2 },
      'chatgpt-export': { conversations: 2, turns: 6, malformed: 1 },
    },
    starts: {
      [`claude-code/${CODE_SESSION_A}`]: '2026-03-01T10:00:00Z',
      [`claude-code/${CODE_SESSION_B}`]: '2025-12-31T23:50:00Z',
      'claude-export/c1a2b3c4-0000-4000-8000-000000000001': '2026-02-10T08:00:00Z',
      'claude-export/c1a2b3c4-0000-4000-8000-000000000002': '2026-02-11T08:00:00Z',
      'chatgpt-export/6a7b8c9d-0000-4000-8000-0000000000a1': '2026-01-01T00:00:00Z',
      'chatgpt-export/6a7b8c9d-0000-4000-8000-0000000000a2': '2026-01-02T00:00:00Z',
    },
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write('usage: conversation-fixtures.js <dir>\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(writeConversationFixtures(dir))}\n`);
}
