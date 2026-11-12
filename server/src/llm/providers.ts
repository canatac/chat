import type { Config } from '../config.js';
import type { Usage } from './pricing.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LLMConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature: number;
  maxTokens: number;
}

export interface LLMResult {
  text: string;
  usage: Usage;
}

export function toLLMConfig(cfg: Config): LLMConfig {
  return {
    provider: cfg.LLM_PROVIDER,
    baseUrl: cfg.LLM_BASE_URL || undefined,
    apiKey: cfg.LLM_API_KEY || undefined,
    model: cfg.LLM_MODEL || undefined,
    temperature: cfg.LLM_TEMPERATURE,
    maxTokens: cfg.LLM_MAX_TOKENS,
  };
}

const KNOWN_BASES: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  anthropic: 'https://api.anthropic.com',
};

export function resolveBaseUrl(llm: LLMConfig): string {
  if (llm.baseUrl) return llm.baseUrl.replace(/\/+$/, '');
  const known = KNOWN_BASES[llm.provider.toLowerCase()];
  if (known) return known;
  throw new Error(`LLM_BASE_URL requis pour le provider "${llm.provider}"`);
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function buildOpenAIRequest(llm: LLMConfig, messages: ChatMessage[], opts: ChatOptions = {}): BuiltRequest {
  if (!llm.model) throw new Error('LLM_MODEL requis');
  const base = resolveBaseUrl(llm);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`;
  return {
    url: `${base}/chat/completions`,
    headers,
    body: {
      model: llm.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? llm.temperature,
      max_tokens: opts.maxTokens ?? llm.maxTokens,
    },
  };
}

export function buildAnthropicRequest(llm: LLMConfig, messages: ChatMessage[], opts: ChatOptions = {}): BuiltRequest {
  if (!llm.model) throw new Error('LLM_MODEL requis');
  if (!llm.apiKey) throw new Error('LLM_API_KEY requis pour le provider anthropic');
  const base = resolveBaseUrl(llm);
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  return {
    url: `${base}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': llm.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: llm.model,
      max_tokens: opts.maxTokens ?? llm.maxTokens,
      ...(system ? { system } : {}),
      messages: convo,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    },
  };
}

export function parseOpenAIResponse(json: unknown): string {
  const choices = (json as { choices?: { message?: { content?: string } }[] }).choices;
  const text = choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse LLM invalide (format openai-compatible)');
  return text;
}

export function parseAnthropicResponse(json: unknown): string {
  const content = (json as { content?: { type: string; text?: string }[] }).content;
  const text = content
    ?.filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
  if (!text) throw new Error('Réponse LLM invalide (format anthropic)');
  return text;
}

export function parseOpenAIUsage(json: unknown): Usage {
  const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
  const promptTokens = u?.prompt_tokens ?? 0;
  const completionTokens = u?.completion_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: u?.total_tokens ?? promptTokens + completionTokens };
}

export function parseAnthropicUsage(json: unknown): Usage {
  const u = (json as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  const promptTokens = u?.input_tokens ?? 0;
  const completionTokens = u?.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export async function chatCompletion(llm: LLMConfig, messages: ChatMessage[], opts: ChatOptions = {}): Promise<LLMResult> {
  const isAnthropic = llm.provider.toLowerCase() === 'anthropic';
  const req = isAnthropic ? buildAnthropicRequest(llm, messages, opts) : buildOpenAIRequest(llm, messages, opts);
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Erreur LLM (HTTP ${res.status}) : ${detail.slice(0, 300)}`);
  }
  const json: unknown = await res.json();
  const text = isAnthropic ? parseAnthropicResponse(json) : parseOpenAIResponse(json);
  const usage = isAnthropic ? parseAnthropicUsage(json) : parseOpenAIUsage(json);
  return { text, usage };
}
