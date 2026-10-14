// Child process for the audit concurrency test (not a test file itself).
//   node audit-worker.js <stateDir> <maxSegmentBytes> <calls> <tag>
// Makes `calls` tool calls through dispatch with an audit log, then exits.

import { AuditLog } from '../src/audit/audit.js';
import { dispatch, registerTool, ToolRegistry, type DispatchContext } from '../src/mcp/dispatch.js';
import { resolveInState } from '../src/safe-path.js';

const [stateDirRaw, maxBytes, calls, tag] = process.argv.slice(2);
const stateDir = resolveInState(stateDirRaw!, '');
const registry = new ToolRegistry();
registerTool(
  {
    name: 'fake_read',
    modes: ['inbox', 'journal', 'read-only'],
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    auditArgs: { path: 'path' },
    handler: () => ({ content: 'ok', recall_id: 'R1', returned: [{ id: '01JALPHA0000000000000000AA', rev: '0123456789abcdef' }] }),
  },
  registry,
);
const audit = new AuditLog(stateDir, { maxSegmentBytes: Number(maxBytes), lockWaitMs: 30_000 });
const ctx: DispatchContext = { mode: 'inbox', principal: { id: 'tester', type: 'human' }, maxCharsPerCall: 10000, registry, audit };
for (let i = 0; i < Number(calls); i++) {
  const res = await dispatch(ctx, 'fake_read', { path: `${tag}/note-${i}-${'x'.repeat(100)}.md` });
  if (res.isError) throw new Error('call failed');
}
