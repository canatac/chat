import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { DB, FileRow } from '../db.js';
import { askLLM, llmConfigured } from './index.js';
import { chunkText, extractText } from './rag.js';
import { costUsd } from './pricing.js';
import type { ChatMessage } from './providers.js';

export type DeriveKind = 'resume' | 'cr';

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function derivePrompt(kind: DeriveKind, transcript: string): string {
  if (kind === 'resume') {
    return `Voici la transcription brute d'un appel d'équipe :\n\n${transcript}\n\nRédige un résumé en 10 à 15 lignes maximum : contexte de l'appel, points principaux abordés, décisions éventuelles, actions à suivre. Ne invente rien : si la transcription est illisible ou hors sujet, dis-le clairement.`;
  }
  return `Voici la transcription brute d'un appel d'équipe :\n\n${transcript}\n\nRédige un compte-rendu standard et propre de cette réunion, structuré ainsi : date et objet si identifiables, participants mentionnés, points abordés, décisions prises, actions à suivre (avec responsable si identifiable dans la transcription), questions ouvertes. Ne invente rien : si la transcription est illisible, partielle ou hors sujet, dis-le clairement au lieu de fabriquer un compte-rendu.`;
}

export interface DeriveDeps {
  db: DB;
  config: Config;
  userId: number;
  uploadsDir: string;
}

export async function deriveDocument(deps: DeriveDeps, file: FileRow, kind: DeriveKind): Promise<FileRow> {
  const abs = path.join(deps.uploadsDir, file.path);
  const text = await extractText(abs, file.mime, file.name);
  if (!text.trim()) throw new HttpError(400, "Pas de texte exploitable dans ce fichier (transcription ou document texte requis)");
  if (text.trim().length < 100) throw new HttpError(422, "Transcription trop courte ou vide (< 100 caractères) — l'enregistrement était probablement muet/inaudible. Vérifie le fichier audio puis regénère.");
  if (!llmConfigured(deps.config)) throw new HttpError(503, 'LLM non configuré : définir LLM_MODEL dans le .env pour générer un résumé / compte-rendu');
  const messages: ChatMessage[] = [{ role: 'user', content: derivePrompt(kind, text.slice(0, 60000)) }];
  const { text: out, usage } = await askLLM(deps.config, messages, { timeoutMs: 120000, temperature: 0.2 });
  deps.db.insertUsage({
    userId: deps.userId,
    messageId: null,
    command: `derive-${kind}`,
    provider: deps.config.LLM_PROVIDER,
    model: deps.config.LLM_MODEL ?? '',
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    costUsd: costUsd(usage, deps.config.LLM_MODEL ?? '', deps.config),
    error: null,
  });
  const base = file.name.replace(/\.[^.]+$/, '');
  const outName = `${base} — ${kind === 'resume' ? 'résumé' : 'compte-rendu'}.md`;
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${outName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)}`;
  fs.writeFileSync(path.join(deps.uploadsDir, fname), out);
  const row = deps.db.insertFile(deps.userId, null, outName, 'text/markdown', Buffer.byteLength(out), fname, file.call_id);
  chunkText(out, deps.config.RAG_CHUNK_SIZE).forEach((c, i) => deps.db.insertChunk(row.id, i, c));
  return row;
}
