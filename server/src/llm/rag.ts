import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db.js';

const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'd', 'l', 's', 'c', 'j', 'm', 't', 'qu',
  'et', 'ou', 'en', 'au', 'aux', 'ce', 'cet', 'cette', 'ces', 'est', 'sont', 'etre', 'avoir',
  'ai', 'as', 'a', 'avons', 'avez', 'ont', 'que', 'qui', 'quoi', 'dans', 'sur', 'pour', 'par',
  'avec', 'sans', 'plus', 'moins', 'tres', 'pas', 'ne', 'il', 'elle', 'ils', 'elles', 'nous',
  'vous', 'je', 'tu', 'on', 'se', 'sa', 'son', 'ses', 'leur', 'leurs', 'mon', 'ma', 'mes', 'ton',
  'ta', 'tes', 'y', 'comment', 'quel', 'quelle', 'quels', 'quelles', 'fait', 'faire',
  "aujourd'hui", 'hier', 'demain', 'alors', 'donc', 'mais', 'car', 'si', 'aussi', 'tout', 'tous',
  'toute', 'toutes', 'autre', 'autres', 'meme', 'memes', 'peut', 'peuvent', 'doit', 'doivent',
  'cela', 'notre', 'votre',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function chunkText(text: string, size = 1200, overlap = 200): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur);
      cur = cur.slice(-overlap) + '\n' + p;
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
    while (cur.length > size) {
      chunks.push(cur.slice(0, size));
      cur = cur.slice(size - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

export async function extractText(filePath: string, mime: string, name: string): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (mime.startsWith('text/') || ['.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }
  if (ext === '.html' || ext === '.htm' || mime.includes('html')) {
    return fs
      .readFileSync(filePath, 'utf8')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
  }
  if (mime === 'application/pdf' || ext === '.pdf') {
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = (mod.default ?? mod) as (data: Buffer) => Promise<{ text: string }>;
    const res = await pdfParse(fs.readFileSync(filePath));
    return res.text ?? '';
  }
  return '';
}

export interface RagHit {
  fileId: number;
  fileName: string;
  score: number;
  snippet: string;
}

export function retrieveRelevantChunks(db: DB, query: string, k: number): RagHit[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const rows = db.listChunks();
  return rows
    .map((r) => {
      const freq = new Map<string, number>();
      for (const t of tokenize(r.content)) freq.set(t, (freq.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of terms) score += (freq.get(t) ?? 0) * (t.length >= 5 ? 1.5 : 1);
      const nameWords = r.name.toLowerCase().split(/[^a-z0-9]+/);
      if (nameWords.some((w) => w.length > 2 && terms.includes(w))) score += 2;
      return { fileId: r.file_id, fileName: r.name, score, snippet: r.content.slice(0, 500) };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function buildDocsSection(hits: RagHit[]): string {
  if (!hits.length) return '';
  return (
    'Documents de référence (extraits les plus pertinents trouvés dans les fichiers déposés sur le serveur) :\n' +
    hits.map((h) => `--- ${h.fileName} ---\n${h.snippet}`).join('\n')
  );
}
