// The shared extraction-provider layer (Phase 14). Every LLM job (`propose`
// today, the cognition jobs later) gets its provider here, never by talking
// to an endpoint itself. Providers:
//
//   none               the default: no provider; jobs refuse to run and no
//                      network code is touched.
//   openai-compatible  any OpenAI-style /chat/completions endpoint, intended
//                      for a local model (Ollama, llama.cpp). Same host rules
//                      as embeddings: loopback or `network.allowedHosts`.
//   anthropic          only when `network.allowedHosts` includes
//                      api.anthropic.com AND the caller passes
//                      `dataLeavesMachine` (the CLI flag
//                      `--i-understand-data-leaves-machine`). The API key comes
//                      from the environment variable named by `llm.apiKeyEnv`.
//
// Callers send only scrubbed text (I5). Error messages never contain request
// or response bodies, or keys.

import { ANTHROPIC_HOST, type LlmConfig } from '../config.js';
import { createAnthropicProvider } from './anthropic.js';
import { LlmRefusedError } from './errors.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';

export { LlmError, LlmRefusedError } from './errors.js';

export const DATA_LEAVES_MACHINE_FLAG = '--i-understand-data-leaves-machine';

export interface CompletionRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface ExtractionProvider {
  provider: 'openai-compatible' | 'anthropic';
  model: string;
  /** The completion text. Rejects with LlmError. */
  complete(req: CompletionRequest): Promise<string>;
}

export interface ProviderOptions {
  allowedHosts: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The owner explicitly accepted that text leaves the machine (required for `anthropic`). */
  dataLeavesMachine?: boolean;
}

function apiKey(cfg: LlmConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (cfg.apiKeyEnv === '') return undefined;
  const v = env[cfg.apiKeyEnv];
  if (v === undefined || v === '') throw new LlmRefusedError(`environment variable ${cfg.apiKeyEnv} (llm.apiKeyEnv) is not set`);
  return v;
}

/** The configured provider, or undefined for `none`. Throws LlmRefusedError when a gate is not met. */
export function createProvider(cfg: LlmConfig, opts: ProviderOptions): ExtractionProvider | undefined {
  const env = opts.env ?? process.env;
  switch (cfg.provider) {
    case 'none':
      return undefined;
    case 'openai-compatible':
      return createOpenAiCompatibleProvider(cfg, opts.allowedHosts, apiKey(cfg, env));
    case 'anthropic': {
      if (!opts.allowedHosts.includes(ANTHROPIC_HOST)) {
        throw new LlmRefusedError(`provider anthropic needs network.allowedHosts to include ${ANTHROPIC_HOST}`);
      }
      if (opts.dataLeavesMachine !== true) {
        throw new LlmRefusedError(`provider anthropic sends archive text off this machine; refusing without ${DATA_LEAVES_MACHINE_FLAG}`);
      }
      const key = apiKey(cfg, env);
      if (key === undefined) throw new LlmRefusedError('provider anthropic needs llm.apiKeyEnv');
      return createAnthropicProvider(cfg, opts.allowedHosts, key);
    }
  }
}
