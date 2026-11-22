import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileResources } from '../documents/resources.js';
import type { Config } from '../config.js';
import type { DB, FileRow } from '../db.js';
import { deriveDocument } from './derive.js';
import { llmConfigured } from './index.js';
import { chunkText } from './rag.js';
import { costUsd } from './pricing.js';
import { isAudioMime, sttConfigured, transcribeFile, type SttProgressCb } from './stt.js';

export interface LinkDeps {
  db: DB;
  config: Config;
  uploadsDir: string;
  userId: number;
  postBot: (content: string) => void;
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./];
const PRIVATE_V6 = [/^::1$/i, /^fe80:/i, /^fc/i, /^fd/i];

export function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) return true;
  if (PRIVATE_V4.some((r) => r.test(hostname))) return true;
  if (PRIVATE_V6.some((r) => r.test(hostname))) return true;
  if (/^\[.+\]$/.test(hostname)) return PRIVATE_V6.some((r) => r.test(hostname.slice(1, -1)));
  return false;
}

export function validateLinkUrl(raw: string, allowlistRaw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('URL invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Protocole non autorisé (http/https uniquement)');
  if (!allowPrivate && isPrivateHost(url.hostname)) throw new Error('Hôte privé/interdit bloqué (protection SSRF)');
  const allowlist = allowlistRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length) {
    const host = url.hostname.toLowerCase();
    const ok = allowlist.some((d) =>
      d.startsWith('*.') ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d || host.endsWith('.' + d),
    );
    if (!ok) throw new Error(`Domaine non autorisé (LINK_FETCH_ALLOWED_DOMAINS) : ${host}`);
  }
  return url;
}

export function guessMimeFromUrl(url: URL, contentType?: string | null): string {
  if (contentType && !contentType.includes('html')) return contentType.split(';')[0].trim();
  const ext = path.extname(url.pathname).toLowerCase();
  const map: Record<string, string> = {
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.webm': 'audio/webm',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.flac': 'audio/flac',
  };
  return map[ext] ?? 'application/octet-stream';
}

export async function fetchToFile(
  url: URL,
  destPath: string,
  maxMb: number,
  onProgress?: (doneBytes: number, totalBytes: number | null) => void,
  resources?: FileResources,
): Promise<{ size: number; contentType: string | null }> {
  const cap = Math.min(maxMb, 50) * 1048576;
  const release = resources?.writer(cap);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);
  timer.unref();
  let created = false;
  try {
    const res = await fetch(url, { signal: abort.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Téléchargement échoué (HTTP ${res.status})`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > cap) { await res.body.cancel(); throw new Error(`Fichier trop gros (> ${maxMb} Mio)`); }
    let size = 0;
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > cap) { callback(new Error(`Fichier trop gros (> ${maxMb} Mio pendant le téléchargement)`)); return; }
      onProgress?.(size, declared > 0 ? declared : null);
      callback(null, chunk);
    } });
    const output = fs.createWriteStream(destPath, { flags: 'wx' });
    created = true;
    await pipeline(Readable.from(res.body as AsyncIterable<Uint8Array>), counter, output, { signal: abort.signal });
    return { size, contentType: res.headers.get('content-type') };
  } catch (error) {
    abort.abort();
    if (created) fs.rmSync(destPath, { force: true });
    throw error;
  } finally { clearTimeout(timer); release?.(); }
}

let ffmpegOk: boolean | null = null;
export function ffmpegAvailable(): boolean {
  if (ffmpegOk !== null) return ffmpegOk;
  try {
    ffmpegOk = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

export async function transcodeToWebm(srcPath: string, dstPath: string, resources?: FileResources): Promise<void> {
  const release = resources?.writer(50 * 1048576);
  try { await new Promise<void>((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-threads', '1', '-i', srcPath, '-vn', '-c:a', 'libopus', '-b:a', '64k', '-threads', '1', '-fs', String(50 * 1048576), dstPath],
      { timeout: 900000, maxBuffer: 4 * 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
  }); } catch (error) { fs.rmSync(dstPath, { force: true }); throw error; }
  finally { release?.(); }
}

async function transcribeAndStore(
  deps: LinkDeps,
  uploadsDir: string,
  fileRow: FileRow,
  displayName: string,
  mime: string,
  onProgress?: SttProgressCb,
): Promise<{ row: FileRow | null; error: string | null }> {
  if (!sttConfigured(deps.config)) return { row: null, error: null };
  try {
    const result = await transcribeFile(deps.config, path.join(uploadsDir, fileRow.path), displayName, mime, onProgress);
    const text = result.text;
    if (!text) return { row: null, error: 'Réponse STT vide' };
    const costPerMin = deps.config.STT_COST_PER_AUDIO_MIN ?? 0;
    const sttCost = result.durationSeconds ? (result.durationSeconds / 60) * costPerMin : 0;
    const date = new Date().toLocaleString('fr-FR');
    const tName = `🎙️ Transcription — ${displayName} (${date}).txt`;
    const tFname = `${Date.now()}-tr-${Math.random().toString(36).slice(2, 8)}.txt`;
    if (deps.config.fileResources) deps.config.fileResources.writeText(path.join(uploadsDir, tFname), text);
    else fs.writeFileSync(path.join(uploadsDir, tFname), text);
    const transcriptRow = deps.db.insertFile(
      deps.db.getBot().id,
      null,
      tName,
      'text/plain',
      Buffer.byteLength(text),
      tFname,
      fileRow.call_id,
    );
    if (deps.config.documents) deps.config.documents.enqueue(deps.db, transcriptRow.id);
    else chunkText(text, deps.config.RAG_CHUNK_SIZE).forEach((c, i) => deps.db.insertChunk(transcriptRow.id, i, c));
    deps.db.insertUsage({
      userId: deps.userId,
      messageId: fileRow.message_id,
      command: 'stt',
      provider: deps.config.STT_PROVIDER,
      model: deps.config.STT_MODEL,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: sttCost,
      error: null,
    });
    deps.db.insertFileEvent({
      fileId: transcriptRow.id,
      folderId: fileRow.folder_id ?? null,
      action: 'file_transcribed',
      detail: `« ${displayName} » transcrit via /lien (${text.length} caractères)`,
      userId: deps.userId,
    });
    return { row: transcriptRow, error: null };
  } catch (err) {
    deps.db.insertUsage({
      userId: deps.userId,
      messageId: fileRow.message_id,
      command: 'stt',
      provider: deps.config.STT_PROVIDER,
      model: deps.config.STT_MODEL,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    return { row: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseLienArg(arg: string): { url: string; title: string } {
  const m = arg.trim().match(/^(https?:\/\/\S+)(?:\s+(.+))?$/s);
  if (!m) throw new Error('Usage : /lien <url> [titre]');
  return { url: m[1], title: (m[2] ?? '').trim() };
}

export async function handleLinkCommand(deps: LinkDeps, msg: { id: number; content: string }, arg: string): Promise<void> {
  const { uploadsDir } = deps;
  fs.mkdirSync(uploadsDir, { recursive: true });
  let parsed: { url: string; title: string };
  try {
    parsed = parseLienArg(arg);
  } catch (err) {
    deps.postBot(err instanceof Error ? err.message : 'Usage : /lien <url> [titre]');
    return;
  }
  const { url: rawUrl, title } = parsed;
  let url: URL;
  try {
    url = validateLinkUrl(rawUrl, deps.config.LINK_FETCH_ALLOWED_DOMAINS, deps.config.LINK_FETCH_ALLOW_PRIVATE === '1');
  } catch (err) {
    deps.postBot(`Lien refusé : ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const label = title || url.hostname + url.pathname;
  deps.postBot(`🔗 Téléchargement de « ${label} »…`);
  // messages d'avancement postés par le bot (throttlés à 1 toutes les 15 s, forcés aux jalons)
  let lastProgressPost = 0;
  const postProgress = (text: string, force = false) => {
    const now = Date.now();
    if (force || now - lastProgressPost >= 15000) {
      lastProgressPost = now;
      deps.postBot(text);
    }
  };
  try {
    const baseName = path.basename(url.pathname) || 'media';
    const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'media';
    const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}`;
    const dest = path.join(uploadsDir, storedName);
    const { size, contentType } = await fetchToFile(url, dest, deps.config.MAX_LINK_FETCH_MB, (done, total) => {
      const pct = total ? Math.round((done / total) * 100) : null;
      postProgress(`⬇️ Téléchargement… ${(done / 1048576).toFixed(0)} Mo${pct !== null ? ` (${pct} %)` : ''}`, pct === 100);
    }, deps.config.fileResources);
    const mime = guessMimeFromUrl(url, contentType);
    const displayName = safeBase;
    const fileRow = deps.db.insertFile(deps.userId, msg.id, displayName, mime, size, storedName);
    deps.db.insertFileEvent({
      fileId: fileRow.id,
      folderId: null,
      action: 'file_created',
      detail: `« ${displayName} » téléchargé via /lien (${(size / 1048576).toFixed(1)} Mo, ${url.hostname})`,
      userId: deps.userId,
    });

    deps.config.documents?.enqueue(deps.db, fileRow.id);

    let transcriptRow: FileRow | null = null;
    let sttError: string | null = null;
    let webmRow: FileRow | null = null;
    let crRow: FileRow | null = null;

    if (isAudioMime(mime, displayName)) {
      deps.postBot(
        sttConfigured(deps.config)
          ? `🎙️ « ${label} » téléchargé (${(size / 1048576).toFixed(1)} Mo). Transcription STT en cours…`
          : `🎙️ « ${label} » téléchargé (${(size / 1048576).toFixed(1)} Mo). STT non configuré : pas de transcription (voir STT_* dans le .env, puis redémarrer le conteneur)`,
      );
      const tr = await transcribeAndStore(deps, uploadsDir, fileRow, displayName, mime, (p) => {
        if (p.phase === 'start') {
          postProgress(`🎙️ Transcription STT en cours (${p.sizeMb?.toFixed(0)} Mo — un long audio peut prendre plusieurs minutes)…`, true);
        } else if (p.phase === 'prepare') {
          postProgress(`⚙️ Compression 16 kHz mono avant envoi (${p.sizeMb?.toFixed(0)} Mo)…`, true);
        } else if (p.phase === 'segment') {
          postProgress(`🎙️ Transcription : segment ${p.segment}/${p.totalSegments} OK…`, true);
        }
      });
      transcriptRow = tr.row;
      sttError = tr.error;
      if (transcriptRow && ffmpegAvailable()) {
        try {
          const webmName = `${Date.now()}-webm-${Math.random().toString(36).slice(2, 8)}.webm`;
          await transcodeToWebm(dest, path.join(uploadsDir, webmName), deps.config.fileResources);
          const webmPath = path.join(uploadsDir, webmName);
          const webmSize = fs.statSync(webmPath).size;
          webmRow = deps.db.insertFile(deps.db.getBot().id, null, displayName.replace(/\.[^.]+$/, '') + '.webm', 'audio/webm', webmSize, webmName, null);
          deps.config.documents?.enqueue(deps.db, webmRow.id);
        } catch {
          // transcodage best-effort
        }
      }
      if (transcriptRow && llmConfigured(deps.config)) {
        try {
          await deps.config.documents?.waitReady(deps.db, transcriptRow.id);
          crRow = await deriveDocument({ db: deps.db, config: deps.config, userId: deps.userId, uploadsDir }, transcriptRow, 'cr');
        } catch {
          // CR best-effort
        }
      }
    }

    const lines = [
      `🔗 ${label}`,
      `Original : ${displayName} (${(size / 1048576).toFixed(1)} Mo, ${mime})`,
      url.href,
    ];
    if (transcriptRow) lines.push(`Transcription : ${transcriptRow.name} (espace documentaire, indexée RAG)`);
    else if (isAudioMime(mime, displayName)) {
      lines.push(
        sttError
          ? `Transcription : échec STT — ${sttError} (le fichier reste disponible, réessaie avec 🎙️ dans l'espace documentaire)`
          : 'Transcription : STT non configuré (voir STT_* dans le .env, puis redémarrer le conteneur)',
      );
    }
    if (webmRow) lines.push(`Copie webm (opus 64k) : ${webmRow.name} — ${(webmRow.size / 1048576).toFixed(1)} Mo`);
    if (crRow) lines.push(`Compte-rendu généré : ${crRow.name}`);
    deps.postBot(lines.join('\n'));
  } catch (err) {
    deps.postBot(`Erreur /lien : ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function maybeAutoLink(deps: LinkDeps, msg: { id: number; content: string }): Promise<boolean> {
  const m = msg.content.trim().match(/^(https?:\/\/\S+\.(?:m4a|mp3|wav|ogg|oga|webm|flac|mp4|m4v))$/i);
  if (!m) return false;
  await handleLinkCommand(deps, msg, m[1]);
  return true;
}
