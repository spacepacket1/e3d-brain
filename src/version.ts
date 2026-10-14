import { createRequire } from 'node:module';

// package.json sits at the repo root; this module compiles to dist/src/.
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

export const VERSION: string = pkg.version;
