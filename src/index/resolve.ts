// Wikilink resolution. A target resolves, in order, by (a) exact vault path
// (NFC, extension optional), (b) case-insensitive basename (or, for a target
// with folders, case-insensitive path suffix), (c) alias. Basename and alias
// matching compares NFC-normalized, case-folded names, so results do not
// depend on the filesystem's case or normalization behavior. When several
// notes match at the deciding rule, the one with the fewest path segments
// wins, then listing order; `candidates` records how many matched.

import type { Db } from './db.js';
import { compareBytes, foldKey, nfc } from '../vault/names.js';

interface NoteKey {
  path: string;
  path_nfc: string;
  path_fold: string;
  basename_fold: string;
}

export type Resolution = 'path' | 'basename' | 'alias' | 'self' | 'unresolved';

function stripMd(s: string): string {
  return s.endsWith('.md') ? s.slice(0, -3) : s;
}

function pick(candidates: NoteKey[]): NoteKey {
  const depth = (n: NoteKey) => n.path.split('/').length;
  return [...candidates].sort(
    (a, b) => depth(a) - depth(b) || compareBytes(a.path_nfc, b.path_nfc) || compareBytes(a.path, b.path),
  )[0]!;
}

export class LinkResolver {
  private readonly byPath = new Map<string, NoteKey[]>();
  private readonly byBasename = new Map<string, NoteKey[]>();
  private readonly byAlias = new Map<string, NoteKey[]>();
  private readonly notes: NoteKey[];

  constructor(notes: NoteKey[], aliases: { note_path: string; alias_fold: string }[]) {
    this.notes = notes;
    const add = (m: Map<string, NoteKey[]>, k: string, n: NoteKey) => {
      const l = m.get(k);
      if (l) {
        if (!l.includes(n)) l.push(n);
      } else m.set(k, [n]);
    };
    const byRaw = new Map<string, NoteKey>();
    for (const n of notes) {
      byRaw.set(n.path, n);
      add(this.byPath, stripMd(n.path_nfc), n);
      add(this.byBasename, n.basename_fold, n);
    }
    for (const a of aliases) {
      const n = byRaw.get(a.note_path);
      if (n) add(this.byAlias, a.alias_fold, n);
    }
  }

  resolve(fromPath: string, target: string): { path: string | null; resolution: Resolution; candidates: number } {
    if (target === '') return { path: fromPath, resolution: 'self', candidates: 1 };
    const t = stripMd(nfc(target).replace(/^\/+/, ''));
    const exact = this.byPath.get(t);
    if (exact) return { path: pick(exact).path, resolution: 'path', candidates: exact.length };
    const tf = foldKey(t);
    let byName: NoteKey[] | undefined;
    if (t.includes('/')) {
      const suffix = `/${tf}`;
      byName = this.notes.filter((n) => {
        const p = stripMd(n.path_fold);
        return p === tf || p.endsWith(suffix);
      });
    } else byName = this.byBasename.get(tf);
    if (byName && byName.length > 0) return { path: pick(byName).path, resolution: 'basename', candidates: byName.length };
    const byAlias = this.byAlias.get(tf);
    if (byAlias) return { path: pick(byAlias).path, resolution: 'alias', candidates: byAlias.length };
    return { path: null, resolution: 'unresolved', candidates: 0 };
  }
}

/** Re-resolve every link against the current notes; rewrites only rows whose result changed. */
export function resolveAllLinks(db: Db): void {
  const notes = db.prepare('SELECT path, path_nfc, path_fold, basename_fold FROM notes').all() as NoteKey[];
  const aliases = db.prepare('SELECT note_path, alias_fold FROM aliases').all() as { note_path: string; alias_fold: string }[];
  const resolver = new LinkResolver(notes, aliases);
  const rows = db.prepare('SELECT note_path, ordinal, target, resolved_path, resolution, candidates FROM links').all() as {
    note_path: string;
    ordinal: number;
    target: string;
    resolved_path: string | null;
    resolution: string;
    candidates: number;
  }[];
  const update = db.prepare('UPDATE links SET resolved_path = ?, resolution = ?, candidates = ? WHERE note_path = ? AND ordinal = ?');
  for (const r of rows) {
    const res = resolver.resolve(r.note_path, r.target);
    if (res.path !== r.resolved_path || res.resolution !== r.resolution || res.candidates !== r.candidates) {
      update.run(res.path, res.resolution, res.candidates, r.note_path, r.ordinal);
    }
  }
}
