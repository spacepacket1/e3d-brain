// Native SQLite loader. better-sqlite3 is the one native dependency (I9); if
// it fails to load, the documented fix is `npm run build:native`.

import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

export const NATIVE_BUILD_HINT = 'run `npm run build:native` (npm rebuild better-sqlite3)';

export type SqliteLoad =
  | { ok: true; Database: typeof BetterSqlite3 }
  | { ok: false; error: string };

export function loadSqlite(): SqliteLoad {
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as typeof BetterSqlite3;
    return { ok: true, Database };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type Fts5Status = { ok: true; sqliteVersion: string } | { ok: false; error: string; hint: string };

/** Probe FTS5 in an in-memory database (no filesystem access). */
export function checkFts5(): Fts5Status {
  const loaded = loadSqlite();
  if (!loaded.ok) {
    return { ok: false, error: `better-sqlite3 failed to load: ${loaded.error}`, hint: NATIVE_BUILD_HINT };
  }
  let db: BetterSqlite3.Database | undefined;
  try {
    db = new loaded.Database(':memory:');
    db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(body)');
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    return { ok: true, sqliteVersion: row.v };
  } catch (err) {
    return {
      ok: false,
      error: `FTS5 unavailable: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'better-sqlite3 must be built with FTS5 (the bundled SQLite includes it); ' + NATIVE_BUILD_HINT,
    };
  } finally {
    db?.close();
  }
}
