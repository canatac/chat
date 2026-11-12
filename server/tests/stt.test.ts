import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  buildTranscriptionRequest,
  parseTranscriptionVerboseJson,
  resolveSttBaseUrl,
  sttConfigured,
  toSttConfig,
} from '../src/llm/stt.js';

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

test('buildTranscriptionRequest : response_format text par défaut, verbose_json si coût suivi', () => {
  const stt = toSttConfig(loadConfig({ STT_PROVIDER: 'openai', STT_API_KEY: 'k' }));
  assert.equal(buildTranscriptionRequest(stt, 'a.webm', 'audio/webm').responseFormat, 'text');
  assert.equal(buildTranscriptionRequest(stt, 'a.webm', 'audio/webm', true).responseFormat, 'verbose_json');
});

test('parseTranscriptionVerboseJson extrait texte et durée (billing à la minute)', () => {
  const r1 = parseTranscriptionVerboseJson({ text: 'bonjour', duration: 42.5 });
  assert.equal(r1.text, 'bonjour');
  assert.equal(r1.durationSeconds, 42.5);
  const r2 = parseTranscriptionVerboseJson({ text: 'salut', usage: { duration: 12 } });
  assert.equal(r2.durationSeconds, 12);
  const r3 = parseTranscriptionVerboseJson({ text: 'hey', usage: { seconds: 7 } });
  assert.equal(r3.durationSeconds, 7);
  assert.throws(() => parseTranscriptionVerboseJson({}), /invalide/);
});

test('config Scaleway MaaS : base api.scaleway.ai + modèle whisper-large-v3', () => {
  const cfg2 = loadConfig({
    STT_PROVIDER: 'openai-compatible',
    STT_BASE_URL: 'https://api.scaleway.ai/v1',
    STT_API_KEY: 'SCWXXXXXXXX',
    STT_MODEL: 'whisper-large-v3',
    STT_LANGUAGE: 'fr',
    STT_COST_PER_AUDIO_MIN: '0.0032',
  });
  assert.equal(sttConfigured(cfg2), true);
  const req = buildTranscriptionRequest(toSttConfig(cfg2), 'appel.webm', 'audio/webm', true);
  assert.equal(req.url, 'https://api.scaleway.ai/v1/audio/transcriptions');
  assert.equal(req.headers.Authorization, 'Bearer SCWXXXXXXXX');
  assert.equal(req.model, 'whisper-large-v3');
  assert.equal(req.language, 'fr');
  assert.equal(req.responseFormat, 'verbose_json');
});
