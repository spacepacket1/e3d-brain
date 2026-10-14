// Phase 4: the tool registry fixture and its helper, and the forbidden-name rule.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_TOOL_NAME } from '../src/mcp/dispatch.js';
import { expectedTools, loadToolRegistry, parseToolRegistry, TOOL_MODES, type ToolEntry } from './tool-registry.js';

const PHASE = 4;
const FORBIDDEN = /accept|promote|edit|delete|move|overwrite|run|job|start/;

// A synthetic registry exercising the helper's phase and mode filters.
const SAMPLE: ToolEntry[] = [
  { name: 'search', modes: ['inbox', 'journal', 'read-only'], phase: 6 },
  { name: 'capture', modes: ['inbox'], phase: 8 },
  { name: 'journal_append', modes: ['journal'], phase: 9 },
  { name: 'read_ref_chunk', modes: ['inbox', 'journal', 'read-only'], phase: 11 },
  { name: 'list_inbox', modes: ['inbox'], phase: 8 },
];

describe('tool registry fixture', () => {
  it('parses and validates', () => {
    assert.ok(Array.isArray(loadToolRegistry()));
  });

  it(`no tools exist yet at phase ${PHASE} in any mode`, () => {
    for (const mode of TOOL_MODES) assert.deepEqual(expectedTools(mode, PHASE), []);
  });

  it('expectedTools filters by mode and phase and sorts', () => {
    assert.deepEqual(expectedTools('inbox', 5, SAMPLE), []);
    assert.deepEqual(expectedTools('inbox', 6, SAMPLE), ['search']);
    assert.deepEqual(expectedTools('read-only', 8, SAMPLE), ['search']);
    assert.deepEqual(expectedTools('inbox', 8, SAMPLE), ['capture', 'list_inbox', 'search']);
    assert.deepEqual(expectedTools('journal', 9, SAMPLE), ['journal_append', 'search']);
    assert.deepEqual(expectedTools('inbox', 9, SAMPLE), ['capture', 'list_inbox', 'search']);
    assert.deepEqual(expectedTools('read-only', 15, SAMPLE), ['read_ref_chunk', 'search']);
    assert.deepEqual(expectedTools('journal', 15, SAMPLE), ['journal_append', 'read_ref_chunk', 'search']);
  });

  it('rejects malformed registries', () => {
    const bad: unknown[] = [
      {},
      [{ name: 'x', modes: ['inbox'] }],
      [{ name: 'x', modes: ['inbox'], phase: 6, extra: 1 }],
      [{ name: 'x', modes: ['admin'], phase: 6 }],
      [{ name: 'x', modes: [], phase: 6 }],
      [{ name: 'x', modes: ['inbox', 'inbox'], phase: 6 }],
      [{ name: 'x', modes: ['inbox'], phase: 6.5 }],
      [{ name: 'Bad-Name', modes: ['inbox'], phase: 6 }],
      [{ name: 'x', modes: ['inbox'], phase: 6 }, { name: 'x', modes: ['journal'], phase: 9 }],
    ];
    for (const b of bad) assert.throws(() => parseToolRegistry(b), JSON.stringify(b));
  });

  it('no tool name in any mode matches the forbidden pattern', () => {
    assert.equal(FORBIDDEN_TOOL_NAME.source, FORBIDDEN.source);
    for (const entry of loadToolRegistry()) {
      assert.ok(!FORBIDDEN.test(entry.name), `forbidden tool name "${entry.name}"`);
    }
    for (const entry of SAMPLE) assert.ok(!FORBIDDEN.test(entry.name));
    for (const name of ['accept_note', 'promote', 'edit_note', 'delete_note', 'move_note', 'overwrite', 'run_job', 'start']) {
      assert.ok(FORBIDDEN.test(name), name);
    }
  });
});
