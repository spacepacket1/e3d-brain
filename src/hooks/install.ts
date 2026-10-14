// `ebrain hook install` / `remove` (Phase 13): edit only the entries ebrain
// owns in `~/.claude/settings.json`. An owned entry is a command hook whose
// command ends in ` hook <event> --ebrain-managed`; every other key and hook
// is carried through untouched (the file is re-serialized with the indent it
// already uses, so a file ebrain did not change is byte-identical).
//
// The command is `<absolute node binary> <absolute ebrain entry script> hook
// <event> --ebrain-managed`: nothing is looked up on PATH.

import * as os from 'node:os';
import * as path from 'node:path';
import { ensureOwnerDir, resolveInRoot, readExternalFile, SafePathError, writeAtomic } from '../safe-path.js';

export const MANAGED_FLAG = '--ebrain-managed';
/** Claude Code event name for each `ebrain hook <name>` subcommand. */
export const HOOK_EVENTS = { 'session-start': 'SessionStart', 'pre-compact': 'PreCompact' } as const;
export type HookName = keyof typeof HOOK_EVENTS;
/** Seconds Claude Code waits for the hook. */
export const HOOK_TIMEOUT_SECONDS = 20;

const OWNED_RE = /\shook (?:session-start|pre-compact) --ebrain-managed$/;
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024;

export class HookInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookInstallError';
  }
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface Entry {
  node: string;
  script: string;
}

/** The hook command for `name`. Both paths must be absolute. */
export function hookCommand(name: HookName, entry: Entry, quote: (s: string) => string): string {
  if (!path.isAbsolute(entry.node) || !path.isAbsolute(entry.script)) throw new HookInstallError('node binary and ebrain script must be absolute paths');
  return `${quote(entry.node)} ${quote(entry.script)} hook ${name} ${MANAGED_FLAG}`;
}

function isOwnedHook(h: unknown): boolean {
  return isObject(h) && h['type'] === 'command' && typeof h['command'] === 'string' && OWNED_RE.test(h['command']);
}

/** Remove owned hooks from `settings` in place. Returns how many were removed. */
function stripOwned(settings: Json): number {
  const hooks = settings['hooks'];
  if (!isObject(hooks)) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    let changed = false;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const inner = group['hooks'] as unknown[];
      const left = inner.filter((h) => !isOwnedHook(h));
      if (left.length === inner.length) kept.push(group);
      else {
        removed += inner.length - left.length;
        changed = true;
        if (left.length > 0) kept.push({ ...group, hooks: left });
      }
    }
    if (changed) {
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
  }
  if (removed > 0 && Object.keys(hooks).length === 0) delete settings['hooks'];
  return removed;
}

function detectIndent(text: string): string | number {
  const m = /^\{\r?\n([ \t]+)\S/.exec(text);
  return m === null ? 2 : m[1]!.includes('\t') ? '\t' : m[1]!.length;
}

interface Loaded {
  settings: Json;
  indent: string | number;
  newline: boolean;
  mode: number | undefined;
}

export function settingsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude');
}

function load(dir: string): Loaded {
  let read: ReturnType<typeof readExternalFile>;
  try {
    read = readExternalFile(path.join(dir, 'settings.json'), [dir]);
  } catch (err) {
    const errno = err instanceof SafePathError ? err.errno : (err as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') return { settings: {}, indent: 2, newline: true, mode: undefined };
    throw new HookInstallError(`cannot read ${path.join(dir, 'settings.json')}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (read.data.length > MAX_SETTINGS_BYTES) throw new HookInstallError('settings.json is too large');
  const text = read.data.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HookInstallError('settings.json is not valid JSON; left untouched');
  }
  if (!isObject(parsed)) throw new HookInstallError('settings.json is not a JSON object; left untouched');
  if (parsed['hooks'] !== undefined && !isObject(parsed['hooks'])) throw new HookInstallError('settings.json "hooks" is not an object; left untouched');
  return { settings: parsed, indent: detectIndent(text), newline: text.endsWith('\n'), mode: read.stat.mode & 0o777 };
}

function save(dir: string, l: Loaded): void {
  const text = `${JSON.stringify(l.settings, null, l.indent)}${l.newline ? '\n' : ''}`;
  writeAtomic(resolveInRoot(dir, 'settings.json'), text, l.mode === undefined ? {} : { mode: l.mode });
}

export interface InstallResult {
  file: string;
  commands: string[];
}

/** Add (or refresh) ebrain's hook entries; user entries are untouched. */
export function installHooks(entry: Entry, quote: (s: string) => string, homeDir?: string): InstallResult {
  const dirPath = ensureOwnerDir(settingsDir(homeDir));
  const l = load(dirPath);
  stripOwned(l.settings);
  const hooks = (isObject(l.settings['hooks']) ? l.settings['hooks'] : (l.settings['hooks'] = {})) as Json;
  const commands: string[] = [];
  for (const name of Object.keys(HOOK_EVENTS) as HookName[]) {
    const command = hookCommand(name, entry, quote);
    commands.push(command);
    const event = HOOK_EVENTS[name];
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : (hooks[event] = []) as unknown[];
    groups.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] });
  }
  save(dirPath, l);
  return { file: path.join(dirPath, 'settings.json'), commands };
}

/** Remove ebrain's hook entries. Returns how many were removed (the file is not rewritten when 0). */
export function removeHooks(homeDir?: string): { file: string; removed: number } {
  const dirPath = ensureOwnerDir(settingsDir(homeDir));
  const file = path.join(dirPath, 'settings.json');
  const l = load(dirPath);
  const removed = stripOwned(l.settings);
  if (removed > 0) save(dirPath, l);
  return { file, removed };
}
