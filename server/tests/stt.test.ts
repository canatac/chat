import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { buildTranscriptionRequest, resolveSttBaseUrl, sttConfigured, toSttConfig } from '../src/llm/stt.js';

const cfg = loadConfig({ LLM_API_KEY: '', STT_API_KEY: '' });

test('sttConfigured est faux sans base URL ni clé', () => {
  assert.equal(sttConfigured(cfg), false);
});

test('sttConfigured réutilise LLM_API_KEY si STT_API_KEY absent', () => {
  const withLlmKey = loadConfig({ LLM_API_KEY: 'sk-llm', STT_API_KEY: '' });
  assert.equal(sttConfigured(withLlmKey), true);
});

test('buildTranscriptionRequest vise /audio/transcriptions du provider connu', () => {
  const stt = toSttConfig(loadConfig({ STT_PROVIDER: 'groq', STT_API_KEY: 'gsk-x', STT_MODEL: 'whisper-large-v3', STT_LANGUAGE: 'fr' }));
  const req = buildTranscriptionRequest(stt, 'appel.webm', 'audio/webm');
  assert.equal(req.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(req.headers.Authorization, 'Bearer gsk-x');
  assert.equal(req.model, 'whisper-large-v3');
  assert.equal(req.language, 'fr');
  assert.equal(req.filename, 'appel.webm');
});

test('STT_BASE_URL personnalisé (serveur Whisper local) prioritaire', () => {
  const stt = toSttConfig(loadConfig({ STT_PROVIDER: 'openai', STT_BASE_URL: 'http://127.0.0.1:9000/v1/', STT_API_KEY: '' }));
  assert.equal(resolveSttBaseUrl(stt), 'http://127.0.0.1:9000/v1');
  const req = buildTranscriptionRequest(stt, 'a.wav', 'audio/wav');
  assert.equal(req.url, 'http://127.0.0.1:9000/v1/audio/transcriptions');
  assert.equal(req.headers.Authorization, undefined);
});

test('provider inconnu sans base URL échoue', () => {
  const stt = toSttConfig(loadConfig({ STT_PROVIDER: 'inconnu', STT_API_KEY: '', STT_BASE_URL: '' }));
  assert.throws(() => resolveSttBaseUrl(stt), /STT_BASE_URL/);
});
