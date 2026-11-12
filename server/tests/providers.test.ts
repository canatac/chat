import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAnthropicRequest,
  buildOpenAIRequest,
  parseAnthropicResponse,
  parseAnthropicUsage,
  parseOpenAIResponse,
  parseOpenAIUsage,
  resolveBaseUrl,
  type LLMConfig,
} from '../src/llm/providers.js';

const base: LLMConfig = {
  provider: 'mistral',
  apiKey: 'sk-test',
  model: 'mistral-small-latest',
  temperature: 0.4,
  maxTokens: 1024,
};

test('resolveBaseUrl utilise les bases connues', () => {
  assert.equal(resolveBaseUrl({ ...base, provider: 'mistral' }), 'https://api.mistral.ai/v1');
  assert.equal(resolveBaseUrl({ ...base, provider: 'ollama', apiKey: undefined }), 'http://127.0.0.1:11434/v1');
  assert.equal(resolveBaseUrl({ ...base, provider: 'openai' }), 'https://api.openai.com/v1');
});

test('resolveBaseUrl préfère LLM_BASE_URL et tolère les slashes finaux', () => {
  assert.equal(
    resolveBaseUrl({ ...base, provider: 'custom', baseUrl: 'http://192.168.1.10:8000/v1/' }),
    'http://192.168.1.10:8000/v1',
  );
});

test('resolveBaseUrl échoue pour un provider inconnu sans baseUrl', () => {
  assert.throws(() => resolveBaseUrl({ ...base, provider: 'inconnu', baseUrl: undefined }), /LLM_BASE_URL/);
});

test('buildOpenAIRequest construit une requête chat/completions correcte', () => {
  const req = buildOpenAIRequest(base, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(req.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(req.headers.Authorization, 'Bearer sk-test');
  const body = req.body as { model: string; messages: unknown[]; temperature: number; max_tokens: number };
  assert.equal(body.model, 'mistral-small-latest');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens, 1024);
});

test('buildOpenAIRequest omet Authorization sans clé (Ollama local)', () => {
  const req = buildOpenAIRequest({ ...base, provider: 'ollama', apiKey: undefined }, []);
  assert.equal(req.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(req.headers.Authorization, undefined);
});

test('buildOpenAIRequest exige un modèle', () => {
  assert.throws(() => buildOpenAIRequest({ ...base, model: undefined }, []), /LLM_MODEL/);
});

test('buildAnthropicRequest extrait le system et envoie x-api-key', () => {
  const req = buildAnthropicRequest(
    { ...base, provider: 'anthropic', apiKey: 'sk-ant-test' },
    [
      { role: 'system', content: 'tu es un assistant' },
      { role: 'user', content: 'salut' },
      { role: 'assistant', content: 'bonjour' },
      { role: 'user', content: 'question ?' },
    ],
    { maxTokens: 512 },
  );
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-ant-test');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  const body = req.body as { system: string; messages: { role: string; content: string }[]; max_tokens: number };
  assert.equal(body.system, 'tu es un assistant');
  assert.deepEqual(body.messages, [
    { role: 'user', content: 'salut' },
    { role: 'assistant', content: 'bonjour' },
    { role: 'user', content: 'question ?' },
  ]);
  assert.equal(body.max_tokens, 512);
});

test('buildAnthropicRequest exige une clé API', () => {
  assert.throws(() => buildAnthropicRequest({ ...base, provider: 'anthropic', apiKey: undefined }, []), /LLM_API_KEY/);
});

test('parseOpenAIResponse extrait le texte', () => {
  assert.equal(parseOpenAIResponse({ choices: [{ message: { content: 'réponse' } }] }), 'réponse');
  assert.throws(() => parseOpenAIResponse({ choices: [] }), /invalide/);
});

test('parseAnthropicResponse concatène les blocs texte', () => {
  assert.equal(
    parseAnthropicResponse({ content: [{ type: 'text', text: 'partie 1 ' }, { type: 'tool_use' }, { type: 'text', text: 'partie 2' }] }),
    'partie 1 \npartie 2',
  );
  assert.throws(() => parseAnthropicResponse({ content: [] }), /invalide/);
});

test('parseOpenAIUsage lit prompt/completion/total tokens', () => {
  assert.deepEqual(parseOpenAIUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }), {
    promptTokens: 120,
    completionTokens: 30,
    totalTokens: 150,
  });
  assert.deepEqual(parseOpenAIUsage({}), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
});

test('parseAnthropicUsage mappe input/output tokens', () => {
  assert.deepEqual(parseAnthropicUsage({ usage: { input_tokens: 200, output_tokens: 50 } }), {
    promptTokens: 200,
    completionTokens: 50,
    totalTokens: 250,
  });
});
