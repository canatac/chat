import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createServer, type ServerContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let ctx: ServerContext;
let baseUrl: string;
let dir: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
  const config = loadConfig({
    ...process.env,
    DATA_DIR: dir,
    JWT_SECRET: 'test-secret-123456',
    LLM_MODEL: '',
    ADMIN_NAMES: 'Alice',
  });
  ctx = createServer(config, dir);
  await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  const address = ctx.server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function waitForEvent(
  ws: WebSocket,
  pred: (event: Record<string, never>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, never>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout en attente d\u2019un événement WebSocket'));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as Record<string, never>;
      if (pred(event)) {
        cleanup();
        resolve(event);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.on('message', onMessage);
  });
}

async function loginAs(name: string, password: string): Promise<string> {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name, password }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

test('inscription, doublon, connexion', async () => {
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alice', password: 'motdepasse1' }),
  });
  assert.equal(reg.status, 201);
  const regBody = (await reg.json()) as { token: string; user: { name: string } };
  assert.ok(regBody.token);
  assert.equal(regBody.user.name, 'Alice');

  const dup = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alice', password: 'motdepasse1' }),
  });
  assert.equal(dup.status, 409);

  const badLogin = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alice', password: 'mauvais' }),
  });
  assert.equal(badLogin.status, 401);

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alice', password: 'motdepasse1' }),
  });
  assert.equal(login.status, 200);
  const loginBody = (await login.json()) as { token: string };
  assert.ok(loginBody.token);
});

test('endpoints protégés exigent un token', async () => {
  const res = await api('/api/messages');
  assert.equal(res.status, 401);
  const me = await api('/api/me');
  assert.equal(me.status, 401);
});

test('envoi et lecture de messages via REST', async () => {
  const token = await loginAs('Alice', 'motdepasse1');
  const authHeaders = { Authorization: `Bearer ${token}` };

  const post = await api('/api/messages', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content: 'bonjour la team' }),
  });
  assert.equal(post.status, 201);
  const posted = (await post.json()) as { message: { content: string; user: { name: string }; files: unknown[] } };
  assert.equal(posted.message.content, 'bonjour la team');
  assert.equal(posted.message.user.name, 'Alice');
  assert.deepEqual(posted.message.files, []);

  const list = await api('/api/messages', { headers: authHeaders });
  assert.equal(list.status, 200);
  const body = (await list.json()) as { messages: { content: string }[] };
  assert.ok(body.messages.some((m) => m.content === 'bonjour la team'));
});

test('WebSocket : auth, envoi, broadcast et commande /aide du bot', async () => {
  const token = await loginAs('Alice', 'motdepasse1');

  const ws = new WebSocket(`ws://127.0.0.1:${(ctx.server.address() as { port: number }).port}/ws?token=${token}`);
  const helloPromise = waitForEvent(ws, (e) => e.type === 'hello');
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const hello = (await helloPromise) as unknown as { user: { name: string } };
  assert.equal(hello.user.name, 'Alice');

  ws.send(JSON.stringify({ type: 'message', content: 'message via ws' }));
  const echo = (await waitForEvent(
    ws,
    (e) => e.type === 'message' && (e as { message?: { content?: string } }).message?.content === 'message via ws',
  )) as unknown as { message: { content: string; user: { name: string } } };
  assert.equal(echo.message.user.name, 'Alice');

  ws.send(JSON.stringify({ type: 'message', content: '/aide' }));
  const botReply = (await waitForEvent(
    ws,
    (e) =>
      e.type === 'message' &&
      Boolean((e as { message?: { user?: { isBot?: boolean }; content?: string } }).message?.user?.isBot) &&
      /\/resume/.test((e as { message?: { content?: string } }).message?.content ?? ''),
  )) as unknown as { message: { user: { name: string }; content: string } };
  assert.equal(botReply.message.user.name, 'assistant');
  assert.match(botReply.message.content, /Commandes disponibles/);

  ws.close();
});

test('WebSocket refuse un token invalide', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${(ctx.server.address() as { port: number }).port}/ws?token=bidon`);
  const closed = await new Promise<number>((resolve) => {
    ws.once('close', (code) => resolve(code));
  });
  assert.equal(closed, 4001);
});

test('liste des membres avec état en ligne', async () => {
  await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bob', password: 'motdepasse2' }),
  });
  const token = await loginAs('Alice', 'motdepasse1');
  const res = await api('/api/users', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { users: { name: string; online: boolean }[] };
  const names = body.users.map((u) => u.name).sort();
  assert.deepEqual(names, ['Alice', 'Bob']);
  assert.ok(body.users.every((u) => typeof u.online === 'boolean'));
});

test('présence WebSocket : online annoncé à la connexion', async () => {
  const token = await loginAs('Alice', 'motdepasse1');
  const port = (ctx.server.address() as { port: number }).port;
  const meRes = await api('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const me = (await meRes.json()) as { user: { id: number; isAdmin: boolean } };
  assert.equal(me.user.isAdmin, true);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const presencePromise = waitForEvent(ws, (e) => e.type === 'presence');
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const presence = (await presencePromise) as unknown as { online: number[] };
  assert.ok(presence.online.includes(me.user.id));
  ws.close();
});

test('upload de fichier : message avec pièce jointe, espace documentaire, chunk RAG, téléchargement', async () => {
  const token = await loginAs('Alice', 'motdepasse1');
  const auth = { Authorization: `Bearer ${token}` };
  const content = 'Rapport 2026 : le budget total est de 50000 euros. Le projet Alpha démarre en mars.';
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/plain' }), 'rapport-budget.txt');
  fd.append('message', 'voici le rapport 2026');
  fd.append('post', 'true');
  const up = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers: auth, body: fd });
  assert.equal(up.status, 201);
  const upBody = (await up.json()) as {
    file: { id: number; name: string };
    message: { content: string; files: { id: number; name: string }[] };
  };
  assert.equal(upBody.file.name, 'rapport-budget.txt');
  assert.equal(upBody.message.content, 'voici le rapport 2026');
  assert.equal(upBody.message.files.length, 1);
  assert.equal(upBody.message.files[0].name, 'rapport-budget.txt');

  const list = await api('/api/files?query=rapport', { headers: auth });
  const listBody = (await list.json()) as { files: { id: number; name: string; user: { name: string } }[] };
  assert.equal(listBody.files.length, 1);
  assert.equal(listBody.files[0].user.name, 'Alice');

  for (let i = 0; i < 50 && ctx.db.listChunks().length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ctx.db.listChunks().length > 0);

  const { retrieveRelevantChunks } = await import('../src/llm/rag.js');
  const hits = retrieveRelevantChunks(ctx.db, 'quel est le budget 2026 ?', 3);
  assert.equal(hits[0].fileName, 'rapport-budget.txt');

  const dl = await fetch(`${baseUrl}/api/files/${upBody.file.id}/download`, { headers: auth });
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /50000 euros/);
});

test('dashboard admin : 200 pour un admin, 403 pour un non-admin', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const bob = await loginAs('Bob', 'motdepasse2');
  const ok = await api('/api/admin/stats', { headers: { Authorization: `Bearer ${alice}` } });
  assert.equal(ok.status, 200);
  const stats = (await ok.json()) as { users: { total: number }; llm: { calls: number; totalTokens: number } };
  assert.ok(stats.users.total >= 2);
  assert.equal(stats.llm.calls, 0);
  const ko = await api('/api/admin/stats', { headers: { Authorization: `Bearer ${bob}` } });
  assert.equal(ko.status, 403);
});
