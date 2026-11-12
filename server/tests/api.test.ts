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
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alice', password: 'motdepasse1' }),
  });
  const { token } = (await login.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}` };

  const post = await api('/api/messages', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ content: 'bonjour la team' }),
  });
  assert.equal(post.status, 201);
  const posted = (await post.json()) as { message: { content: string; user: { name: string } } };
  assert.equal(posted.message.content, 'bonjour la team');
  assert.equal(posted.message.user.name, 'Alice');

  const list = await api('/api/messages', { headers: authHeaders });
  assert.equal(list.status, 200);
  const body = (await list.json()) as { messages: { content: string }[] };
  assert.ok(body.messages.some((m) => m.content === 'bonjour la team'));
});

test('WebSocket : auth, envoi, broadcast et commande /aide du bot', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alice', password: 'motdepasse1' }),
  });
  const { token } = (await login.json()) as { token: string };

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
