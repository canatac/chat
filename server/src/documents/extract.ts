import fs from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import { DOCUMENT_LIMITS as limits, DocumentError } from './limits.js';
import { communicationError, httpServiceError, tikaBase } from './service.js';

const textExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml']);
const supportedTypes = /^(text\/|image\/(png|jpeg|tiff|bmp|webp)$|application\/(pdf|rtf|epub\+zip|xml|json|vnd\.ms-|msword|vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.))/;
const meaningful = (value: unknown) => value !== undefined && value !== null && !['', 'false', '0'].includes(String(value).toLowerCase());

export function tikaMetadataText(value: unknown): string {
  if (!Array.isArray(value) || !value.length) throw new DocumentError(503, 'Le service documentaire a renvoyé une structure de réponse invalide.', 'invalid-response');
  if (value.length > limits.embeddedCount + 1) throw new DocumentError(413, 'Le document contient trop de pièces intégrées.', 'size-limit');
  const pieces: string[] = [];
  let chars = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DocumentError(503, 'Le service documentaire a renvoyé des métadonnées invalides.', 'invalid-response');
    const metadata = item as Record<string, unknown>;
    for (const [key, val] of Object.entries(metadata)) {
      // Les réponses HTTP 200 peuvent elles aussi contenir une extraction partielle.
      if ((/^(tk:exception:|X-TIKA:EXCEPTION)/i.test(key) || /truncat|skipped|partial|limit.*reached/i.test(key)) && meaningful(val)) {
        if (/write.?limit/i.test(key)) throw new DocumentError(413, 'Analyse incomplète : le texte extrait dépasse la limite de 200 000 caractères.', 'text-limit');
        if (/embedded.*(depth|resource|count).*limit|limit.*(depth|resource|count)/i.test(key)) throw new DocumentError(413, 'La limite de pièces intégrées ou de profondeur du document est atteinte.', 'size-limit');
        if (/timeout|deadline/i.test(key)) throw new DocumentError(503, 'Le service a interrompu l’extraction avant sa fin après un délai dépassé.', 'timeout');
        throw new DocumentError(422, 'Analyse incomplète : limite atteinte ou contenu illisible. Scinder le document puis réessayer.', 'partial');
      }
    }
    const type = String(metadata['Content-Type'] ?? '').split(';')[0];
    if (!supportedTypes.test(type)) throw new DocumentError(415, 'Format non pris en charge pour l’IA. Fournir un PDF, une image ou un document bureautique.');
    const pages = Number(metadata['xmpTPg:NPages'] ?? metadata['meta:page-count'] ?? 0);
    if (pages > limits.pdfPages) throw new DocumentError(413, `PDF limité à ${limits.pdfPages} pages. Scinder le document.`, 'page-limit');
    if (type === 'application/pdf' && (!Number.isFinite(pages) || pages < 1)) throw new DocumentError(422, 'Nombre de pages PDF indéterminé : analyse refusée.');
    if (String(metadata['pdf:encrypted']) === 'true') throw new DocumentError(422, 'Document chiffré : fournir une copie déchiffrée.', 'encrypted');
    const text = metadata['tk:content'] ?? metadata['X-TIKA:content'] ?? '';
    if (typeof text !== 'string') throw new DocumentError(422, 'Texte documentaire invalide.', 'invalid-response');
    chars += text.length + 2;
    if (chars > limits.textChars) throw new DocumentError(413, `Texte limité à ${limits.textChars.toLocaleString('fr-FR')} caractères. Scinder le document.`, 'text-limit');
    // Les métadonnées peuvent contenir des auteurs, adresses et propriétés sensibles.
    const properties = Object.entries(metadata).filter(([key]) => !/^(tk:|X-TIKA:)/i.test(key));
    pieces.push(text, JSON.stringify(Object.fromEntries(properties)));
  }
  const text = pieces.join('\n\n');
  if (text.length > limits.textChars) throw new DocumentError(413, 'Texte et métadonnées trop volumineux. Scinder le document.', 'text-limit');
  if (!pieces.some((part, i) => i % 2 === 0 && part.trim())) throw new DocumentError(422, 'Aucun texte lisible. Fournir un scan plus net ou une version texte.', 'empty');
  return text;
}

export async function extractDocument(filePath: string, _mime: string, name: string, tikaUrl = 'http://127.0.0.1:9998', signal?: AbortSignal): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > limits.fileBytes) throw new DocumentError(413, 'Analyse documentaire limitée à 10 Mio par fichier.');
  // Un seul appel est actif dans la file globale ; le buffer reste borné à 10 Mio.
  const bytes = await fs.readFile(filePath);
  const ext = path.extname(name).toLowerCase();
  const binaryMagic = bytes.subarray(0, 12).toString('latin1');
  if (textExtensions.has(ext) && !/^(%PDF-|PK\x03\x04|\xD0\xCF|\x89PNG|\xFF\xD8|GIF8|RIFF)/.test(binaryMagic)) {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new DocumentError(422, 'Texte illisible : convertir le fichier en UTF-8.'); }
    if (text.includes('\0')) throw new DocumentError(415, 'Contenu binaire présenté comme un fichier texte.');
    if (text.length > limits.textChars) throw new DocumentError(413, 'Texte limité à 200 000 caractères. Scinder le document.', 'text-limit');
    if (!text.trim()) throw new DocumentError(422, 'Aucun texte exploitable dans ce fichier.', 'empty');
    return text;
  }
  try {
    const dimensions = imageSize(bytes);
    const images = dimensions.images ?? [dimensions];
    if (images.length > limits.pdfPages || images.some(({ width, height }) => !width || !height || width * height > limits.imagePixels)) {
      throw new DocumentError(413, 'Image limitée à 16 mégapixels et TIFF à 20 pages. Réduire ou scinder le fichier.');
    }
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    if (/^\.(png|jpe?g|tiff?|bmp|webp)$/i.test(ext)) throw new DocumentError(422, 'En-tête d’image illisible.');
  }
  const base = tikaBase(tikaUrl);
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    const response = await fetch(new URL('/rmeta/text', base), {
      method: 'PUT', body: bytes, redirect: 'manual', signal: requestSignal,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)}"`, Accept: 'application/json' },
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      if (response.status === 429) throw new DocumentError(429, 'Analyse documentaire occupée. Réessayer plus tard.', 'service-busy', { httpStatus: response.status });
      if (response.status === 413) throw new DocumentError(413, 'Document trop volumineux. Scinder le fichier.', 'size-limit', { httpStatus: response.status });
      if (response.status === 422) throw new DocumentError(422, 'Document illisible ou chiffré. Fournir une copie déchiffrée, un scan plus net ou une version texte.', 'unreadable', { httpStatus: response.status });
      if (response.status === 200) throw new DocumentError(503, 'Le service documentaire a renvoyé une réponse vide.', 'invalid-response');
      throw httpServiceError(response.status);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of response.body as AsyncIterable<Uint8Array>) {
      size += part.byteLength;
      if (size > limits.responseBytes) throw new DocumentError(413, 'Réponse documentaire trop volumineuse. Scinder le fichier.');
      chunks.push(Buffer.from(part));
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new DocumentError(503, 'Le service documentaire n’a pas renvoyé un JSON valide.', 'invalid-response', { httpStatus: response.status }); }
    return tikaMetadataText(value);
  } catch (error) {
    throw communicationError(error, deadline.aborted, Boolean(signal?.aborted));
  }
}
