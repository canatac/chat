import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/app.js';
import { DB } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { extractDocument, tikaMetadataText } from '../src/documents/extract.js';
import { communicationError, checkDocumentService } from '../src/documents/service.js';
import { restoreDocumentIssue } from '../src/documents/issues.js';
import { DocumentError } from '../src/documents/limits.js';

async function server(t: TestContext, handler: http.RequestListener) {
  const app = http.createServer(handler); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise<void>((resolve) => app.close(() => resolve())); });
  return { app, url: `http://127.0.0.1:${(app.address() as { port: number }).port}` };
}
function pdf(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-diagnostic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.pdf'); fs.writeFileSync(file, '%PDF-test'); return file;
}
async function failure(task: Promise<unknown>): Promise<DocumentError> {
  try { await task; } catch (error) { assert.ok(error instanceof DocumentError); return error; }
  throw new Error('Échec attendu');
}

test('diagnostic : une connexion refusée a un code réseau et ne devient pas un refus de contenu', async (t) => {
  const listener = http.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const url = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const error = await failure(extractDocument(pdf(t), 'application/pdf', 'test.pdf', url));
  assert.equal(error.issue.category, 'service'); assert.equal(error.issue.code, 'service-unreachable');
  assert.equal(error.issue.diagnostic?.networkCode, 'ECONNREFUSED');
  assert.match(error.issue.message, /Connexion refusée/);
  assert.equal((await checkDocumentService(url)).issue?.code, 'service-unreachable');
});

test('diagnostic : JSON invalide et structure incorrecte sont attribués à la réponse du service', async (t) => {
  let value = '<html>PRIVATE_CONTENT_NOT_TO_DISPLAY</html>';
  const remote = await server(t, async (req, res) => { for await (const _chunk of req) {} res.end(value); });
  for (const response of [value, '{}']) {
    value = response;
    const error = await failure(extractDocument(pdf(t), 'application/pdf', 'test.pdf', remote.url));
    assert.equal(error.issue.code, 'invalid-response'); assert.equal(error.issue.category, 'service');
    assert.doesNotMatch(JSON.stringify(error.issue), /PRIVATE_CONTENT_NOT_TO_DISPLAY/);
  }
});

test('diagnostic : distingue HTTP 503, saturation 429 et document illisible 422', async (t) => {
  let status = 503;
  const remote = await server(t, async (req, res) => { for await (const _chunk of req) {} res.writeHead(status).end('PRIVATE_ERROR_NOT_TO_DISPLAY'); });
  for (const [httpStatus, code, category] of [[503, 'service-http', 'service'], [429, 'service-busy', 'service'], [422, 'unreadable', 'document']] as const) {
    status = httpStatus;
    const error = await failure(extractDocument(pdf(t), 'application/pdf', 'test.pdf', remote.url));
    assert.equal(error.issue.code, code); assert.equal(error.issue.category, category);
    assert.equal(error.issue.diagnostic?.httpStatus, httpStatus);
    assert.doesNotMatch(JSON.stringify(error.issue), /PRIVATE_ERROR_NOT_TO_DISPLAY/);
  }
});

test('diagnostic : une redirection ou un point d’accès absent sont des erreurs de configuration', async (t) => {
  let status = 302;
  const remote = await server(t, async (req, res) => { for await (const _chunk of req) {} res.writeHead(status, { Location: 'http://external.example.test' }).end(); });
  for (const code of [302, 403, 404]) {
    status = code;
    const error = await failure(extractDocument(pdf(t), 'application/pdf', 'test.pdf', remote.url));
    assert.equal(error.issue.code, 'service-config'); assert.equal(error.issue.diagnostic?.httpStatus, code);
  }
});

test('diagnostic : chiffrage, limite de pages et extraction tronquée sont expliqués séparément', () => {
  const metadata = { 'Content-Type': 'application/pdf', 'xmpTPg:NPages': 1, 'tk:content': 'Texte de test.' };
  for (const [patch, code, category] of [
    [{ 'pdf:encrypted': true }, 'encrypted', 'document'],
    [{ 'xmpTPg:NPages': 21 }, 'page-limit', 'limit'],
    [{ 'tk:exception:write-limit-reached': true }, 'text-limit', 'limit'],
    [{ 'tk:exception:embedded-resource-limit-reached': true }, 'size-limit', 'limit'],
    [{ 'X-TIKA:EXCEPTION:embedded_exception': 'PRIVATE_ERROR' }, 'partial', 'document'],
  ] as const) {
    assert.throws(() => tikaMetadataText([{ ...metadata, ...patch }]), (error) => {
      assert.ok(error instanceof DocumentError); assert.equal(error.issue.code, code); assert.equal(error.issue.category, category);
      assert.equal(error.issue.retryable, false); assert.doesNotMatch(JSON.stringify(error.issue), /PRIVATE_ERROR/); return true;
    });
  }
});

test('diagnostic : délai dépassé, annulation et configuration locale restent des causes techniques', async () => {
  assert.equal(communicationError(new Error('PRIVATE_ERROR'), true).issue.code, 'timeout');
  assert.equal(communicationError(new Error('PRIVATE_ERROR'), false, true).issue.code, 'cancelled');
  const result = await checkDocumentService('https://external.example.test');
  assert.equal(result.available, false); assert.equal(result.issue?.code, 'service-config');
});

test('vérification : une version joignable ne déclenche aucune extraction et les versions incompatibles sont signalées', async (t) => {
  let version = 'Apache Tika 4.2.0'; let requests = 0;
  const remote = await server(t, (req, res) => { assert.equal(req.url, '/version'); requests++; res.end(version); });
  let health = await checkDocumentService(remote.url);
  assert.equal(health.available, true); assert.equal(health.version, '4.2.0');
  for (const value of ['Apache Tika 3.3.3', 'Apache Tika 4.1.0', '<html>PRIVATE_FAILURE</html>']) {
    version = value; health = await checkDocumentService(remote.url);
    assert.equal(health.available, false); assert.ok(health.issue); assert.doesNotMatch(JSON.stringify(health), /PRIVATE_FAILURE/);
  }
  assert.equal(requests, 4);
});

test('migration : un ancien message ambigu ne devient pas un diagnostic de panne certain', () => {
  const message = 'Service documentaire indisponible ou réponse invalide. Réessayer l’analyse.';
  for (const json of [null, 'broken', '{}']) {
    const issue = restoreDocumentIssue(json, message);
    assert.equal(issue.code, 'unknown'); assert.equal(issue.category, 'unknown'); assert.equal(issue.message, message);
  }
});

test('chat : conserve la cause précise, affiche la bonne étape et partage la vérification sans appeler LinGuard ni le LLM', async (t) => {
  let versionChecks = 0, extracts = 0, providerCalls = 0, securityChecks = 0, valid = false;
  const remote = await server(t, async (req, res) => {
    if (req.url === '/version') { versionChecks++; res.end('Apache Tika 4.2.0'); return; }
    for await (const _chunk of req) {}
    if (req.url?.includes('chat/completions')) { providerCalls++; res.end('{}'); return; }
    extracts++;
    res.end(valid ? JSON.stringify([{ 'Content-Type': 'application/pdf', 'xmpTPg:NPages': 1, 'tk:content': 'Texte enfin extrait.' }]) : 'INVALID_PRIVATE_BODY');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-chat-'));
  const seed = new DB(dir); seed.createUser('Alice', hashPassword('motdepasse1')); seed.close();
  const ctx = createServer(loadConfig({ JWT_SECRET: 'diagnostic-test-secret', ADMIN_NAMES: 'Alice', TIKA_URL: remote.url, LLM_MODEL: 'test', LLM_BASE_URL: remote.url + '/v1' }), dir, () => ({
    health: async () => ({ status: 'ok', agent: 'linguard', version: 'test', api: 'v1' }),
    analyze: async (texts) => { securityChecks++; return { texts: texts.map(() => []), model_errors: [] }; },
  }));
  ctx.server.listen(0, '127.0.0.1'); await once(ctx.server, 'listening');
  t.after(async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(ctx.server.address() as { port: number }).port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Alice', password: 'motdepasse1' }) });
  const { token } = await login.json() as { token: string };
  const headers = { Authorization: 'Bearer ' + token };
  const body = new FormData(); body.append('file', new Blob(['%PDF-test']), 'scan.pdf'); body.append('message', '/resume');
  const upload = await fetch(base + '/api/files', { method: 'POST', headers, body });
  const { file } = await upload.json() as { file: { id: number } };
  for (let i = 0; i < 100 && !ctx.db.listMessages(50).some(({ content }) => content.includes('Extraction du document — Réponse du service invalide')); i++) await delay(20);
  const reply = ctx.db.listMessages(50).find(({ content }) => content.includes('Extraction du document — Réponse du service invalide'));
  assert.ok(reply); assert.match(reply.content, /contrôle LinGuard n’a pas pu être effectué/);
  assert.doesNotMatch(reply.content, /Erreur lors de l'appel au LLM|INVALID_PRIVATE_BODY/);
  const detail = await (await fetch(base + '/api/files/' + file.id, { headers })).json() as { file: { analysis: { issue: { code: string; category: string } } } };
  assert.equal(detail.file.analysis.issue.code, 'invalid-response'); assert.equal(detail.file.analysis.issue.category, 'service');
  const stored = ctx.db.getFileById(file.id)!;
  assert.equal(restoreDocumentIssue(stored.document_issue, stored.document_error).code, 'invalid-response');
  const health = await Promise.all(Array.from({ length: 5 }, async () => (await (await fetch(base + '/api/documents/service', { headers })).json()) as { available: boolean }));
  assert.ok(health.every((value) => value.available)); assert.equal(versionChecks, 1);
  assert.equal(extracts, 1); assert.equal(providerCalls, 0); assert.equal(securityChecks, 0);
  assert.equal((await fetch(base + '/api/documents/service')).status, 401);
  valid = true;
  assert.equal((await fetch(base + '/api/files/' + file.id + '/analyze', { method: 'POST', headers })).status, 202);
  for (let i = 0; i < 100 && ctx.db.getFileById(file.id)?.document_status !== 'ready'; i++) await delay(20);
  assert.equal(ctx.db.getFileById(file.id)?.document_status, 'ready');
  assert.equal(ctx.db.getFileById(file.id)?.document_issue, null);
  assert.equal(providerCalls, 0);
});
