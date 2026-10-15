// The MCP tool registry fixture, tests/fixtures/tools-by-mode.json, is the
// single source of truth for tool names (Phase 4). Each entry is
// {name, modes, phase}; every phase's tool-list assertion calls
// expectedTools(mode, <that phase's number>) instead of hardcoding a list, and
// a phase that adds a tool adds its entry in the same change. A memory phase
// is a number (1-15); a cognition phase is namespaced, `cog-<n>`, so the two
// numbering schemes never collide: expectedTools(mode, memoryPhase,
// cognitionPhase) counts memory entries up to the first and cognition
// entries up to the second (default 0: none), and a memory-phase assertion
// therefore never includes a cognition tool.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers.js';

export type ToolMode = 'inbox' | 'journal' | 'read-only';
export const TOOL_MODES: readonly ToolMode[] = ['inbox', 'journal', 'read-only'];

export interface ToolEntry {
  name: string;
  modes: ToolMode[];
  /** The phase that introduces the tool: a memory phase number, or `cog-<n>` for a cognition phase. */
  phase: number | string;
}

const COG_PHASE_RE = /^cog-([1-9][0-9]?)$/;

/** Memory phase number of an entry, or undefined for a cognition entry. */
export function memoryPhaseOf(e: ToolEntry): number | undefined {
  return typeof e.phase === 'number' ? e.phase : undefined;
}

/** Cognition phase number of an entry, or undefined for a memory entry. */
export function cognitionPhaseOf(e: ToolEntry): number | undefined {
  return typeof e.phase === 'string' ? Number(COG_PHASE_RE.exec(e.phase)![1]) : undefined;
}

/** Parse and validate a registry (fails on unknown keys, bad modes, duplicates). */
export function parseToolRegistry(raw: unknown): ToolEntry[] {
  if (!Array.isArray(raw)) throw new Error('tool registry must be an array');
  const seen = new Set<string>();
  return raw.map((e: unknown, i) => {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) throw new Error(`entry ${i} must be an object`);
    const entry = e as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    if (keys.join(',') !== 'modes,name,phase') throw new Error(`entry ${i} must have exactly name, modes, phase`);
    const { name, modes, phase } = entry;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`entry ${i}: bad name`);
    if (seen.has(name)) throw new Error(`duplicate tool "${name}"`);
    seen.add(name);
    if (!Array.isArray(modes) || modes.length === 0 || !modes.every((m) => (TOOL_MODES as readonly unknown[]).includes(m))) {
      throw new Error(`tool "${name}": bad modes`);
    }
    if (new Set(modes).size !== modes.length) throw new Error(`tool "${name}": duplicate modes`);
    const memory = typeof phase === 'number' && Number.isInteger(phase) && phase >= 1 && phase <= 15;
    if (!memory && !(typeof phase === 'string' && COG_PHASE_RE.test(phase))) throw new Error(`tool "${name}": bad phase`);
    return { name, modes: modes as ToolMode[], phase: phase as number | string };
  });
}

export function loadToolRegistry(): ToolEntry[] {
  const file = path.join(repoRoot(), 'tests', 'fixtures', 'tools-by-mode.json');
  return parseToolRegistry(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}

/**
 * Tool names expected in `mode` once memory phases 1..upToMemoryPhase and
 * cognition phases 1..upToCognitionPhase (default 0: none) are in place,
 * sorted bytewise.
 */
export function expectedTools(
  mode: ToolMode,
  upToMemoryPhase: number,
  upToCognitionPhase = 0,
  entries: readonly ToolEntry[] = loadToolRegistry(),
): string[] {
  return entries
    .filter((e) => {
      const m = memoryPhaseOf(e);
      const c = cognitionPhaseOf(e);
      return (m !== undefined && m <= upToMemoryPhase) || (c !== undefined && c <= upToCognitionPhase);
    })
    .filter((e) => e.modes.includes(mode))
    .map((e) => e.name)
    .sort();
}

/**
 * For an earlier memory phase's tool-list test once later phases have added
 * tools: `listed` includes every tool of memory phases 1..phase for `mode`,
 * and anything else it lists is a later registry tool of that mode (a later
 * memory phase, or any cognition phase). Returns a problem description, or
 * undefined.
 */
export function checkToolsSincePhase(listed: readonly string[], mode: ToolMode, phase: number, entries: readonly ToolEntry[] = loadToolRegistry()): string | undefined {
  const expected = expectedTools(mode, phase, 0, entries);
  const missing = expected.filter((n) => !listed.includes(n));
  if (missing.length > 0) return `missing phase-${phase} tools: ${missing.join(', ')}`;
  const later = new Set(entries.filter((e) => !expected.includes(e.name) && e.modes.includes(mode)).map((e) => e.name));
  const stray = listed.filter((n) => !expected.includes(n) && !later.has(n));
  return stray.length > 0 ? `tools not in the registry for ${mode}: ${stray.join(', ')}` : undefined;
}
