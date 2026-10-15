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
  { name: 'report_use', modes: ['inbox', 'journal', 'read-only'], phase: 'cog-8' },
];

describe('tool registry fixture', () => {
  it('parses and validates', () => {
    assert.ok(Array.isArray(loadToolRegistry()));
  });

  it(`no tools exist yet at phase ${PHASE} in any mode`, () => {
    for (const mode of TOOL_MODES) assert.deepEqual(expectedTools(mode, PHASE), []);
  });

  it('expectedTools filters by mode and phase and sorts', () => {
    assert.deepEqual(expectedTools('inbox', 5, 0, SAMPLE), []);
    assert.deepEqual(expectedTools('inbox', 6, 0, SAMPLE), ['search']);
    assert.deepEqual(expectedTools('read-only', 8, 0, SAMPLE), ['search']);
    assert.deepEqual(expectedTools('inbox', 8, 0, SAMPLE), ['capture', 'list_inbox', 'search']);
    assert.deepEqual(expectedTools('journal', 9, 0, SAMPLE), ['journal_append', 'search']);
    assert.deepEqual(expectedTools('inbox', 9, 0, SAMPLE), ['capture', 'list_inbox', 'search']);
    assert.deepEqual(expectedTools('read-only', 15, 0, SAMPLE), ['read_ref_chunk', 'search']);
    assert.deepEqual(expectedTools('journal', 15, 0, SAMPLE), ['journal_append', 'read_ref_chunk', 'search']);
  });

  it('cognition entries are namespaced: memory-phase assertions never include them', () => {
    for (const mode of TOOL_MODES) {
      assert.ok(!expectedTools(mode, 15).includes('report_use'));
      assert.ok(!expectedTools(mode, 99).includes('report_use'));
      assert.ok(!expectedTools(mode, 15, 7).includes('report_use'));
      assert.ok(expectedTools(mode, 0, 8).includes('report_use'));
      assert.ok(expectedTools(mode, 15, 8).includes('report_use'));
    }
    assert.deepEqual(expectedTools('read-only', 15, 8, SAMPLE), ['read_ref_chunk', 'report_use', 'search']);
    assert.deepEqual(expectedTools('read-only', 0, 8, SAMPLE), ['report_use']);
    const real = loadToolRegistry().find((e) => e.name === 'report_use')!;
    assert.equal(real.phase, 'cog-8');
    assert.deepEqual([...real.modes].sort(), ['inbox', 'journal', 'read-only']);
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
      [{ name: 'x', modes: ['inbox'], phase: 'cog-0' }],
      [{ name: 'x', modes: ['inbox'], phase: 'cog-8x' }],
      [{ name: 'x', modes: ['inbox'], phase: 'cog8' }],
      [{ name: 'x', modes: ['inbox'], phase: '8' }],
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
