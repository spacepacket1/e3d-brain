// Per-run budgets for LLM jobs: a run stops cleanly (no error) once the next
// call would exceed the call count or the input-character allowance.

export type BudgetStop = 'max-calls' | 'max-input-chars';

export class RunBudget {
  calls = 0;
  inputChars = 0;

  constructor(
    readonly maxCalls: number,
    readonly maxInputChars: number,
  ) {}

  /** Why a call of `chars` input characters may not run, or undefined if it may. */
  check(chars: number): BudgetStop | undefined {
    if (this.calls >= this.maxCalls) return 'max-calls';
    if (this.inputChars + chars > this.maxInputChars) return 'max-input-chars';
    return undefined;
  }

  record(chars: number): void {
    this.calls++;
    this.inputChars += chars;
  }
}
