// Versioned prompts for LLM jobs. A prompt is never edited in place: a change
// is a new file `<job>.v<N>.ts` and a new entry here, so a candidate's
// `extraction_prompt` (`<job>.v<N>`) always names the exact text that
// produced it. Prompts are TypeScript modules rather than .md files so they
// ship inside the build and need no runtime file reads.

import { createHash } from 'node:crypto';
import { PROPOSE_V1 } from './propose.v1.js';

export interface PromptTemplate {
  job: string;
  version: number;
  system: string;
  /** The instruction text placed before the job's input data. */
  instructions: string;
}

export const PROMPTS: readonly PromptTemplate[] = [PROPOSE_V1];

export function promptId(p: PromptTemplate): string {
  return `${p.job}.v${p.version}`;
}

/** 16 hex of sha256 over the prompt texts (recorded with results; never the inputs themselves). */
export function promptHash(p: PromptTemplate): string {
  return createHash('sha256').update(`${p.system}\n\0\n${p.instructions}`, 'utf8').digest('hex').slice(0, 16);
}

/** The newest version of a job's prompt. */
export function currentPrompt(job: string): PromptTemplate {
  let best: PromptTemplate | undefined;
  for (const p of PROMPTS) if (p.job === job && (best === undefined || p.version > best.version)) best = p;
  if (best === undefined) throw new Error(`no prompt for job ${job}`);
  return best;
}
