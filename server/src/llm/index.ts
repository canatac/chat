import type { Config } from '../config.js';
import { chatCompletion, toLLMConfig, type ChatMessage, type ChatOptions, type LLMConfig, type LLMResult } from './providers.js';

export function llmConfigured(cfg: Config): boolean {
  return Boolean(cfg.LLM_MODEL);
}

export function getLLM(cfg: Config): LLMConfig {
  return toLLMConfig(cfg);
}

export async function askLLM(cfg: Config, messages: ChatMessage[], opts?: ChatOptions): Promise<LLMResult> {
  if (!cfg.LLM_MODEL) {
    throw new Error('LLM non configuré : définir LLM_PROVIDER, LLM_MODEL et LLM_API_KEY/LLM_BASE_URL dans le .env');
  }
  return chatCompletion(getLLM(cfg), messages, opts);
}
