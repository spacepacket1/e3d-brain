// A budgeted LLM session for one cognition run (cognition Phase 2, C6, G8).
// Every call goes through `ask`: the run budget is checked first (a run
// stops cleanly, never with an error, once the next call would exceed
// `maxLlmCalls` or `maxInputChars`), the reply is validated against a strict
// output schema (invalid items are dropped and counted, an unparseable
// reply counts as one invalid response; neither is fatal), and the request
// is logged as SHA-256 hashes of its input and output only, never the text.
// Callers send only scrubbed text (C7).

import { createHash } from 'node:crypto';
import { RunBudget, type BudgetStop } from './budget.js';
import { LlmError } from './errors.js';
import { promptHash, promptId, type PromptTemplate } from './prompts/index.js';
import type { ExtractionProvider } from './provider.js';
import { validateOutput, type ItemSchema } from './schema.js';

export interface LlmRequestLog {
  prompt: string;
  /** SHA-256 of the system and user text sent. */
  input_sha256: string;
  input_chars: number;
  /** SHA-256 of the completion text, or null when the call failed. */
  output_sha256: string | null;
  outcome: 'ok' | 'invalid-response' | 'error';
  /** Items the strict output schema dropped from this response. */
  invalid_items: number;
}

export type SessionStop = BudgetStop | 'provider-error';

export type AskResult<T> = { stop: SessionStop; items: [] } | { stop?: undefined; items: T[] };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export class LlmSession {
  readonly log: LlmRequestLog[] = [];
  invalidItems = 0;
  invalidResponses = 0;
  /** Message of the provider error that stopped the session (no request or response text). */
  error: string | undefined;
  readonly budget: RunBudget;
  private readonly maxOutputTokens: number;

  constructor(
    readonly provider: ExtractionProvider,
    readonly prompt: PromptTemplate,
    limits: { maxCalls: number; maxInputChars: number; maxOutputTokens: number },
  ) {
    this.budget = new RunBudget(limits.maxCalls, limits.maxInputChars);
    this.maxOutputTokens = limits.maxOutputTokens;
  }

  get promptId(): string {
    return promptId(this.prompt);
  }

  get promptSha256(): string {
    return promptHash(this.prompt);
  }

  /** Send `input` (already scrubbed) after the prompt's instructions; validate the reply. */
  async ask<T>(input: string, listKey: string, schema: ItemSchema, maxItems: number): Promise<AskResult<T>> {
    if (this.error !== undefined) return { stop: 'provider-error', items: [] };
    const user = `${this.prompt.instructions}\n\n${input}`;
    const chars = this.prompt.system.length + user.length;
    const stop = this.budget.check(chars);
    if (stop !== undefined) return { stop, items: [] };
    this.budget.record(chars);
    const entry: LlmRequestLog = {
      prompt: this.promptId, input_sha256: sha256(`${this.prompt.system}\n\0\n${user}`), input_chars: chars, output_sha256: null, outcome: 'error', invalid_items: 0,
    };
    this.log.push(entry);
    let reply: string;
    try {
      reply = await this.provider.complete({ system: this.prompt.system, user, maxOutputTokens: this.maxOutputTokens });
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      this.error = err.message;
      return { stop: 'provider-error', items: [] };
    }
    entry.output_sha256 = sha256(reply);
    const v = validateOutput<T>(reply, listKey, schema, maxItems);
    if (!v.parsed) {
      entry.outcome = 'invalid-response';
      this.invalidResponses++;
      return { items: [] };
    }
    entry.outcome = 'ok';
    entry.invalid_items = v.invalid;
    this.invalidItems += v.invalid;
    return { items: v.items };
  }
}
