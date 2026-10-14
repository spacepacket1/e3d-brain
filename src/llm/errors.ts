// Errors of the shared LLM layer. Messages never carry request or response
// bodies, or keys.

import { NetError } from '../net/http.js';

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Configuration problems that stop a job before any call (refusals, missing keys). */
export class LlmRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmRefusedError';
  }
}

/** Turn a transport error into an LlmError (message only; no bodies). */
export function wrapNetError(err: unknown): never {
  if (err instanceof NetError) throw new LlmError(`provider request failed: ${err.message}`);
  if (err instanceof LlmError) throw err;
  throw new LlmError(`provider request failed (${err instanceof Error ? err.name : 'error'})`);
}
