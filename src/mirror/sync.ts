// Mirrors (`ebrain sync`): copy an outside folder of Markdown (a repo's docs) into the vault as curated reference
// notes, scrubbed and stamped with where each came from. Owner CLI only, human principal only; the source folder comes
// from the config file, never from a tool argument.
//
// Guarantees (all tested):
//  - The source is only read, through safe-path (realpath containment, no symlinks followed, size cap per file).
//  - Every file passes through the scrubber before it is written (I5); findings are reported as counts and paths only.
//  - Nothing is deleted on either side: a source file that disappeared is reported as orphaned and its note is kept.
//  - A re-run is a no-op when nothing changed: ids the brain assigned (`ebrain ids assign`) and the original `created`
//    date are preserved, so notes are never churned.
//  - Notes are `pinned: true` (cognition jobs skip them: they are regenerated from the source, so proposals against
//    them would be pointless) and carry `mirror: <name>`; do not hand-edit them, a re-sync overwrites the edit.
// No `node:fs` here (I1): every path goes through safe-path.

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { parse, stringify } from 'yaml';
import { MIRROR_BUILTIN_EXCLUDES, type Config, type MirrorConfig } from '../config.js';
import { isCredentialType, scrub, scrubVersion } from '../scrub/index.js';
import {
  assertInside, mkdirSafe, readDirSafe, readFileSafe, readFileWithStatSafe, resolveInRoot, resolveInState, resolveInVault,
  statSafe, writeAtomic, type SafePath,
} from '../safe-path.js';
import { splitFrontmatter } from '../vault/parse.js';

export interface MirrorEnv {
  config: Config;
  stateDir: SafePath;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export const SKIP_REASONS = ['too_large', 'unreadable', 'invalid_utf8', 'collision', 'scrub_rejected', 'empty'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface MirrorReport {
  name: string;
  into: string;
  dryRun: boolean;
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Vault paths whose source file no longer exists. The notes are kept. */
  orphaned: string[];
  skipped: Record<SkipReason, number>;
  /** Scrub findings by detector type (counts only). */
  findings: Record<string, number>;
  /** `source path: type xN, ...` for files with credential-class findings, so the owner can check the source. */
  credentialFiles: string[];
  lastSync: string | null;
}

export interface MirrorStatus {
  name: string;
  into: string;
  lastSync: string | null;
  ageDays: number | null;
  tracked: number;
  newFiles: number;
  changed: number;
  unchanged: number;
  orphaned: number;
  missingNotes: number;
}

interface StateFile {
  version: 1;
  mirrors: Record<string, { last_sync: string; files: Record<string, { vault: string; sha: string }> }>;
}

const MAX_SCAN_FILES = 20000;
const SKIP_FILE = /^(_TEMPLATE|CHANGELOG)\b/i;

export class MirrorError extends Error {}

const emptySkips = (): Record<SkipReason, number> => ({ too_large: 0, unreadable: 0, invalid_utf8: 0, collision: 0, scrub_rejected: 0, empty: 0 });

function stateFile(env: MirrorEnv): SafePath {
  return resolveInState(env.stateDir, 'mirrors.json');
}

function readState(env: MirrorEnv): StateFile {
  const p = stateFile(env);
  if (statSafe(p) === undefined) return { version: 1, mirrors: {} };
  try {
    const j = JSON.parse(readFileSafe(p, 'utf8')) as StateFile;
    return j && j.version === 1 && typeof j.mirrors === 'object' && j.mirrors !== null ? j : { version: 1, mirrors: {} };
  } catch {
    return { version: 1, mirrors: {} };
  }
}

function writeState(env: MirrorEnv, state: StateFile): void {
  writeAtomic(stateFile(env), `${JSON.stringify(state, null, 2)}\n`);
}

const safeSegment = (s: string): string =>
  s.replace(/[^\p{L}\p{N}_ .@()+,-]/gu, '_').replace(/^\.+/, '_').replace(/\s+$/, '') || '_';

function isDoc(name: string): boolean {
  return (/\.md$/i.test(name) || name === 'llms.txt') && !SKIP_FILE.test(name);
}

interface Source {
  relSrc: string;
  vaultRel: string;
  data: Buffer;
  mtime: Date;
  sha: string;
}

/** Walk the source folder (no symlinks, no dot-directories, built-in and configured excludes) and read each document. */
function collect(m: MirrorConfig, skipped: Record<SkipReason, number>): Source[] {
  let root: SafePath;
  try {
    root = assertInside(m.path, m.path);
  } catch (err) {
    throw new MirrorError(`mirror "${m.name}": source folder is not readable (${err instanceof Error ? err.message : String(err)})`);
  }
  const excludes = new Set([...MIRROR_BUILTIN_EXCLUDES, ...m.exclude]);
  const rels: string[] = [];
  const walk = (rel: string): void => {
    if (rels.length > MAX_SCAN_FILES) throw new MirrorError(`mirror "${m.name}": more than ${MAX_SCAN_FILES} documents; narrow it with "exclude"`);
    let ents;
    try {
      ents = readDirSafe(rel === '' ? root : resolveInRoot(m.path, rel));
    } catch {
      skipped.unreadable += 1;
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !excludes.has(e.name)) walk(childRel);
      } else if (e.isFile() && isDoc(e.name)) {
        rels.push(childRel);
      }
    }
  };
  walk('');

  const out: Source[] = [];
  const taken = new Set<string>();
  for (const relSrc of rels) {
    let data: Buffer;
    let mtime: Date;
    try {
      const r = readFileWithStatSafe(resolveInRoot(m.path, relSrc), { maxBytes: m.maxFileKB * 1024 });
      data = r.data;
      mtime = new Date(Number(r.stat.mtimeMs));
    } catch (err) {
      const tooLarge = err instanceof Error && /size limit|too-large/i.test(err.message);
      skipped[tooLarge ? 'too_large' : 'unreadable'] += 1;
      continue;
    }
    if (data.length === 0) {
      skipped.empty += 1;
      continue;
    }
    let vaultRel = [m.into, ...relSrc.split('/').map(safeSegment)].join('/');
    if (!/\.md$/i.test(vaultRel)) vaultRel += '.md';
    if (taken.has(vaultRel.toLowerCase())) {
      skipped.collision += 1;
      continue;
    }
    taken.add(vaultRel.toLowerCase());
    out.push({ relSrc, vaultRel, data, mtime, sha: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16) });
  }
  return out;
}

/** The commit a git checkout is on, read from .git without running git. Undefined when it cannot be told. */
function gitCommit(root: string): string | undefined {
  try {
    const head = readFileSafe(resolveInRoot(root, '.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 12) : undefined;
    const ref = head.slice(5).trim();
    if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes('..')) return undefined;
    try {
      const sha = readFileSafe(resolveInRoot(root, `.git/${ref}`), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha.slice(0, 12);
    } catch {
      // packed ref
    }
    for (const line of readFileSafe(resolveInRoot(root, '.git/packed-refs'), 'utf8').split('\n')) {
      const [sha, name] = line.split(' ');
      if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha.slice(0, 12);
    }
  } catch {
    // no .git, a worktree file, or unreadable: stamp no commit
  }
  return undefined;
}

function titleOf(body: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(body);
  return (m?.[1] ?? fallback).replace(/[`*_]/g, '').trim().slice(0, 140) || fallback;
}

interface Existing {
  id?: string;
  created?: string;
  text: string;
}

function readExisting(vaultPath: string, vaultRel: string): Existing | undefined {
  const p = resolveInVault(vaultPath, vaultRel);
  if (statSafe(p) === undefined) return undefined;
  const text = readFileSafe(p, 'utf8');
  const { yaml } = splitFrontmatter(text);
  let id: string | undefined;
  let created: string | undefined;
  if (yaml !== null) {
    try {
      const y = parse(yaml) as Record<string, unknown> | null;
      if (y && typeof y['id'] === 'string') id = y['id'];
      if (y && y['created'] !== undefined) created = String(y['created']).slice(0, 10);
    } catch {
      // malformed: treat as new
    }
  }
  return { ...(id === undefined ? {} : { id }), ...(created === undefined ? {} : { created }), text };
}

function render(opts: {
  m: MirrorConfig; s: Source; scrubbedText: string; commit: string | undefined; existing: Existing | undefined; today: string;
}): string {
  const { m, s, scrubbedText, commit, existing, today } = opts;
  const { yaml, body } = splitFrontmatter(scrubbedText);
  let ofm: Record<string, unknown> = {};
  if (yaml !== null) {
    try {
      const y = parse(yaml);
      if (y && typeof y === 'object' && !Array.isArray(y)) ofm = y as Record<string, unknown>;
    } catch {
      ofm = {};
    }
  }
  const title = String(ofm['title'] ?? ofm['name'] ?? titleOf(body, path.basename(s.relSrc, path.extname(s.relSrc)))).slice(0, 140);
  const front: Record<string, unknown> = {
    ...(existing?.id === undefined ? {} : { id: existing.id }),
    schema: 1,
    kind: 'reference',
    status: 'accepted',
    pinned: true,
    title,
    occurred: s.mtime.toISOString().slice(0, 10),
    tags: [`repo/${m.name}`, 'mirror'],
    mirror: m.name,
    source_repo: m.name,
    source_path: s.relSrc,
    ...(commit === undefined ? {} : { source_commit: commit }),
    source_sha256: s.sha,
    ...(Object.keys(ofm).length > 0 ? { source_frontmatter: ofm } : {}),
    author: 'import',
    origin: 'import',
    created: existing?.created ?? today,
    scrubVersion,
  };
  return `---\n${stringify(front).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** Copy one mirror into the vault. Writes nothing when `dryRun`. */
export function syncMirror(env: MirrorEnv, m: MirrorConfig, opts: { dryRun?: boolean } = {}): MirrorReport {
  const dryRun = opts.dryRun === true;
  const vaultPath = env.config.vaultPath;
  const now = (env.now ?? (() => new Date()))();
  const today = now.toISOString().slice(0, 10);
  const skipped = emptySkips();
  const sources = collect(m, skipped);
  const commit = gitCommit(m.path);
  const state = readState(env);
  const prev = state.mirrors[m.name]?.files ?? {};
  const report: MirrorReport = {
    name: m.name, into: m.into, dryRun, scanned: sources.length, added: 0, updated: 0, unchanged: 0, orphaned: [],
    skipped, findings: {}, credentialFiles: [], lastSync: state.mirrors[m.name]?.last_sync ?? null,
  };
  const files: Record<string, { vault: string; sha: string }> = {};
  for (const s of sources) {
    const text = s.data.toString('utf8');
    if (text.includes('�')) {
      skipped.invalid_utf8 += 1;
      continue;
    }
    const r = scrub(text, { extraPatterns: env.config.scrub.extraPatterns });
    if (!r.ok) {
      skipped.scrub_rejected += 1;
      continue;
    }
    for (const f of r.findings) report.findings[f.type] = (report.findings[f.type] ?? 0) + f.count;
    const cred = r.findings.filter((f) => isCredentialType(f.type));
    if (cred.length > 0) report.credentialFiles.push(`${s.relSrc}: ${cred.map((f) => `${f.type} x${f.count}`).join(', ')}`);

    const existing = readExisting(vaultPath, s.vaultRel);
    const content = render({ m, s, scrubbedText: r.text, commit, existing, today });
    files[s.relSrc] = { vault: s.vaultRel, sha: s.sha };
    if (existing === undefined) report.added += 1;
    else if (existing.text === content) report.unchanged += 1;
    else report.updated += 1;
    if (!dryRun && (existing === undefined || existing.text !== content)) {
      const target = resolveInVault(vaultPath, s.vaultRel);
      mkdirSafe(resolveInVault(vaultPath, path.posix.dirname(s.vaultRel)));
      writeAtomic(target, content);
    }
  }
  for (const [relSrc, f] of Object.entries(prev)) if (files[relSrc] === undefined && !sources.some((s) => s.relSrc === relSrc)) report.orphaned.push(f.vault);
  report.orphaned.sort();
  if (!dryRun) {
    // keep tracking orphans so they stay reported until the owner deals with them
    const kept: Record<string, { vault: string; sha: string }> = { ...files };
    for (const [relSrc, f] of Object.entries(prev)) if (kept[relSrc] === undefined && report.orphaned.includes(f.vault)) kept[relSrc] = f;
    state.mirrors[m.name] = { last_sync: now.toISOString(), files: kept };
    writeState(env, state);
    report.lastSync = now.toISOString();
  }
  return report;
}

/** Compare the source with what the last sync recorded, without writing anything. */
export function mirrorStatus(env: MirrorEnv, m: MirrorConfig): MirrorStatus {
  const skipped = emptySkips();
  const sources = collect(m, skipped);
  const entry = readState(env).mirrors[m.name];
  const prev = entry?.files ?? {};
  let newFiles = 0;
  let changed = 0;
  let unchanged = 0;
  let missingNotes = 0;
  for (const s of sources) {
    const p = prev[s.relSrc];
    if (p === undefined) newFiles += 1;
    else {
      if (p.sha === s.sha) unchanged += 1;
      else changed += 1;
      if (statSafe(resolveInVault(env.config.vaultPath, p.vault)) === undefined) missingNotes += 1;
    }
  }
  const seen = new Set(sources.map((s) => s.relSrc));
  const orphaned = Object.keys(prev).filter((r) => !seen.has(r)).length;
  const now = (env.now ?? (() => new Date()))();
  const ageDays = entry === undefined ? null : Math.floor((now.getTime() - Date.parse(entry.last_sync)) / 86_400_000);
  return {
    name: m.name, into: m.into, lastSync: entry?.last_sync ?? null, ageDays, tracked: Object.keys(prev).length, newFiles, changed,
    unchanged, orphaned, missingNotes,
  };
}

/** Last-sync facts from the state file alone (no folder walk): for `ebrain doctor`. */
export function mirrorSummary(env: MirrorEnv): { name: string; lastSync: string | null; ageDays: number | null; tracked: number }[] {
  const state = readState(env);
  const now = (env.now ?? (() => new Date()))();
  return env.config.mirrors.map((m) => {
    const e = state.mirrors[m.name];
    return {
      name: m.name, lastSync: e?.last_sync ?? null, tracked: e === undefined ? 0 : Object.keys(e.files).length,
      ageDays: e === undefined ? null : Math.floor((now.getTime() - Date.parse(e.last_sync)) / 86_400_000),
    };
  });
}
