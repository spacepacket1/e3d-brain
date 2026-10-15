// Versioned prompt files for cognition jobs (cognition Phase 2, G8):
// `src/cognition/prompts/<job>.v<N>.md`. A prompt is never edited in place;
// a change is a new version file, and the run record names the prompt id
// (`<job>.v<N>`) and the SHA-256 prefix of its text. A file holds an optional
// leading HTML comment, then a `# system` section and a `# instructions`
// section. Files are read from the package's source tree (they ship with the
// repository, not inside dist/).

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptTemplate } from '../llm/prompts/index.js';
import { assertInside, readDirSafe, readFileSafe, resolveInRoot, statSafe } from '../safe-path.js';

export const PROMPTS_DIR = 'src/cognition/prompts';
const FILE_RE = /^([a-z][a-z0-9-]{0,31})\.v([1-9][0-9]{0,3})\.md$/;

export class PromptFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptFileError';
  }
}

/** The package root (the directory holding package.json), from this module's location. */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (statSafe(assertInside(dir, path.join(dir, 'package.json'))) === undefined) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new PromptFileError('package root not found');
    dir = parent;
  }
  return dir;
}

/** Parse a prompt file's text into its system and instruction sections. */
export function parsePromptFile(job: string, version: number, text: string): PromptTemplate {
  const body = text.replace(/\r\n?/g, '\n').replace(/^<!--[\s\S]*?-->\n*/, '');
  const m = /^# system\n([\s\S]*?)\n# instructions\n([\s\S]*)$/.exec(body);
  if (m === null) throw new PromptFileError(`${job}.v${version}.md must have a "# system" then a "# instructions" section`);
  const system = m[1]!.trim();
  const instructions = m[2]!.trim();
  if (system === '' || instructions === '') throw new PromptFileError(`${job}.v${version}.md has an empty section`);
  return { job, version, system, instructions };
}

/** Every version of a job's prompt found on disk, oldest first. */
export function promptVersions(job: string, root: string = packageRoot()): number[] {
  const dir = resolveInRoot(root, PROMPTS_DIR);
  if (statSafe(dir) === undefined) return [];
  return readDirSafe(dir)
    .map((e) => FILE_RE.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === job)
    .map((m) => Number(m[2]))
    .sort((a, b) => a - b);
}

/** Load `<job>.v<version>.md` (the newest version when `version` is omitted). */
export function loadPrompt(job: string, version?: number, root: string = packageRoot()): PromptTemplate {
  const v = version ?? promptVersions(job, root).at(-1);
  if (v === undefined) throw new PromptFileError(`no prompt file for job ${job} in ${PROMPTS_DIR}/`);
  const file = resolveInRoot(root, `${PROMPTS_DIR}/${job}.v${v}.md`);
  if (statSafe(file) === undefined) throw new PromptFileError(`no prompt file ${job}.v${v}.md in ${PROMPTS_DIR}/`);
  return parsePromptFile(job, v, readFileSafe(file, 'utf8'));
}
