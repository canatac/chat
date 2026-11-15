import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  buildTranscriptionRequest,
  ffmpegAvailable,
  isAudioMime,
  parseTranscriptionVerboseJson,
  resolveSttBaseUrl,
  sttConfigured,
  toSttConfig,
  transcribeFile,
  type SttProgress,
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

test('isAudioMime reconnaît les mime audio et extensions usuelles', () => {
  assert.equal(isAudioMime('audio/webm', 'appel.webm'), true);
  assert.equal(isAudioMime('audio/mpeg', 'x'), true);
  assert.equal(isAudioMime('application/octet-stream', 'note.mp3'), true);
  assert.equal(isAudioMime('application/octet-stream', 'rapport.pdf'), false);
  assert.equal(isAudioMime('text/plain', 'compte.txt'), false);
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

test('config : STT_MAX_FILE_MB=24 et STT_CHUNK_MINUTES=10 par défaut, surchargeables', () => {
  const c = loadConfig({});
  assert.equal(c.STT_MAX_FILE_MB, 24);
  assert.equal(c.STT_CHUNK_MINUTES, 10);
  const c2 = loadConfig({ STT_MAX_FILE_MB: '50', STT_CHUNK_MINUTES: '15' });
  assert.equal(c2.STT_MAX_FILE_MB, 50);
  assert.equal(c2.STT_CHUNK_MINUTES, 15);
});

async function withMockStt(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, calls: { n: number }) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const http = await import('node:http');
  const calls = { n: 0 };
  const srv = http.createServer((req, res) => {
    calls.n++;
    handler(req, res, calls);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const port = (srv.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
  return void calls;
}

function sttCfg(baseUrl: string, extra: Record<string, string> = {}) {
  return loadConfig({
    STT_PROVIDER: 'openai-compatible',
    STT_BASE_URL: baseUrl,
    STT_API_KEY: 'k',
    STT_MODEL: 'whisper-large-v3',
    STT_LANGUAGE: 'fr',
    STT_COST_PER_AUDIO_MIN: '0.0032',
    ...extra,
  });
}

test('transcribeFile : fichier sous la limite = 1 appel direct vers le STT (mock) + jalons start/done', async () => {
  let calls = 0;
  await withMockStt(
    (_req, res, c) => {
      calls = c.n;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'transcription de test', duration: 12 }));
    },
    async (baseUrl) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
      try {
        const f = path.join(dir, 'note.webm');
        fs.writeFileSync(f, Buffer.alloc(1024, 1));
        const events: SttProgress[] = [];
        const r = await transcribeFile(sttCfg(baseUrl), f, 'note.webm', 'audio/webm', (p) => events.push(p));
        assert.equal(calls, 1);
        assert.equal(r.text, 'transcription de test');
        assert.equal(r.durationSeconds, 12);
        assert.equal(events[0]?.phase, 'start');
        assert.equal(events[events.length - 1]?.phase, 'done');
        assert.equal(events[events.length - 1]?.durationSeconds, 12);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

test('transcribeFile : une erreur HTTP du STT est remontée explicitement (HTTP 401 + détail)', async () => {
  await withMockStt(
    (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    },
    async (baseUrl) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
      try {
        const f = path.join(dir, 'note.webm');
        fs.writeFileSync(f, Buffer.alloc(1024, 1));
        await assert.rejects(() => transcribeFile(sttCfg(baseUrl), f, 'note.webm', 'audio/webm'), /HTTP 401.*Invalid API key/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

test('transcribeFile : gros fichier sans ffmpeg -> erreur explicite (pas de "non configuré" silencieux)', async (t) => {
  if (ffmpegAvailable()) return t.skip('ffmpeg présent : couvert par le test de découpage');
  await withMockStt(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'x', duration: 1 }));
    },
    async (baseUrl) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
      try {
        const f = path.join(dir, 'gros.m4a');
        fs.writeFileSync(f, Buffer.alloc(2 * 1024 * 1024, 1)); // 2 Mo > STT_MAX_FILE_MB=1
        await assert.rejects(
          () => transcribeFile(sttCfg(baseUrl, { STT_MAX_FILE_MB: '1' }), f, 'gros.m4a', 'audio/mp4'),
          /trop gros.*ffmpeg indisponible/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

test('transcribeFile : gros fichier avec ffmpeg -> compression 16k mono puis segments recousus (5 appels pour 5 min avec STT_CHUNK_MINUTES=1) + jalons prepare/segment/done', async (t) => {
  if (!ffmpegAvailable()) return t.skip('ffmpeg absent dans cet environnement');
  const { execFileSync } = await import('node:child_process');
  let calls = 0;
  await withMockStt(
    (_req, res, c) => {
      calls = c.n;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: `partie ${c.n}`, duration: 60 }));
    },
    async (baseUrl) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
      try {
        const wav = path.join(dir, 'long.wav');
        // 300 s de silence 16 kHz mono = 9,6 Mo > STT_MAX_FILE_MB=1 -> downscale opus 32k (~1,2 Mo > 1 Mo) -> 5 segments de 60 s
        execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '300', wav], { stdio: 'ignore' });
        const events: SttProgress[] = [];
        const r = await transcribeFile(sttCfg(baseUrl, { STT_MAX_FILE_MB: '1', STT_CHUNK_MINUTES: '1' }), wav, 'long.wav', 'audio/wav', (p) => events.push(p));
        assert.equal(calls, 5);
        assert.ok(r.text.includes('partie 1'));
        assert.ok(r.text.includes('partie 5'));
        assert.equal(r.durationSeconds, 300);
        assert.ok(events.some((e) => e.phase === 'prepare'));
        const segs = events.filter((e) => e.phase === 'segment');
        assert.equal(segs.length, 5);
        assert.deepEqual(segs.map((e) => e.segment), [1, 2, 3, 4, 5]);
        assert.ok(segs.every((e) => e.totalSegments === 5));
        assert.equal(events[events.length - 1]?.phase, 'done');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
