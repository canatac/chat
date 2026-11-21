import http from 'node:http';

export const LINGUARD_URL = 'http://127.0.0.1:8898';
export const MAX_ANALYZE_BYTES = 16 * 1024 * 1024;

export interface Entity {
  type: string;
  start: number;
  end: number;
  score: number;
  text: string;
}

export interface Analysis {
  texts: Entity[][];
  model_errors: unknown[];
}

export interface DetectionMetadata {
  types: string[];
  count: number;
  maxScore: number | null;
}

export type ModelErrorPolicy = 'fail-closed' | 'fail-open';
export type LinGuardErrorCode = 'unavailable' | 'timeout' | 'bad-request' | 'engine-error' | 'not-found' | 'invalid-response' | 'too-large' | 'model-errors';

const messages: Record<LinGuardErrorCode, string> = {
  unavailable: 'Le service local MaelGard LinGuard est indisponible. Envoi à l’IA bloqué.',
  timeout: 'Le service local MaelGard LinGuard ne répond pas à temps. Envoi à l’IA bloqué.',
  'bad-request': 'LinGuard a refusé la requête d’analyse. Envoi à l’IA bloqué.',
  'engine-error': 'Le moteur local LinGuard a échoué. Envoi à l’IA bloqué.',
  'not-found': 'La route LinGuard v1 est indisponible. Envoi à l’IA bloqué.',
  'invalid-response': 'La réponse de LinGuard est invalide. Envoi à l’IA bloqué.',
  'too-large': 'Le texte ou le corps JSON dépasse la limite LinGuard de 16 Mio. Envoi à l’IA bloqué.',
  'model-errors': 'Au moins un modèle LinGuard est indisponible. Envoi à l’IA bloqué par la politique.',
};

export class LinGuardError extends Error {
  constructor(readonly code: LinGuardErrorCode, readonly metadata?: DetectionMetadata) {
    super(messages[code]);
    this.name = 'LinGuardError';
  }
}

export function detectionMetadata(entities: Entity[][]): DetectionMetadata {
  const all = entities.flat();
  return {
    types: [...new Set(all.map((entity) => entity.type))].sort(),
    count: all.length,
    maxScore: all.length ? all.reduce((maximum, entity) => Math.max(maximum, entity.score), -Infinity) : null,
  };
}

function encoded(text: string): Buffer {
  if (typeof text !== 'string') throw new LinGuardError('bad-request');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) throw new LinGuardError('bad-request');
  if (bytes.length > MAX_ANALYZE_BYTES) throw new LinGuardError('too-large');
  return bytes;
}

function validateOffsets(bytes: Buffer, entity: Pick<Entity, 'start' | 'end'>): void {
  const boundary = (index: number) => Number.isSafeInteger(index) && index >= 0 && index <= bytes.length
    && (index === bytes.length || (bytes[index] & 0xc0) !== 0x80);
  if (!boundary(entity.start) || !boundary(entity.end) || entity.end <= entity.start) throw new LinGuardError('invalid-response');
}

export function displayOffsets(text: string, entity: Pick<Entity, 'start' | 'end'>): { start: number; end: number } {
  const bytes = encoded(text);
  validateOffsets(bytes, entity);
  // Les offsets de l’API sont en octets. slice() dans JavaScript utilise UTF-16.
  return { start: bytes.subarray(0, entity.start).toString('utf8').length, end: bytes.subarray(0, entity.end).toString('utf8').length };
}

export function maskText(text: string, entities: Entity[]): string {
  const bytes = encoded(text);
  const spans: { start: number; end: number; types: Set<string> }[] = [];
  for (const entity of [...entities].sort((left, right) => left.start - right.start || right.end - left.end)) {
    validateOffsets(bytes, entity);
    const previous = spans[spans.length - 1];
    if (previous && entity.start < previous.end) {
      previous.end = Math.max(previous.end, entity.end);
      previous.types.add(entity.type);
    } else spans.push({ start: entity.start, end: entity.end, types: new Set([entity.type]) });
  }
  let cursor = 0;
  const parts: string[] = [];
  for (const span of spans) {
    parts.push(bytes.subarray(cursor, span.start).toString('utf8'), '[' + [...span.types].sort().join('+') + ']');
    cursor = span.end;
  }
  parts.push(bytes.subarray(cursor).toString('utf8'));
  return parts.join('');
}

function parseAnalysis(value: unknown, inputs: string[]): Analysis {
  if (!value || typeof value !== 'object') throw new LinGuardError('invalid-response');
  const result = value as Partial<Analysis>;
  if (!Array.isArray(result.texts) || result.texts.length !== inputs.length || !Array.isArray(result.model_errors)) {
    throw new LinGuardError('invalid-response');
  }
  const texts = result.texts.map((items, index) => {
    if (!Array.isArray(items)) throw new LinGuardError('invalid-response');
    const bytes = encoded(inputs[index]);
    return items.map((item: unknown): Entity => {
      if (!item || typeof item !== 'object') throw new LinGuardError('invalid-response');
      const entity = item as Entity;
      if (typeof entity.type !== 'string' || !entity.type
        || !Number.isSafeInteger(entity.score) || typeof entity.text !== 'string') throw new LinGuardError('invalid-response');
      validateOffsets(bytes, entity);
      if (bytes.subarray(entity.start, entity.end).toString('utf8') !== entity.text) throw new LinGuardError('invalid-response');
      return { type: entity.type, start: entity.start, end: entity.end, score: entity.score, text: entity.text };
    });
  });
  return { texts, model_errors: result.model_errors };
}

export class LinGuardClient {
  constructor(readonly timeoutMs = 5000, readonly modelErrorPolicy: ModelErrorPolicy = 'fail-closed') {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new RangeError('Timeout LinGuard entre 1 et 10000 ms');
    if (!['fail-open', 'fail-closed'].includes(modelErrorPolicy)) throw new TypeError('Politique LinGuard invalide');
  }

  static async connect(timeoutMs = 5000, modelErrorPolicy: ModelErrorPolicy = 'fail-closed'): Promise<LinGuardClient> {
    const client = new LinGuardClient(timeoutMs, modelErrorPolicy);
    await client.health();
    return client;
  }

  async health(): Promise<{ status: 'ok'; agent: 'linguard'; version: string; api: 'v1' }> {
    const value = await this.request('GET', '/api/v1/health') as Record<string, unknown>;
    if (!value || value.status !== 'ok' || value.agent !== 'linguard' || value.api !== 'v1' || typeof value.version !== 'string') {
      throw new LinGuardError('unavailable');
    }
    return value as { status: 'ok'; agent: 'linguard'; version: string; api: 'v1' };
  }

  async status(): Promise<Record<string, unknown>> {
    const value = await this.request('GET', '/api/v1/status');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LinGuardError('invalid-response');
    if ('error' in value) throw new LinGuardError('unavailable');
    return value as Record<string, unknown>;
  }

  async analyze_text(text: string): Promise<Entity[]> {
    return (await this.analyze([text], true)).texts[0];
  }

  async analyze_texts(texts: string[]): Promise<Entity[][]> {
    return (await this.analyze(texts)).texts;
  }

  async analyze(texts: string[], single = false): Promise<Analysis> {
    if (!Array.isArray(texts) || !texts.length || (single && texts.length !== 1)) throw new LinGuardError('bad-request');
    let minimumBytes = single ? 11 : 12;
    for (const [index, text] of texts.entries()) {
      minimumBytes += encoded(text).length + (single ? 0 : 2 + Number(index > 0));
      if (minimumBytes > MAX_ANALYZE_BYTES) throw new LinGuardError('too-large');
    }
    const body = JSON.stringify(single ? { text: texts[0] } : { texts });
    if (Buffer.byteLength(body, 'utf8') > MAX_ANALYZE_BYTES) throw new LinGuardError('too-large');
    await this.health();
    const result = parseAnalysis(await this.request('POST', '/api/v1/analyze', body), texts);
    if (result.model_errors.length && this.modelErrorPolicy === 'fail-closed') {
      throw new LinGuardError('model-errors', detectionMetadata(result.texts));
    }
    return result;
  }

  private request(method: 'GET' | 'POST', route: string, body?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: 8898, method, path: route, agent: false, maxHeaderSize: 64 * 1024,
        headers: { Connection: 'close', Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('error', () => request.destroy(new LinGuardError('unavailable')));
        response.on('end', () => {
          clearTimeout(timer);
          const code = response.statusCode;
          if (code !== 200) {
            const errors: Record<number, LinGuardErrorCode> = { 400: 'bad-request', 502: 'engine-error', 404: 'not-found' };
            reject(new LinGuardError(errors[code ?? 0] ?? 'unavailable'));
            return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new LinGuardError('invalid-response')); }
        });
      });
      const timer = setTimeout(() => request.destroy(new LinGuardError('timeout')), this.timeoutMs);
      request.on('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof LinGuardError ? error : new LinGuardError('unavailable'));
      });
      request.end(body);
    });
  }
}
