// OpenAI-compatible chat completions (Ollama, llama.cpp, vLLM, ...): POST
// `<baseUrl>/chat/completions`, text from `choices[0].message.content`.

import type { LlmConfig } from '../config.js';
import { postJson } from '../net/http.js';
import { LlmError, wrapNetError } from './errors.js';
import type { ExtractionProvider } from './provider.js';

export function createOpenAiCompatibleProvider(cfg: LlmConfig, allowedHosts: readonly string[], key: string | undefined): ExtractionProvider {
  return {
    provider: 'openai-compatible',
    model: cfg.model,
    async complete(req) {
      let res: unknown;
      try {
        res = await postJson(
          cfg.baseUrl,
          '/chat/completions',
          {
            model: cfg.model,
            temperature: 0,
            max_tokens: req.maxOutputTokens,
            stream: false,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
          },
          { allowedHosts, timeoutMs: cfg.timeoutMs, ...(key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } }) },
        );
      } catch (err) {
        wrapNetError(err);
      }
      const content = (res as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new LlmError('provider response has no message content');
      return content;
    },
  };
}
