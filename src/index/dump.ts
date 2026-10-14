// `ebrain index dump`: a canonical text rendering of the index contents for
// equality tests (I11). Excludes everything that varies between checkouts or
// rebuilds of the same vault: stat keys, racy flags, chunk rowids, and (from
// Phase 3) provisional ids and rename history. Notes are in listing order
// (bytewise NFC path, then raw path); everything inside a note by ordinal.

import type { Db } from './db.js';
import { findCollisions } from '../vault/names.js';

export const DUMP_HEADER = 'e3d-brain index dump v1';

const q = (v: string | null): string => (v === null ? 'null' : JSON.stringify(v));
/** JSON string with every non-ASCII code unit escaped, so normalization differences are visible. */
const ascii = (v: string): string => JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const FIELD_COLUMNS: [string, string][] = [
  ['schema', 'schema_version'], ['id', 'fm_id'], ['status', 'status'], ['pinned', 'pinned'], ['kind', 'kind'],
  ['occurred', 'occurred'], ['valid_from', 'valid_from'], ['valid_until', 'valid_until'], ['created', 'created'],
  ['expires', 'expires'], ['accepted', 'accepted'], ['applied', 'applied'], ['superseded_at', 'superseded_at'],
  ['archived_at', 'archived_at'], ['author', 'author'], ['origin', 'origin'], ['sources', 'sources'],
  ['untrusted_origin', 'untrusted_origin'], ['superseded_by', 'superseded_by'], ['supersedes', 'supersedes'],
  ['merged_into', 'merged_into'], ['derived_from', 'derived_from'], ['scrubVersion', 'scrub_version'],
];
const BOOL_FIELDS = new Set(['pinned', 'untrusted_origin']);
const LIST_FIELDS = new Set(['sources', 'supersedes', 'derived_from']);

type NoteRow = Record<string, string | number | null>;

export function dumpIndex(db: Db): string {
  return db.transaction(() => {
    const out: string[] = [DUMP_HEADER];
    const notes = db.prepare('SELECT * FROM notes ORDER BY path_nfc, path').all() as NoteRow[];
    const byNote = (table: string, cols: string) =>
      db.prepare(`SELECT ${cols} FROM ${table} WHERE note_path = ? ORDER BY ordinal`);
    const chunks = byNote('chunks', 'ordinal, heading_path, text');
    const links = byNote('links', 'ordinal, line, target, anchor, alias, embed, resolved_path, resolution, candidates');
    const headings = byNote('headings', 'ordinal, level, text, line');
    const problems = byNote('problems', 'ordinal, kind, field, detail');
    const tags = db.prepare('SELECT tag, source FROM tags WHERE note_path = ? ORDER BY tag');
    const aliases = db.prepare('SELECT alias FROM aliases WHERE note_path = ? ORDER BY alias');

    for (const n of notes) {
      const path = n.path as string;
      out.push(`note ${q(n.path_nfc as string)}`);
      if (n.path !== n.path_nfc) out.push(`  raw ${ascii(path)}`);
      out.push(`  hash ${n.hash} size ${n.size}`);
      out.push(`  title ${q(n.title as string)}`);
      out.push(`  folder ${n.folder_class}${n.folder_hidden ? ' hidden' : ''}`);
      out.push(`  frontmatter ${n.frontmatter}${n.status !== null && !n.status_known ? ' unknown-status' : ''}`);
      const fields: string[] = [];
      for (const [name, col] of FIELD_COLUMNS) {
        const v = n[col];
        if (v === null || v === undefined) continue;
        if (LIST_FIELDS.has(name)) {
          if (v !== '[]') fields.push(`${name}=${v}`);
        } else if (BOOL_FIELDS.has(name)) fields.push(`${name}=${v ? 'true' : 'false'}`);
        else fields.push(`${name}=${typeof v === 'number' ? v : q(v)}`);
      }
      if (fields.length > 0) out.push(`  fields ${fields.join(' ')}`);
      if (n.extra !== '{}') out.push(`  extra ${n.extra}`);
      for (const a of aliases.all(path) as { alias: string }[]) out.push(`  alias ${q(a.alias)}`);
      for (const t of tags.all(path) as { tag: string; source: string }[]) out.push(`  tag ${q(t.tag)} ${t.source}`);
      for (const hd of headings.all(path) as { level: number; text: string; line: number }[]) {
        out.push(`  heading h${hd.level} L${hd.line} ${q(hd.text)}`);
      }
      for (const p of problems.all(path) as { kind: string; field: string | null; detail: string }[]) {
        out.push(`  problem ${p.kind} ${p.field ?? '-'} ${q(p.detail)}`);
      }
      for (const c of chunks.all(path) as { ordinal: number; heading_path: string; text: string }[]) {
        out.push(`  chunk ${c.ordinal} ${c.heading_path} ${q(c.text)}`);
      }
      for (const l of links.all(path) as {
        ordinal: number; line: number; target: string; anchor: string | null; alias: string | null; embed: number;
        resolved_path: string | null; resolution: string; candidates: number;
      }[]) {
        const parts = [`  link ${l.ordinal} L${l.line} ${q(l.target)}`];
        if (l.anchor !== null) parts.push(`#${q(l.anchor)}`);
        if (l.alias !== null) parts.push(`|${q(l.alias)}`);
        if (l.embed) parts.push('embed');
        parts.push(`-> ${l.resolution}${l.resolved_path === null ? '' : ` ${q(l.resolved_path)}`}`);
        if (l.candidates > 1) parts.push(`(${l.candidates} candidates)`);
        out.push(parts.join(' '));
      }
    }
    for (const group of findCollisions(notes.map((n) => n.path as string))) {
      out.push(`collision ${group.map(q).join(' ')}`);
    }
    return `${out.join('\n')}\n`;
  })();
}
