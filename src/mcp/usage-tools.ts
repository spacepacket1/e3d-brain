// `report_use` (cognition Phase 8, G15): tell the brain which recalled notes
// were actually used. Registered in every mode, `read-only` included: it
// appends to `<stateDir>/usage.jsonl` through `src/recall/usage.ts` and never
// touches the vault, which is why the mode's vault fence allows it (memory I2
// scope note). The report is the caller's own word: events are labeled
// `self_reported` and never affect ranking (an agent can say anything);
// only an `outcome_ref` that resolves against local evidence, checked later
// by the owner's rollup, counts as `evidence_linked`.
//
// Validation is in `recordUsage` (recall must exist for this principal,
// note ids must come from that recall, duplicates ignored, rate and size
// limited); this module adds the schema and the citation check.

import { parseCitation } from '../cite/citation.js';
import { recordUsage, UsageError, MAX_USAGE_NOTE_IDS } from '../recall/usage.js';
import type { SafePath } from '../safe-path.js';
import { MODES, registerTool, ToolRejection, type ToolRegistry, type ToolResult } from './dispatch.js';
import { scrubToolInput } from './scrub-guard.js';
import type { ObjectSchema } from './schema.js';

export const REPORT_USE_SCHEMA: ObjectSchema = {
  type: 'object',
  properties: {
    recall_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_]{1,128}$', description: 'The recall_id of an earlier read result from this server.' },
    note_ids: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_]{1,128}$' },
      maxItems: MAX_USAGE_NOTE_IDS,
      description: 'Ids of the notes from that result that were actually used (a subset of what it returned).',
    },
    outcome_ref: { type: 'string', minLength: 1, maxLength: 512, description: 'A citation (for example outcome:<id>) of what the use led to.' },
    helpful: { type: 'boolean', description: 'Whether the notes helped.' },
  },
  required: ['recall_id'],
};

export interface UsageToolEnv {
  stateDir: SafePath;
  extraPatterns?: readonly string[];
  now?: () => Date;
}

/** Register `report_use` (every mode). */
export function registerUsageTools(env: UsageToolEnv, registry: ToolRegistry): void {
  registerTool(
    {
      name: 'report_use',
      modes: MODES,
      description:
        'Report which notes from an earlier read result you actually used, optionally with a citation of the outcome and whether they helped. ' +
        'Recorded as a self-reported event in the local state directory; it never changes the vault or search ranking.',
      schema: REPORT_USE_SCHEMA,
      auditArgs: { recall_id: 'id', note_ids: 'id' },
      handler: (args, ctx): ToolResult => {
        const outcomeRef = args['outcome_ref'];
        if (typeof outcomeRef === 'string') {
          if (!parseCitation(outcomeRef).ok) throw new ToolRejection({ type: 'invalid', detail: 'outcome_ref is not a well-formed citation' });
          // A credential in the reference rejects the call; the stored text must be exactly what was sent.
          if (scrubToolInput(outcomeRef, ctx, env.extraPatterns).text !== outcomeRef) throw new ToolRejection({ type: 'invalid', detail: 'outcome_ref is not a well-formed citation' });
        }
        try {
          const r = recordUsage(env.stateDir, ctx.principal.id, {
            recall_id: args['recall_id'] as string,
            ...(Array.isArray(args['note_ids']) ? { note_ids: args['note_ids'] as string[] } : {}),
            ...(typeof outcomeRef === 'string' ? { outcome_ref: outcomeRef } : {}),
            ...(typeof args['helpful'] === 'boolean' ? { helpful: args['helpful'] } : {}),
          }, env.now === undefined ? {} : { now: env.now });
          return { content: JSON.stringify({ tool: 'report_use', label: 'self_reported', recorded: r.recorded, ignored_duplicates: r.ignored_duplicates }) };
        } catch (err) {
          if (err instanceof UsageError) throw new ToolRejection({ type: err.type, detail: err.detail, ...(err.code === undefined ? {} : { code: err.code }) });
          throw err;
        }
      },
    },
    registry,
  );
}
