// Anthropic Messages API: POST `<baseUrl>/v1/messages`, text from the `text`
// content blocks. Reached only through `createProvider`, which enforces the
// allowlist and the data-leaves-machine flag.

import type { LlmConfig } from '../config.js';
import { postJson } from '../net/http.js';
import { LlmError, wrapNetError } from './errors.js';
import type { ExtractionProvider } from './provider.js';

export const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicProvider(cfg: LlmConfig, allowedHosts: readonly string[], key: string): ExtractionProvider {
  return {
    provider: 'anthropic',
    model: cfg.model,
    async complete(req) {
      let res: unknown;
      try {
        res = await postJson(
          cfg.baseUrl,
          '/v1/messages',
          {
            model: cfg.model,
            max_tokens: req.maxOutputTokens,
            temperature: 0,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
          },
          { allowedHosts, timeoutMs: cfg.timeoutMs, headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION } },
        );
      } catch (err) {
        wrapNetError(err);
      }
      const blocks = (res as { content?: unknown } | null)?.content;
      if (!Array.isArray(blocks)) throw new LlmError('provider response has no content');
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      if (text === '') throw new LlmError('provider response has no text');
      return text;
    },
  };
}
