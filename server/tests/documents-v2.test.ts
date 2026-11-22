import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DB } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { extractDocument, tikaMetadataText } from '../src/documents/extract.js';
import { FileResources } from '../src/documents/resources.js';
import { DocumentQueue } from '../src/documents/queue.js';
import { createServer } from '../src/app.js';
import { fetchToFile } from '../src/llm/link.js';

test('les valeurs V1 sont plafonnées et les plafonds V2 sont communs', () => {
  const config = loadConfig({ MAX_UPLOAD_MB: '25', RECORDING_MAX_MB: '200', MAX_LINK_FETCH_MB: '500' });
  assert.equal(config.MAX_UPLOAD_MB, 10);
  assert.equal(config.RECORDING_MAX_MB, 50);
  assert.equal(config.MAX_LINK_FETCH_MB, 50);
  assert.equal(config.FILE_STORAGE_MAX_MB, 2048);
});

test('refuse les métadonnées Tika partielles, pages en trop, archives et texte tronqué sous HTTP 200', () => {
  const valid = { 'Content-Type': 'application/pdf', 'xmpTPg:NPages': '1', 'tk:content': 'Contact : alice@example.test' };
  assert.match(tikaMetadataText([valid]), /alice@example\.test/);
  for (const item of [
    { ...valid, 'tk:exception:write-limit-reached': true },
    { ...valid, 'X-TIKA:EXCEPTION:embedded_exception': 'secret error' },
    { ...valid, 'xmpTPg:NPages': 21 },
    { ...valid, 'tk:content': 'x'.repeat(200001) },
    { ...valid, 'Content-Type': 'application/zip' },
    { ...valid, 'pdf:encrypted': 'true' },
  ]) assert.throws(() => tikaMetadataText([item]));
  assert.throws(() => tikaMetadataText([]));
  assert.throws(() => tikaMetadataText([{ 'Content-Type': 'image/png' }]));
});

test('bornes avant extraction : octets, caractères UTF-8 et dimensions des images', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-extract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'document');
  fs.writeFileSync(file, 'é'.repeat(200001));
  await assert.rejects(extractDocument(file, 'text/plain', 'test.txt'), /caractères/);
  fs.writeFileSync(file, Buffer.alloc(10 * 1048576 + 1));
  await assert.rejects(extractDocument(file, 'application/pdf', 'test.pdf'), /10 Mio/);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
  png.writeUInt32BE(100000, 16); png.writeUInt32BE(100000, 20);
  fs.writeFileSync(file, png);
  await assert.rejects(extractDocument(file, 'image/png', 'test.png'), /16 mégapixels/);
});

test('budget de disque et admission de deux écritures partagés entre salons ; libération idempotente', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'room1')); fs.mkdirSync(path.join(root, 'room2'));
  fs.writeFileSync(path.join(root, 'room1', 'a'), Buffer.alloc(80));
  const resources = new FileResources(root, 200, 0);
  const a = resources.writer(50); const b = resources.writer(50);
  assert.throws(() => resources.writer(1), /déjà en cours/);
  assert.throws(() => resources.reserve(21), /Quota global/);
  a(); a(); b();
  resources.writeText(path.join(root, 'room2', 'b'), 'x'.repeat(120));
  assert.throws(() => resources.writeText(path.join(root, 'room2', 'c'), 'x'), /Quota global/);
  fs.rmSync(path.join(root, 'room1', 'a'));
  resources.writeText(path.join(root, 'room2', 'c'), 'x');
});

test('file globale : un seul appel Tika, deux salons, reprise persistée et aucun index partiel', async (t) => {
  let active = 0, maximum = 0;
  const tika = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    active++; maximum = Math.max(maximum, active);
    await delay(40);
    active--;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ 'Content-Type': 'application/pdf', 'xmpTPg:NPages': 1, 'tk:content': 'Contact alice@example.test', ...(req.headers['content-disposition']?.includes('partial') ? { 'tk:exception:write-limit-reached': true } : {}) }]));
  });
  tika.listen(0, '127.0.0.1'); await once(tika, 'listening');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-queue-'));
  const resources = new FileResources(root, 20 * 1048576, 0);
  const queue = new DocumentQueue(`http://127.0.0.1:${(tika.address() as { port: number }).port}`, 1200, resources);
  const dbs: DB[] = [];
  t.after(async () => { await queue.close(); for (const db of dbs) db.close(); tika.closeAllConnections(); await new Promise<void>((resolve) => tika.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 2; i++) {
    const room = path.join(root, String(i)); fs.mkdirSync(room); const db = new DB(room); dbs.push(db);
    const user = db.createUser('Alice', 'hash');
    for (const name of ['ok.pdf', 'partial.pdf']) { fs.writeFileSync(path.join(room, name), '%PDF-test'); db.insertFile(user.id, null, name, 'application/pdf', 9, name); }
    db.setDocumentStatus(1, 'processing');
    queue.register(db, room, () => {});
  }
  for (let n = 0; n < 200 && dbs.some((db) => db.pendingDocuments()); n++) await delay(10);
  assert.equal(maximum, 1);
  for (const db of dbs) {
    assert.equal(db.pendingDocuments(), 0);
    assert.equal(db.getFileById(1)?.document_status, 'ready');
    assert.equal(db.getFileById(2)?.document_status, 'blocked');
    assert.match(db.documentText(1)!, /alice@example\.test/);
    assert.ok(db.listChunks().every((chunk) => chunk.file_id === 1));
  }
});

test('API : taille, champs multipart, erreurs lisibles et absence de fichier résiduel', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-api-'));
  const ctx = createServer(loadConfig({ JWT_SECRET: 'test-documents-v2', MAX_UPLOAD_MB: '1', FILE_STORAGE_MIN_FREE_MB: '0' }), root);
  ctx.server.listen(0, '127.0.0.1'); await once(ctx.server, 'listening');
  t.after(async () => { await ctx.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(ctx.server.address() as { port: number }).port}`;
  const registration = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Alice', email: 'alice@example.test', password: 'motdepasse1' }) });
  const { token, roomId } = await registration.json() as { token: string; roomId: number };
  const headers = { Authorization: `Bearer ${token}` };
  for (const oversized of [true, false]) {
    const body = new FormData();
    body.append('file', new Blob([oversized ? Buffer.alloc(1048577) : 'hello']), 'test.txt');
    if (!oversized) body.append('message', 'x'.repeat(16385));
    const response = await fetch(base + '/api/files', { method: 'POST', headers, body });
    assert.equal(response.status, 413);
    assert.match((await response.json() as { error: string }).error, /limité/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'rooms', String(roomId), 'uploads')), []);
  }
  const body = new FormData(); body.append('file', new Blob(['budget de projet']), 'ok.txt'); body.append('post', 'false');
  assert.equal((await fetch(base + '/api/files', { method: 'POST', headers, body })).status, 201);
});

test('téléchargement chunked : écrit en flux, interrompt au plafond et nettoie le fichier', async (t) => {
  const remote = http.createServer((_req, res) => { res.write(Buffer.alloc(700_000)); res.end(Buffer.alloc(700_000)); });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-stream-'));
  t.after(async () => { remote.closeAllConnections(); await new Promise<void>((resolve) => remote.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  const dest = path.join(root, 'remote');
  await assert.rejects(fetchToFile(new URL(`http://127.0.0.1:${(remote.address() as { port: number }).port}`), dest, 1, undefined, new FileResources(root, 3 * 1048576, 0)), /trop gros/);
  assert.equal(fs.existsSync(dest), false);
});
