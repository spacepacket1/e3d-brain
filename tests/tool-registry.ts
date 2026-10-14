// The MCP tool registry fixture, tests/fixtures/tools-by-mode.json, is the
// single source of truth for tool names (Phase 4). Each entry is
// {name, modes, phase}; every phase's tool-list assertion calls
// expectedTools(mode, <that phase's number>) instead of hardcoding a list, and
// a phase that adds a tool adds its entry in the same change.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers.js';

export type ToolMode = 'inbox' | 'journal' | 'read-only';
export const TOOL_MODES: readonly ToolMode[] = ['inbox', 'journal', 'read-only'];

export interface ToolEntry {
  name: string;
  modes: ToolMode[];
  /** The phase that introduces the tool. */
  phase: number;
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
    if (typeof phase !== 'number' || !Number.isInteger(phase) || phase < 1 || phase > 15) throw new Error(`tool "${name}": bad phase`);
    return { name, modes: modes as ToolMode[], phase };
  });
}

export function loadToolRegistry(): ToolEntry[] {
  const file = path.join(repoRoot(), 'tests', 'fixtures', 'tools-by-mode.json');
  return parseToolRegistry(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}

/** Tool names expected in `mode` once phases 1..upToPhase are in place, sorted bytewise. */
export function expectedTools(mode: ToolMode, upToPhase: number, entries: readonly ToolEntry[] = loadToolRegistry()): string[] {
  return entries
    .filter((e) => e.phase <= upToPhase && e.modes.includes(mode))
    .map((e) => e.name)
    .sort();
}
