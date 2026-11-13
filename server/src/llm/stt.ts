import fs from 'node:fs';
import type { Config } from '../config.js';

export interface SttConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  language?: string;
}

const STT_BASES: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  'openai-compatible': 'https://api.openai.com/v1',
};

export function toSttConfig(cfg: Config): SttConfig {
  return {
    provider: cfg.STT_PROVIDER,
    baseUrl: cfg.STT_BASE_URL || undefined,
    apiKey: cfg.STT_API_KEY || cfg.LLM_API_KEY || undefined,
    model: cfg.STT_MODEL,
    language: cfg.STT_LANGUAGE || undefined,
  };
}

export function sttConfigured(cfg: Config): boolean {
  const stt = toSttConfig(cfg);
  return Boolean(stt.baseUrl || stt.apiKey);
}

export function isAudioMime(mime: string, name: string): boolean {
  return mime.startsWith('audio/') || /\.(webm|mp3|wav|m4a|ogg|oga|mp4|flac)$/i.test(name);
}

export function resolveSttBaseUrl(stt: SttConfig): string {
  if (stt.baseUrl) return stt.baseUrl.replace(/\/+$/, '');
  const known = STT_BASES[stt.provider.toLowerCase()];
  if (known) return known;
  throw new Error(`STT_BASE_URL requis pour le provider STT "${stt.provider}"`);
}

export interface TranscriptionRequest {
  url: string;
  headers: Record<string, string>;
  model: string;
  language?: string;
  responseFormat: string;
  filename: string;
  mime: string;
}

export function buildTranscriptionRequest(stt: SttConfig, filename: string, mime: string, withDuration = false): TranscriptionRequest {
  return {
    url: `${resolveSttBaseUrl(stt)}/audio/transcriptions`,
    headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : {},
    model: stt.model,
    language: stt.language,
    responseFormat: withDuration ? 'verbose_json' : 'text',
    filename,
    mime,
  };
}

export interface TranscriptionResult {
  text: string;
  durationSeconds: number | null;
}

export function parseTranscriptionVerboseJson(json: unknown): TranscriptionResult {
  const j = json as { text?: string; duration?: number; usage?: { duration?: number; seconds?: number; input_tokens?: number } };
  const durationSeconds = j.duration ?? j.usage?.duration ?? j.usage?.seconds ?? null;
  const text = j.text ?? '';
  if (!text) throw new Error('Réponse STT invalide (pas de texte)');
  return { text, durationSeconds };
}

export async function transcribeFile(cfg: Config, filePath: string, filename: string, mime: string): Promise<TranscriptionResult> {
  const stt = toSttConfig(cfg);
  const withDuration = cfg.STT_COST_PER_AUDIO_MIN !== undefined;
  const req = buildTranscriptionRequest(stt, filename, mime, withDuration);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: mime || 'application/octet-stream' }), filename);
  fd.append('model', req.model);
  fd.append('response_format', req.responseFormat);
  if (req.language) fd.append('language', req.language);
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: fd,
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Erreur STT (HTTP ${res.status}) : ${detail.slice(0, 300)}`);
  }
  if (withDuration) {
    return parseTranscriptionVerboseJson(await res.json());
  }
  return { text: (await res.text()).trim(), durationSeconds: null };
}
