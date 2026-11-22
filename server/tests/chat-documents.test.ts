import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../src/app.js';
import { DB } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const pii = 'personne@example.test';
const password = 'chat-documents-password';

async function until<T>(load: () => T | Promise<T>, accept: (result: T) => boolean = Boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const result = await load();
    if (accept(result)) return result;
    await delay(15);
  }
  throw new Error('État documentaire attendu non reçu');
}

async function fixture(t: TestContext) {
  const sent: { messages: { role: string; content: string }[] }[] = [];
  const analyzed: string[][] = [];
  let ocrText = 'Document OCR : le budget détaillé est de 13579 euros.';
  let partial = false;
  let release: (() => void) | undefined;
  let gate = Promise.resolve();
  let tikaCalls = 0;
  const provider = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Réponse documentaire ' + sent.length } }] }));
  });
  const tika = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* fichier local */ }
    tikaCalls++;
    await gate;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ 'Content-Type': 'application/pdf', 'xmpTPg:NPages': 1, 'tk:content': ocrText,
      ...(partial ? { 'tk:exception:write-limit-reached': true } : {}) }]));
  });
  provider.listen(0, '127.0.0.1'); tika.listen(0, '127.0.0.1');
  await Promise.all([once(provider, 'listening'), once(tika, 'listening')]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-documents-'));
  const seed = new DB(root); seed.createUser('Alice', hashPassword(password)); seed.close();
  const config = loadConfig({ JWT_SECRET: 'chat-document-test-secret', ADMIN_NAMES: 'Alice', LLM_MODEL: 'test',
    LLM_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    TIKA_URL: `http://127.0.0.1:${(tika.address() as { port: number }).port}` });
  const ctx = createServer(config, root, () => ({
    health: async () => ({ status: 'ok', agent: 'linguard', version: 'test', api: 'v1' }),
    analyze: async (texts) => {
      analyzed.push(texts);
      return { texts: texts.map((text) => [...text.matchAll(/personne@example\.test/g)].map((match) => ({ type: 'EMAIL', text: match[0], score: 9900,
        start: Buffer.byteLength(text.slice(0, match.index)), end: Buffer.byteLength(text.slice(0, match.index)) + Buffer.byteLength(match[0]) }))), model_errors: [] };
    },
  }));
  ctx.server.listen(0, '127.0.0.1'); await once(ctx.server, 'listening');
  const base = `http://127.0.0.1:${(ctx.server.address() as { port: number }).port}`;
  const request = (url: string, token: string, method = 'GET', body?: unknown, room?: number) => fetch(base + '/api' + url, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(room ? { 'X-Chat-Room': String(room) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = await request('/auth/login', '', 'POST', { name: 'Alice', password });
  const session = await login.json() as { token: string; roomId: number };
  const token = session.token;
  const api = (url: string, method = 'GET', body?: unknown) => request(url, token, method, body);
  const upload = (name: string, text: string, message = '', post = true) => {
    const body = new FormData(); body.append('file', new Blob([text]), name); body.append('post', String(post));
    if (message) body.append('message', message);
    return fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body });
  };
  const response = async (n: number) => {
    await until(() => ctx.db.listMessages(100).some(({ content }) => content === 'Réponse documentaire ' + n));
  };
  let closed = false;
  const stop = async () => { if (!closed) { closed = true; await ctx.close(); } };
  t.after(async () => {
    release?.();
    await stop();
    for (const server of [provider, tika]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ctx, base, token, session, root, sent, analyzed, api, request, upload, response, stop,
    ocr: (text: string) => { ocrText = text; }, partial: () => { partial = true; },
    hold: () => { gate = new Promise<void>((resolve) => { release = resolve; }); },
    release: () => { release?.(); }, calls: () => tikaCalls };
}

test('chat : /resume multipart attend l’OCR et résume le document complet, avec états en direct', async (t) => {
  const f = await fixture(t);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws?token=' + f.token);
  const events: { type: string; file?: { id: number; analysis: { status: string } } }[] = [];
  ws.on('message', (data) => events.push(JSON.parse(data.toString())));
  await once(ws, 'open'); t.after(() => ws.terminate());
  await f.api('/messages', 'POST', { content: 'HISTORIQUE_SANS_RAPPORT' });
  f.ocr('Début du document. ' + 'Texte détaillé. '.repeat(300) + 'FIN_DOCUMENT_24680');
  f.hold();
  const uploaded = await f.upload('scan.pdf', '%PDF-test', '/resume');
  assert.equal(uploaded.status, 201);
  const { file } = await uploaded.json() as { file: { id: number } };
  await until(f.calls);
  assert.equal(f.sent.length, 0, 'ne pas envoyer à l’IA avant la fin de l’OCR');
  f.release(); await f.response(1);
  const prompt = f.sent[0].messages.find(({ role }) => role === 'user')!.content;
  assert.match(prompt, /scan\.pdf/); assert.match(prompt, /FIN_DOCUMENT_24680/);
  assert.match(prompt, /Résume les documents joints/);
  assert.doesNotMatch(prompt, /HISTORIQUE_SANS_RAPPORT|50 derniers messages/);
  await until(() => events.some((event) => event.type === 'documentAnalysis' && event.file?.id === file.id && event.file.analysis.status === 'ready'));
  assert.ok(events.some((event) => event.file?.id === file.id && event.file.analysis.status === 'processing'));
});

test('chat : /ask multipart utilise le fichier même sans correspondance avec les mots de la question', async (t) => {
  const f = await fixture(t);
  const uploaded = await f.upload('mesure.txt', 'XYZZY_13579 — constante technique exclusive.', '/ask Que vois-tu ?');
  assert.equal(uploaded.status, 201); await f.response(1);
  const prompt = f.sent[0].messages.find(({ role }) => role === 'user')!.content;
  assert.match(prompt, /XYZZY_13579/); assert.match(prompt, /Que vois-tu \?/);
  assert.match(prompt, /mesure\.txt/);
});

test('chat : un arrêt pendant l’OCR annule la demande avant la fermeture de SQLite', async (t) => {
  const f = await fixture(t); f.hold();
  assert.equal((await f.upload('attente.pdf', '%PDF-test', '/resume')).status, 201);
  await until(f.calls);
  await f.stop();
  assert.equal(f.sent.length, 0);
});

test('chat : réutilise un document déjà publié, conserve son origine et cible uniquement la sélection', async (t) => {
  const f = await fixture(t);
  const uploaded = await f.upload('cible.txt', 'CONTENU_CIBLE_ABC');
  const original = await uploaded.json() as { file: { id: number }; message: { id: number } };
  await f.upload('autre.txt', 'CONTENU_AUTRE_NE_PAS_ENVOYER', '', false);
  const res = await f.api('/messages', 'POST', { content: '/resume', fileIds: [original.file.id, original.file.id] });
  assert.equal(res.status, 201);
  const { message } = await res.json() as { message: { id: number; files: { id: number }[] } };
  assert.deepEqual(message.files.map(({ id }) => id), [original.file.id]);
  await f.response(1);
  const prompt = JSON.stringify(f.sent[0]);
  assert.match(prompt, /CONTENU_CIBLE_ABC/); assert.doesNotMatch(prompt, /CONTENU_AUTRE_NE_PAS_ENVOYER/);
  assert.equal(f.ctx.db.getFileById(original.file.id)?.message_id, original.message.id);
  assert.equal(f.ctx.db.listFiles(100).length, 2, 'référence sans dupliquer le fichier');
  assert.deepEqual(f.ctx.db.listFilesByMessage(message.id).map(({ id }) => id), [original.file.id]);
  f.ctx.db.deleteFile(original.file.id);
  assert.deepEqual(f.ctx.db.listFilesByMessage(message.id), []);
});

test('chat : refuse une extraction partielle sans résumé de remplacement ni appel au fournisseur', async (t) => {
  const f = await fixture(t); f.partial();
  const uploaded = await f.upload('partiel.pdf', '%PDF-test', '/resume');
  const { file } = await uploaded.json() as { file: { id: number } };
  await until(() => f.ctx.db.listMessages(50).some(({ content }) => /Analyse incomplète/.test(content)));
  assert.equal(f.sent.length, 0);
  assert.equal(f.ctx.db.getFileById(file.id)?.document_status, 'blocked');
});

test('chat : le budget cumulé des documents sélectionnés bloque sans troncature ni appel IA', async (t) => {
  const f = await fixture(t);
  const ids: number[] = [];
  for (const name of ['premier.txt', 'second.txt']) {
    const uploaded = await f.upload(name, 'contenu '.repeat(14000), '', false);
    assert.equal(uploaded.status, 201);
    ids.push((await uploaded.json() as { file: { id: number } }).file.id);
  }
  await f.api('/messages', 'POST', { content: '/resume', fileIds: ids });
  await until(() => f.ctx.db.listMessages(50).some(({ content }) => /dépassent 200 000 caractères/.test(content)));
  assert.equal(f.sent.length, 0);
});

test('chat : le document ciblé passe par LinGuard, le choix de masquage peut être mémorisé', async (t) => {
  const f = await fixture(t);
  const uploaded = await f.upload('coordonnees.txt', 'Élodie, contact : ' + pii, '/ask');
  const { file } = await uploaded.json() as { file: { id: number } };
  await until(() => f.ctx.db.listMessages(50).some(({ content }) => /politique MaelGard bloque/.test(content)));
  assert.equal(f.sent.length, 0);
  let state = await (await f.api('/security')).json() as { policy: { version: number; modelErrors: string }; reviews: { id: string; sources: { kind: string; count: number }[] }[] };
  assert.equal((await f.api('/security/policy', 'PUT', { ...state.policy, detection: 'ask' })).status, 200);
  await f.api('/messages', 'POST', { content: '/resume', fileIds: [file.id] });
  state = await until(async () => (await (await f.api('/security')).json()) as typeof state, (value) => value.reviews.length > 0);
  assert.deepEqual(state.reviews[0].sources, [{ kind: 'documents', count: 1 }]);
  assert.equal((await f.api('/security/reviews/' + state.reviews[0].id, 'POST', { action: 'anonymize', remember: true })).status, 204);
  await f.response(1);
  await f.api('/messages', 'POST', { content: '/ask Lis ce document', fileIds: [file.id] }); await f.response(2);
  for (const value of f.sent) { assert.doesNotMatch(JSON.stringify(value), /personne@example\.test/); assert.match(JSON.stringify(value), /\[EMAIL\]/); }
  assert.ok(f.analyzed.some((texts) => texts.some((text) => text.includes(pii))));
});

test('chat : garde /resume sans document et rejette les références invalides ou les commandes incompatibles', async (t) => {
  const f = await fixture(t);
  await f.api('/messages', 'POST', { content: 'Décision de la conversation : LIVRAISON_JEUDI' });
  await f.api('/messages', 'POST', { content: '/resume' }); await f.response(1);
  assert.match(JSON.stringify(f.sent[0]), /LIVRAISON_JEUDI/);
  assert.match(JSON.stringify(f.sent[0]), /50 derniers messages/);
  assert.equal((await f.api('/messages', 'POST', { content: '/ask', fileIds: [99999] })).status, 404);
  assert.equal((await f.api('/messages', 'POST', { content: '/ask', fileIds: [1, 2, 3, 4, 5] })).status, 400);
  const invalid = await f.upload('refuse.txt', 'bonjour', '/lien https://example.test/media.mp3');
  assert.equal(invalid.status, 400);
  assert.equal(f.ctx.db.listFiles(100).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'uploads')), []);
});

test('chat : les références sont résolues dans le salon courant et ne donnent pas accès à un autre salon', async (t) => {
  const f = await fixture(t);
  const own = await (await f.upload('propre.txt', 'CONTENU_DU_SALON_ALICE')).json() as { file: { id: number } };
  const response = await f.request('/auth/register', '', 'POST', { name: 'Bob', email: 'bob-room@example.test', password, roomName: 'Privé Bob' });
  assert.equal(response.status, 201);
  const bob = await response.json() as { token: string; roomId: number };
  const body = new FormData(); body.append('file', new Blob(['SECRET_SALON_BOB']), 'secret.txt'); body.append('post', 'false');
  const secret = await fetch(f.base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + bob.token }, body });
  const other = await secret.json() as { file: { id: number } };
  assert.equal(other.file.id, own.file.id, 'identifiants locaux aux salons');
  assert.equal((await f.request('/messages', f.token, 'POST', { content: '/resume', fileIds: [other.file.id] }, bob.roomId)).status, 403);
  assert.equal((await f.api('/messages', 'POST', { content: '/resume', fileIds: [own.file.id] })).status, 201);
  await f.response(1);
  assert.match(JSON.stringify(f.sent[0]), /CONTENU_DU_SALON_ALICE/);
  assert.doesNotMatch(JSON.stringify(f.sent[0]), /SECRET_SALON_BOB/);
});
