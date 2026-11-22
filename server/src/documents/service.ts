import { DocumentError } from './limits.js';
import type { DocumentIssue } from './issues.js';

export function tikaBase(url: string): URL {
  let base: URL;
  try { base = new URL(url); }
  catch { throw new DocumentError(503, 'Adresse du service documentaire invalide.', 'service-config'); }
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new DocumentError(503, 'Le service documentaire doit être configuré sur le loopback local.', 'service-config');
  }
  return base;
}

const safeCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
function networkCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || !error || typeof error !== 'object') return undefined;
  const value = error as { code?: string; cause?: unknown; errors?: unknown[] };
  if (value.code && safeCodes.has(value.code)) return value.code;
  return networkCode(value.cause, depth + 1) ?? value.errors?.map((item) => networkCode(item, depth + 1)).find(Boolean);
}

export function communicationError(error: unknown, timeout: boolean, cancelled = false): DocumentError {
  if (error instanceof DocumentError) return error;
  if (cancelled) return new DocumentError(503, 'Extraction interrompue pendant l’arrêt du service.', 'cancelled');
  if (timeout) return new DocumentError(503, 'Le service documentaire n’a pas terminé l’opération dans le délai autorisé.', 'timeout');
  const code = networkCode(error);
  return new DocumentError(503, code === 'ECONNREFUSED' ? 'Connexion refusée par le service documentaire.' : code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? 'La connexion au service documentaire a été interrompue.' : 'Impossible de communiquer avec le service documentaire.', 'service-unreachable', code ? { networkCode: code } : undefined);
}

export function httpServiceError(status: number): DocumentError {
  const diagnostic = { httpStatus: status };
  if (status >= 300 && status < 400) return new DocumentError(503, `Le service documentaire renvoie une redirection inattendue (HTTP ${status}).`, 'service-config', diagnostic);
  if ([401, 403].includes(status)) return new DocumentError(503, `Le service documentaire refuse l’accès (HTTP ${status}).`, 'service-config', diagnostic);
  if (status === 404) return new DocumentError(503, 'Le point d’accès documentaire est introuvable (HTTP 404).', 'service-config', diagnostic);
  return new DocumentError(503, `Le service documentaire n’a pas terminé l’opération (HTTP ${status}).`, 'service-http', diagnostic);
}

export interface DocumentServiceHealth {
  available: boolean;
  checkedAt: string;
  version: string | null;
  issue: DocumentIssue | null;
}

export async function checkDocumentService(url: string): Promise<DocumentServiceHealth> {
  const deadline = AbortSignal.timeout(5000);
  try {
    const res = await fetch(new URL('/version', tikaBase(url)), { signal: deadline, redirect: 'manual' });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw httpServiceError(res.status);
    }
    let text = '';
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      text += Buffer.from(chunk).toString('utf8');
      if (text.length > 4096) throw new DocumentError(503, 'La réponse de vérification du service est invalide.', 'invalid-response');
    }
    const version = text.trim().match(/^Apache Tika\s+(\d+\.\d+(?:\.\d+)?(?:[-.][\w-]+)*)$/)?.[1];
    if (!version) throw new DocumentError(503, 'Le service ne renvoie pas une version Apache Tika reconnue.', 'invalid-response');
    if (!/^4\./.test(version) || Number(version.split('.')[1]) < 2) throw new DocumentError(503, 'La version du service documentaire ne correspond pas à la configuration Tika 4.2 ou ultérieure de la branche 4.x.', 'service-config');
    return { available: true, checkedAt: new Date().toISOString(), version, issue: null };
  } catch (error) {
    return { available: false, checkedAt: new Date().toISOString(), version: null, issue: communicationError(error, deadline.aborted).issue };
  }
}
