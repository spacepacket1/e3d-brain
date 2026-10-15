// Bridges the scrubber (Phase 7) to MCP write tools (Phases 8-10, 13): scrub
// a submitted body under the calling principal's rules, or throw the
// ToolRejection that dispatch turns into a structured error and an audit
// line carrying the detector type only (never the text or the match).

import { scrubForWrite, ScrubRejectedError, type ScrubbedWrite } from '../scrub/index.js';
import { ToolRejection, type ToolContext } from './dispatch.js';

export const STRICT_SCRUB_DETAIL = 'write rejected: the text contains a credential; nothing was stored';

/**
 * Scrub text an MCP client submitted, before anything is written. An agent
 * principal gets strict rules: a credential-class detection rejects the whole
 * write (`strict-scrub`, `code` = the first detector type, `detail` = the
 * detector types). Any other scrub failure propagates, so the write aborts.
 */
export function scrubToolInput(text: string, ctx: Pick<ToolContext, 'principal'>, extraPatterns: readonly string[] = []): ScrubbedWrite {
  try {
    return scrubForWrite(text, { principal: ctx.principal, extraPatterns });
  } catch (err) {
    if (err instanceof ScrubRejectedError) {
      const types = err.rejection.detectors;
      throw new ToolRejection({ type: 'strict-scrub', code: types[0], detail: `${STRICT_SCRUB_DETAIL} (detected: ${types.join(', ')})` });
    }
    throw err;
  }
}
