import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export interface SttProgress {
  phase: 'start' | 'prepare' | 'segment' | 'done';
  sizeMb?: number;
  segment?: number;
  totalSegments?: number;
  durationSeconds?: number | null;
}

export type SttProgressCb = (p: SttProgress) => void;

export function parseTranscriptionVerboseJson(json: unknown): TranscriptionResult {
  const j = json as { text?: string; duration?: number; usage?: { duration?: number; seconds?: number; input_tokens?: number } };
  const durationSeconds = j.duration ?? j.usage?.duration ?? j.usage?.seconds ?? null;
  const text = j.text ?? '';
  if (!text) throw new Error('Réponse STT invalide (pas de texte)');
  return { text, durationSeconds };
}

export function ffmpegAvailable(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function runFfmpeg(args: string[], timeoutMs = 900_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
  });
}

function ffprobeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { timeout: 60_000 },
      (err, stdout) => {
        if (err) return reject(err);
        const d = Number.parseFloat(String(stdout).trim());
        if (!Number.isFinite(d) || d <= 0) return reject(new Error('durée audio introuvable (ffprobe)'));
        resolve(d);
      },
    );
  });
}

function lastWords(text: string, n = 30): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(-n).join(' ');
}

async function transcribeOneFile(
  cfg: Config,
  stt: SttConfig,
  filePath: string,
  filename: string,
  mime: string,
  prompt: string | null,
): Promise<TranscriptionResult> {
  const withDuration = cfg.STT_COST_PER_AUDIO_MIN !== undefined;
  const req = buildTranscriptionRequest(stt, filename, mime, withDuration);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: mime || 'application/octet-stream' }), filename);
  fd.append('model', req.model);
  fd.append('response_format', req.responseFormat);
  if (req.language) fd.append('language', req.language);
  if (prompt) fd.append('prompt', prompt); // amorçage : derniers mots du segment précédent (évite les répétitions en jonction)
  // Timeout dimensionné à la taille du fichier (gros médias, ex. 1 h d'émission ~ 80 Mo) :
  // 5 min de base + ~6 s par Mo, minimum 5 min.
  const sizeMb = fs.statSync(filePath).size / 1048576;
  const timeoutMs = Math.max(300_000, 300_000 + Math.round(sizeMb) * 6_000);
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: fd,
    signal: AbortSignal.timeout(timeoutMs),
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

/**
 * Transcrit un fichier audio. Si le fichier dépasse STT_MAX_FILE_MB (limite usuelle des API STT,
 * ~25 Mo), il est d'abord compressé en 16 kHz mono opus 32k via ffmpeg (présent dans l'image Docker) ;
 * s'il reste trop gros (audio très long), il est découpé en segments de STT_CHUNK_MINUTES transcrits
 * un par un et recousus, chaque segment recevant comme `prompt` les derniers mots du précédent.
 * `onProgress` (optionnel) reçoit les jalons start / prepare / segment i/N / done.
 */
export async function transcribeFile(
  cfg: Config,
  filePath: string,
  filename: string,
  mime: string,
  onProgress?: SttProgressCb,
): Promise<TranscriptionResult> {
  const stt = toSttConfig(cfg);
  const sizeBytes = fs.statSync(filePath).size;
  const maxBytes = (cfg.STT_MAX_FILE_MB ?? 24) * 1048576;
  if (sizeBytes <= maxBytes) {
    onProgress?.({ phase: 'start', sizeMb: sizeBytes / 1048576 });
    const r = await transcribeOneFile(cfg, stt, filePath, filename, mime, null);
    onProgress?.({ phase: 'done', durationSeconds: r.durationSeconds });
    return r;
  }
  if (!ffmpegAvailable()) {
    throw new Error(
      `Fichier trop gros pour le STT (${(sizeBytes / 1048576).toFixed(1)} Mo > ${cfg.STT_MAX_FILE_MB ?? 24} Mo) et ffmpeg indisponible pour le découper`,
    );
  }
  const tmp = path.join(os.tmpdir(), `stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`);
  try {
    onProgress?.({ phase: 'prepare', sizeMb: sizeBytes / 1048576 });
    await runFfmpeg(['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', tmp]);
    const tmpSize = fs.statSync(tmp).size;
    if (tmpSize <= maxBytes) {
      const r = await transcribeOneFile(cfg, stt, tmp, filename.replace(/\.[^.]+$/i, '') + '.webm', 'audio/webm', null);
      onProgress?.({ phase: 'done', durationSeconds: r.durationSeconds });
      return r;
    }
    const duration = await ffprobeDurationSeconds(tmp);
    const chunkSec = Math.max(60, (cfg.STT_CHUNK_MINUTES ?? 10) * 60);
    const nChunks = Math.max(1, Math.ceil(duration / chunkSec));
    const parts: string[] = [];
    let totalDuration = 0;
    let prompt: string | null = null;
    for (let i = 0; i < nChunks; i++) {
      const seg = path.join(os.tmpdir(), `stt-seg-${Date.now()}-${i}.webm`);
      try {
        await runFfmpeg([
          '-y',
          '-ss',
          String(Math.floor(i * chunkSec)),
          '-t',
          String(Math.ceil(chunkSec)),
          '-i',
          tmp,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'libopus',
          '-b:a',
          '32k',
          seg,
        ]);
        const r = await transcribeOneFile(cfg, stt, seg, `segment-${i + 1}.webm`, 'audio/webm', prompt);
        parts.push(r.text.trim());
        totalDuration += r.durationSeconds ?? 0;
        prompt = r.text.trim() ? lastWords(r.text, 30) : null;
        onProgress?.({ phase: 'segment', segment: i + 1, totalSegments: nChunks });
      } finally {
        fs.rmSync(seg, { force: true });
      }
    }
    const text = parts.filter(Boolean).join('\n\n').trim();
    if (!text) throw new Error('Réponse STT invalide (pas de texte)');
    const result: TranscriptionResult = { text, durationSeconds: totalDuration > 0 ? totalDuration : null };
    onProgress?.({ phase: 'done', durationSeconds: result.durationSeconds });
    return result;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
