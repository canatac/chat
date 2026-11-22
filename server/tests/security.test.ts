import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../src/app.js';
import { DB } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { LinGuardError } from '../src/security/linguard-client.js';
import type { SecurityPolicy } from '../src/security/security-store.js';
import type { SecurityReview } from '../src/security/ai-guard.js';
import { AIGuard } from '../src/security/ai-guard.js';
import { buildUserMessage } from '../src/llm/commands.js';

const pii = 'jean.dupont@example.test';
const otherPii = 'marie.martin@example.test';
const password = 'test-security-password';

function detect(text: string) {
  return [...text.matchAll(/(?:jean\.dupont|marie\.martin)@example\.test/g)].map((match) => ({
    type: 'EMAIL', start: Buffer.byteLength(text.slice(0, match.index)), end: Buffer.byteLength(text.slice(0, match.index)) + Buffer.byteLength(match[0]),
    score: 9500, text: match[0],
  }));
}

async function fixture(t: TestContext, tikaUrl?: string) {
  let failure = false;
  let modelErrors: unknown[] = [];
  const sent: string[] = [];
  const analyzed: string[][] = [];
  const provider = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    sent.push(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Réponse externe ' + sent.length } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-security-'));
  const legacy = new DB(dir);
  legacy.createUser('Alice', hashPassword(password));
  legacy.createUser('Bob', hashPassword(password));
  legacy.close();
  const config = loadConfig({ JWT_SECRET: 'test-linguard-secret', ADMIN_NAMES: 'Alice', LLM_MODEL: 'test',
    ...(tikaUrl ? { TIKA_URL: tikaUrl } : {}),
    LLM_BASE_URL: 'http://127.0.0.1:' + (provider.address() as AddressInfo).port + '/v1' });
  const app = createServer(config, dir, () => ({
    health: async () => {
      if (failure) throw new LinGuardError('unavailable');
      return { status: 'ok', agent: 'linguard', version: 'test', api: 'v1' };
    },
    analyze: async (texts) => {
      analyzed.push(texts);
      if (failure) throw new LinGuardError('unavailable');
      return { texts: texts.map(detect), model_errors: modelErrors };
    },
  }));
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port;
  t.after(async () => {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function api(route: string, token: string, method = 'GET', body?: unknown) {
    return fetch(base + '/api' + route, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const login = async (name: string) => {
    const res = await api('/auth/login', '', 'POST', { name, password });
    return (await res.json() as { token: string }).token;
  };
  const admin = await login('Alice');
  const member = await login('Bob');
  const state = async (token = admin) => (await (await api('/security', token)).json()) as {
    policy: SecurityPolicy; reviews: SecurityReview[]; health: { available: boolean }; remembered: number;
  };
  const policy = async (detection: SecurityPolicy['detection'], errors: SecurityPolicy['modelErrors'] = 'fail-closed') => {
    const current = (await state()).policy;
    const res = await api('/security/policy', admin, 'PUT', { ...current, detection, modelErrors: errors });
    assert.equal(res.status, 200);
  };
  const send = async (content: string, token = admin) => {
    const res = await api('/messages', token, 'POST', { content });
    assert.equal(res.status, 201);
  };
  const wait = async <T>(load: () => Promise<T | undefined>): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await load();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('État de sécurité attendu non reçu');
  };
  const bot = async (part: string) => wait(async () => {
    const { messages } = await (await api('/messages', admin)).json() as { messages: { user: { isBot: boolean }; content: string }[] };
    return messages.find((message) => message.user.isBot && message.content.includes(part));
  });
  const upload = async (name: string, bytes: Buffer) => {
    const body = new FormData(); body.append('file', new Blob([bytes]), name); body.append('post', 'false');
    const response = await fetch(base + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body });
    assert.equal(response.status, 201);
    return (await response.json() as { file: { id: number } }).file.id;
  };
  return { dir, db: app.db, api, admin, member, state, policy, send, wait, bot, sent, analyzed, upload,
    unavailable: () => { failure = true; }, modelErrors: () => { modelErrors = [{ error: pii }]; } };
}

test('un contact extrait par OCR reste soumis au blocage puis au masquage LinGuard avant le fournisseur', async (t) => {
  const tika = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* données binaires locales */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ 'Content-Type': 'application/pdf', 'xmpTPg:NPages': 1, 'tk:content': 'Projet confidentiel. Contact du projet : ' + pii }]));
  });
  await new Promise<void>((resolve) => tika.listen(0, '127.0.0.1', resolve));
  t.after(async () => { tika.closeAllConnections(); await new Promise<void>((resolve) => tika.close(() => resolve())); });
  const f = await fixture(t, 'http://127.0.0.1:' + (tika.address() as AddressInfo).port);
  const id = await f.upload('scan.pdf', Buffer.from('%PDF-test'));
  await f.wait(async () => f.db.getFileById(id)?.document_status === 'ready' ? true : undefined);
  await f.send('/ask Quel est le contact du projet ?');
  await f.bot('politique MaelGard bloque');
  assert.equal(f.sent.length, 0);
  await f.policy('anonymize');
  await f.send('/ask Donne le contact du projet');
  await f.bot('Réponse externe 1');
  assert.equal(f.sent[0].includes(pii), false);
  assert.match(f.sent[0], /\[EMAIL\]/);
  assert.ok(f.analyzed.some((texts) => texts.some((text) => text.includes(pii))));
});

test('bloque par défaut, masque le contexte complet et persiste uniquement les métadonnées dans l’audit', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.state()).policy, { detection: 'block', modelErrors: 'fail-closed', version: 1 });
  await f.send('Note historique Élodie 🧪 ' + pii);
  await f.send('/ask Résume cette note');
  await f.bot('politique MaelGard bloque');
  assert.equal(f.sent.length, 0);
  await f.policy('anonymize');
  await f.send('/ask Question avec ' + pii);
  await f.bot('Réponse externe 1');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].includes(pii), false);
  assert.equal(f.sent[0].includes('[EMAIL]'), true);
  const sqlite = new DatabaseSync(path.join(f.dir, 'chat.db'));
  const events = sqlite.prepare('SELECT * FROM security_events').all();
  sqlite.close();
  assert.equal(JSON.stringify(events).includes(pii), false);
  assert.ok(events.some((event) => event.action === 'anonymized' && Number(event.count) > 0 && event.max_score === 9500));
});

test('explique les sources et mémorise le masquage sans changer la politique, les originaux ou les choix des autres membres', async (t) => {
  const f = await fixture(t);
  await f.policy('ask');
  const policy = (await f.state()).policy;
  await f.send('Note historique Élodie 🧪 ' + pii);
  const file = f.db.insertFile(f.db.getUserByName('Alice')!.id, null, 'document.txt', 'text/plain', 100, 'document.txt', null);
  f.db.insertChunk(file.id, 0, 'Document de suivi. Contact : ' + pii);
  await f.send('/ask Résume ce document');
  const review = await f.wait(async () => (await f.state()).reviews[0]);
  assert.deepEqual(review.sources, [{ kind: 'documents', count: 1 }, { kind: 'history', count: 1 }]);
  assert.equal(review.count, 2);
  assert.equal(review.rememberedCount, 0);
  assert.equal(JSON.stringify(review).includes(pii), false);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.api('/security/reviews/' + review.id, f.admin, 'POST', { action: 'cancel', remember: true })).status, 400);
  assert.equal((await f.api('/security/reviews/' + review.id, f.member, 'POST', { action: 'anonymize', remember: true })).status, 409);
  assert.equal((await f.api('/security/reviews/' + review.id, f.admin, 'POST', { action: 'anonymize', remember: true })).status, 204);
  await f.bot('Réponse externe 1');
  assert.deepEqual((await f.state()).policy, policy);
  assert.equal((await f.state()).remembered, 1);
  const history = await (await f.api('/messages', f.admin)).json() as { messages: { content: string }[] };
  assert.ok(history.messages.some(({ content }) => content === 'Note historique Élodie 🧪 ' + pii));

  await f.send('/ask Nouvelle question sur le document');
  await f.bot('Réponse externe 2');
  assert.deepEqual((await f.state()).reviews, []);
  assert.ok(f.analyzed.slice(-1)[0].some((text) => text.includes(pii)));
  assert.equal(f.sent.length, 2);
  for (const request of f.sent) {
    assert.equal(request.includes(pii), false);
    assert.equal(request.includes('[EMAIL]'), true);
    const body = JSON.parse(request) as { messages: Record<string, unknown>[] };
    assert.ok(body.messages.every((message) => Object.keys(message).sort().join(',') === 'content,role'));
  }

  await f.send('/ask Résume ce document', f.member);
  const memberReview = await f.wait(async () => (await f.state(f.member)).reviews[0]);
  assert.equal(memberReview.rememberedCount, 0);
  assert.equal((await f.state(f.member)).remembered, 0);
  assert.equal((await f.api('/security/reviews/' + memberReview.id, f.member, 'POST', { action: 'cancel' })).status, 204);
  assert.equal((await f.api('/security/masking', f.member, 'DELETE')).status, 204);
  assert.equal((await f.state()).remembered, 1);

  await f.send('/ask Nouvelle référence du document : ' + otherPii);
  const next = await f.wait(async () => (await f.state()).reviews[0]);
  assert.deepEqual(next.sources, [{ kind: 'question', count: 1 }]);
  assert.equal(next.count, 1);
  assert.ok(next.rememberedCount > 0);
  assert.equal(f.sent.length, 2);
  assert.equal((await f.api('/security/reviews/' + next.id, f.admin, 'POST', { action: 'cancel' })).status, 204);
  const sqlite = new DatabaseSync(path.join(f.dir, 'chat.db'));
  const rules = sqlite.prepare('SELECT * FROM security_mask_rules').all();
  const audit = sqlite.prepare('SELECT * FROM security_events').all();
  sqlite.close();
  assert.equal(rules.length, 1);
  assert.match(String(rules[0].fingerprint), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ rules, audit }).includes(pii), false);
  assert.equal(JSON.stringify({ rules, audit }).includes(otherPii), false);
  assert.equal((await f.api('/security/masking', f.admin, 'DELETE')).status, 204);
  assert.equal((await f.state()).remembered, 0);
  await f.send('/ask Encore une demande');
  const forgotten = await f.wait(async () => (await f.state()).reviews[0]);
  assert.equal(forgotten.rememberedCount, 0);
  assert.equal((await f.api('/security/reviews/' + forgotten.id, f.admin, 'POST', { action: 'cancel' })).status, 204);
  assert.equal(f.sent.length, 2);
});

test('conserve le masquage au redémarrage, réanalyse chaque demande et réinitialise les choix à un changement de politique', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-remember-'));
  let db = new DB(dir);
  let analyses = 0;
  let failure = false;
  const client = () => ({
    health: async () => ({ status: 'ok' as const, agent: 'linguard' as const, version: 'test', api: 'v1' as const }),
    analyze: async (texts: string[]) => {
      analyses++;
      if (failure) throw new LinGuardError('unavailable');
      return { texts: texts.map(detect), model_errors: [] };
    },
  });
  db.security.update({ ...db.security.policy(), detection: 'ask' });
  let guard = new AIGuard(db.security, () => {}, client);
  try {
    const message = buildUserMessage({ name: 'ask', arg: 'Question Élodie 🧪 ' + pii }, 'Note 🧪 ' + pii);
    const first = guard.protect([message], 1);
    void first.catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    const review = guard.list(1)[0];
    assert.deepEqual(review.sources, [{ kind: 'history', count: 1 }, { kind: 'question', count: 1 }]);
    assert.equal(guard.decide(1, review.id, 'anonymize', true), true);
    assert.equal((await first)[0].content.includes(pii), false);
    await guard.close();
    db.close();
    db = new DB(dir);
    guard = new AIGuard(db.security, () => {}, client);
    const second = guard.protect([buildUserMessage({ name: 'ask', arg: 'Une autre question' }, 'Note 🧪 ' + pii)], 1);
    void second.catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(guard.list(1), []);
    assert.equal((await second)[0].content.includes(pii), false);
    assert.equal(analyses, 2);
    failure = true;
    await assert.rejects(guard.protect([message], 1), /indisponible/);
    failure = false;
    db.security.update({ ...db.security.policy(), detection: 'block' });
    assert.equal(db.security.remembered(1).size, 0);
    await assert.rejects(guard.protect([message], 1), /administrateur.*masquage/);
    db.security.update({ ...db.security.policy(), detection: 'ask' });
    const afterPolicy = guard.protect([message], 1);
    const cancelled = assert.rejects(afterPolicy, /annulée/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pending = guard.list(1)[0];
    assert.equal(pending.rememberedCount, 0);
    guard.decide(1, pending.id, 'cancel');
    await cancelled;
  } finally {
    await guard.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('réserve la politique aux administrateurs et ne permet que l’annulation ou le masquage de sa propre demande', async (t) => {
  const f = await fixture(t);
  const original = (await f.state()).policy;
  assert.equal((await f.api('/security/policy', f.member, 'PUT', { ...original, detection: 'ask' })).status, 403);
  await f.policy('ask');
  assert.equal((await f.api('/security/policy', f.admin, 'PUT', { ...original, detection: 'anonymize' })).status, 409);
  await f.send('/ask Mon contact est ' + pii);
  const review = await f.wait(async () => (await f.state()).reviews[0]);
  assert.equal(JSON.stringify(review).includes(pii), false);
  assert.equal(f.sent.length, 0);
  assert.deepEqual((await f.state(f.member)).reviews, []);
  assert.equal((await f.api('/security/reviews/' + review.id, f.member, 'POST', { action: 'anonymize' })).status, 409);
  assert.equal((await f.api('/security/reviews/' + review.id, f.admin, 'POST', { action: 'send-original' })).status, 400);
  assert.equal((await f.api('/security/reviews/' + review.id, f.admin, 'POST', { action: 'anonymize' })).status, 204);
  await f.bot('Réponse externe 1');
  assert.equal(f.sent[0].includes(pii), false);
  assert.equal((await f.api('/security/reviews/' + review.id, f.admin, 'POST', { action: 'anonymize' })).status, 409);
  await f.send('/ask Autre demande ' + pii);
  const cancelled = await f.wait(async () => (await f.state()).reviews[0]);
  assert.equal((await f.api('/security/reviews/' + cancelled.id, f.admin, 'POST', { action: 'cancel' })).status, 204);
  await f.bot('annulée');
  assert.equal(f.sent.length, 1);
  await f.send('/ask En attente ' + pii);
  const stale = await f.wait(async () => (await f.state()).reviews[0]);
  await f.policy('block');
  assert.equal((await f.api('/security/reviews/' + stale.id, f.admin, 'POST', { action: 'anonymize' })).status, 409);
  assert.equal(f.sent.length, 1);
});

test('le fail-open des modèles conserve le blocage des PII et un service indisponible bloque toujours', async (t) => {
  const f = await fixture(t);
  f.modelErrors();
  await f.send('/ask Une question sans PII');
  await f.bot('politique MaelGard');
  assert.equal(f.sent.length, 0);
  await f.policy('block', 'fail-open');
  await f.send('/ask Contact ' + pii);
  await f.bot('données personnelles');
  assert.equal(f.sent.length, 0);
  await f.policy('anonymize', 'fail-open');
  await f.send('/ask Contact ' + pii);
  await f.bot('Réponse externe 1');
  assert.equal(f.sent[0].includes(pii), false);
  f.unavailable();
  await f.send('/ask Encore une question');
  await f.bot('service local MaelGard');
  assert.equal(f.sent.length, 1);
});

test('expire les décisions et annule les demandes en attente à l’arrêt du serveur', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-expiry-'));
  const db = new DB(dir);
  db.security.update({ ...db.security.policy(), detection: 'ask' });
  const guard = new AIGuard(db.security, () => {}, () => ({
    health: async () => ({ status: 'ok', agent: 'linguard', version: 'test', api: 'v1' }),
    analyze: async (texts) => ({ texts: texts.map(detect), model_errors: [] }),
  }));
  try {
    const first = guard.protect([{ role: 'user', content: pii }], 1);
    const expired = assert.rejects(first, /annulée ou a expiré/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(guard.list(1).length, 1);
    t.mock.timers.tick(120_001);
    await expired;
    assert.deepEqual(guard.list(1), []);
    const second = guard.protect([{ role: 'user', content: pii }], 1);
    const cancelled = assert.rejects(second, /annulée ou a expiré/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await guard.close();
    await cancelled;
    assert.deepEqual(guard.list(1), []);
    await assert.rejects(guard.protect([{ role: 'user', content: pii }], 1));
  } finally {
    await guard.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
