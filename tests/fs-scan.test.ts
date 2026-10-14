// I1 scan: no module other than src/safe-path.ts may import node:fs. Every
// filesystem access for a non-constant path goes through safe-path's
// wrappers. There are no exceptions today; adding one requires an entry in
// ALLOWED with a justification.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRoot } from './helpers.js';

const ALLOWED = new Set(['src/safe-path.ts']);

const FS_SPEC = String.raw`(?:node:)?fs(?:/promises)?`;
const PATTERNS: RegExp[] = [
  new RegExp(String.raw`\bfrom\s*['"]${FS_SPEC}['"]`),
  new RegExp(String.raw`\bimport\s*['"]${FS_SPEC}['"]`),
  new RegExp(String.raw`\bimport\s*\(\s*['"]${FS_SPEC}['"]\s*\)`),
  new RegExp(String.raw`\brequire\s*\(\s*['"]${FS_SPEC}['"]\s*\)`),
  /\bprocess\s*\.\s*binding\s*\(/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function findFsImports(root: string): string[] {
  const offenders: string[] = [];
  for (const file of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (PATTERNS.some((re) => re.test(source))) offenders.push(rel);
  }
  return offenders;
}

describe('node:fs scan (I1)', () => {
  it('only src/safe-path.ts imports node:fs', () => {
    assert.deepEqual(findFsImports(repoRoot()), []);
  });

  it('the scanner catches every import form', () => {
    const samples = [
      "import * as fs from 'node:fs';",
      'import { readFileSync } from "fs";',
      "import fsp from 'node:fs/promises';",
      "import 'fs';",
      "const fs = await import('node:fs');",
      "const fs = require('fs');",
      "process.binding('fs');",
    ];
    for (const s of samples) assert.ok(PATTERNS.some((re) => re.test(s)), s);
    assert.ok(!PATTERNS.some((re) => re.test("import * as path from 'node:path';")));
    assert.ok(!PATTERNS.some((re) => re.test("import { x } from './fsutil.js';")));
  });
});
