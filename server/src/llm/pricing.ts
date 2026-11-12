import type { Config } from '../config.js';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface Prices {
  inputPer1M: number;
  outputPer1M: number;
  known: boolean;
}

const MODEL_PRICES: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1': [2, 8],
  'claude-sonnet-4-5': [3, 15],
  'claude-haiku-4-5': [0.8, 4],
  'claude-opus-4-1': [15, 75],
  'mistral-small': [0.2, 0.6],
  'mistral-medium': [0.4, 2],
  'mistral-large': [2, 6],
  'llama-3.3-70b': [0.59, 0.79],
  'llama-3.1-8b': [0.05, 0.08],
};

export function pricesFor(model: string, cfg: Config): Prices {
  if (cfg.LLM_INPUT_PRICE_PER_1M !== undefined && cfg.LLM_OUTPUT_PRICE_PER_1M !== undefined) {
    return { inputPer1M: cfg.LLM_INPUT_PRICE_PER_1M, outputPer1M: cfg.LLM_OUTPUT_PRICE_PER_1M, known: true };
  }
  const lower = model.toLowerCase();
  const key = Object.keys(MODEL_PRICES).find((k) => lower.includes(k));
  if (key) {
    const [input, output] = MODEL_PRICES[key];
    return { inputPer1M: input, outputPer1M: output, known: true };
  }
  return { inputPer1M: 0, outputPer1M: 0, known: false };
}

export function costUsd(usage: Usage, model: string, cfg: Config): number {
  const p = pricesFor(model, cfg);
  return (usage.promptTokens / 1e6) * p.inputPer1M + (usage.completionTokens / 1e6) * p.outputPer1M;
}
