import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import http from 'node:http';
import { LinGuardClient, LinGuardError, MAX_ANALYZE_BYTES, displayOffsets, maskText } from '../src/security/linguard-client.js';

let health: unknown;
let healthCode: number;
let analyzeCode: number;
let response: unknown;
let delay: number;
let seen: { method: string; url: string; body: unknown; connection: string | undefined }[];
const fixture = http.createServer(async (request, reply) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  seen.push({ method: request.method!, url: request.url!, body: body ? JSON.parse(body) : undefined, connection: request.headers.connection });
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  reply.setHeader('Content-Type', 'application/json');
  if (analyzeCode === 302) reply.setHeader('Location', 'https://example.test/forbidden');
  if (request.url === '/api/v1/health') reply.writeHead(healthCode).end(JSON.stringify(health));
  else if (request.url === '/api/v1/status') reply.end(JSON.stringify(response));
  else if (request.url === '/api/v1/analyze') reply.writeHead(analyzeCode).end(JSON.stringify(response));
  else reply.writeHead(404).end(JSON.stringify({ error: 'route inconnue' }));
});

before(async () => { await new Promise<void>((resolve) => fixture.listen(8898, '127.0.0.1', resolve)); });
after(async () => { fixture.closeAllConnections(); await new Promise<void>((resolve) => fixture.close(() => resolve())); });
beforeEach(() => {
  health = { status: 'ok', agent: 'linguard', version: 'mock-v1', api: 'v1' };
  healthCode = 200;
  analyzeCode = 200;
  delay = 0;
  response = { texts: [[]], model_errors: [] };
  seen = [];
});

const secret = 'jean.dupont@example.test';
const text = 'Élodie 🧪 écrit à ' + secret;
const start = Buffer.byteLength(text.slice(0, text.indexOf(secret)), 'utf8');
const entity = { type: 'EMAIL', start, end: start + Buffer.byteLength(secret), score: 9500, text: secret };

test('vérifie health au démarrage et utilise HTTP/1.1, JSON et Connection close pour les deux formes', async () => {
  const client = await LinGuardClient.connect();
  response = { protection_active: true, driver: { loaded: true } };
  assert.deepEqual(await client.status(), response);
  response = { texts: [[entity]], model_errors: [] };
  assert.deepEqual(await client.analyze_text(text), [entity]);
  assert.deepEqual(displayOffsets(text, entity), { start: text.indexOf(secret), end: text.length });
  assert.equal(maskText(text, [entity]), 'Élodie 🧪 écrit à [EMAIL]');
  response = { texts: [[entity], []], model_errors: [] };
  assert.deepEqual(await client.analyze_texts([text, 'Sans détection']), [[entity], []]);
  assert.deepEqual(seen.filter((item) => item.method === 'POST').map((item) => item.body),
    [{ text }, { texts: [text, 'Sans détection'] }]);
  assert.ok(seen.every((item) => item.connection === 'close'));
});

test('bloque si health est KO, même en fail-open, et traite le statut indisponible', async () => {
  health = { status: 'ko', agent: 'linguard', version: 'mock', api: 'v1' };
  const client = new LinGuardClient(5000, 'fail-open');
  await assert.rejects(client.analyze_text(text), (error) => error instanceof LinGuardError && error.code === 'unavailable');
  assert.equal(seen.some((item) => item.method === 'POST'), false);
  response = { error: 'etat indisponible' };
  await assert.rejects(client.status(), LinGuardError);
});

test('gère 400, 502, 404 et les redirections sans divulguer le corps d’erreur ni suivre Location', async () => {
  const client = new LinGuardClient();
  for (const [status, code] of [[400, 'bad-request'], [502, 'engine-error'], [404, 'not-found'], [302, 'unavailable']] as const) {
    analyzeCode = status;
    response = { error: secret };
    await assert.rejects(client.analyze_text(text), (error) =>
      error instanceof LinGuardError && error.code === code && !String(error).includes(secret));
  }
  assert.equal(seen.filter((item) => item.method === 'POST').length, 4);
});

test('borne le délai sans retry et bloque les erreurs de modèles par défaut', async () => {
  delay = 60;
  await assert.rejects(new LinGuardClient(10).analyze_text(text),
    (error) => error instanceof LinGuardError && error.code === 'timeout');
  assert.equal(seen.length, 1);
  delay = 0;
  response = { texts: [[entity]], model_errors: [{ error: secret }] };
  await assert.rejects(new LinGuardClient().analyze_text(text), (error) =>
    error instanceof LinGuardError && error.code === 'model-errors'
    && error.metadata?.count === 1 && !JSON.stringify(error).includes(secret));
  assert.deepEqual(await new LinGuardClient(5000, 'fail-open').analyze_text(text), [entity]);
});

test('refuse les limites en octets et le corps JSON surdimensionné avant toute requête', async () => {
  const client = new LinGuardClient();
  await assert.rejects(client.analyze_text('é'.repeat(MAX_ANALYZE_BYTES / 2 + 1)), LinGuardError);
  await assert.rejects(client.analyze_text('x'.repeat(MAX_ANALYZE_BYTES)), LinGuardError);
  await assert.rejects(client.analyze_texts(['x'.repeat(MAX_ANALYZE_BYTES / 2), 'y'.repeat(MAX_ANALYZE_BYTES / 2)]), LinGuardError);
  await assert.rejects(client.analyze_texts([]), LinGuardError);
  assert.equal(seen.length, 0);
});

test('refuse les réponses incohérentes et les offsets à l’intérieur d’un caractère UTF-8', async () => {
  const bad: unknown[] = [
    {}, { texts: [], model_errors: [] }, { texts: [[]] },
    { texts: [[{ ...entity, start: 1 }]], model_errors: [] },
    { texts: [[{ ...entity, end: entity.end + 1 }]], model_errors: [] },
    { texts: [[{ ...entity, text: '' }]], model_errors: [] },
    { texts: [[{ ...entity, score: 0.95 }]], model_errors: [] },
  ];
  for (response of bad) await assert.rejects(new LinGuardClient(5000, 'fail-open').analyze_text(text), LinGuardError);
  const overlapping = [
    { type: 'PERSON', start: 0, end: Buffer.byteLength('Élodie'), score: 9300, text: 'Élodie' },
    { type: 'NAME', start: 0, end: Buffer.byteLength('Élo'), score: 9100, text: 'Élo' },
    entity,
  ];
  assert.equal(maskText(text, overlapping), '[NAME+PERSON] 🧪 écrit à [EMAIL]');
});

test('gère la connexion refusée sans rejouer la requête', async () => {
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  try {
    await assert.rejects(new LinGuardClient().analyze_text(text),
      (error) => error instanceof LinGuardError && error.code === 'unavailable');
  } finally {
    await new Promise<void>((resolve) => fixture.listen(8898, '127.0.0.1', resolve));
  }
});
