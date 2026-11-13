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
    LINK_FETCH_ALLOW_PRIVATE: '1',
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

async function loginAs(name: string, password: string): Promise<string> {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name, password }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

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
  const stats = (await ok.json()) as { users: { total: number }; llm: { calls: number; totalTokens: number }; calls?: { total: number } };
  assert.ok(stats.users.total >= 2);
  assert.equal(stats.llm.calls, 0);
  const ko = await api('/api/admin/stats', { headers: { Authorization: `Bearer ${bob}` } });
  assert.equal(ko.status, 403);
});

test('cycle de vie d\u2019un appel : start, join, end', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const bob = await loginAs('Bob', 'motdepasse2');
  const authA = { Authorization: `Bearer ${alice}` };
  const authB = { Authorization: `Bearer ${bob}` };

  const active0 = await api('/api/calls/active', { headers: authA });
  assert.equal(((await active0.json()) as { call: unknown }).call, null);

  const start = await api('/api/calls/start', {
    method: 'POST',
    headers: { ...authA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Revue hebdo' }),
  });
  assert.equal(start.status, 201);
  const started = (await start.json()) as { call: { id: number; title: string; participants: { name: string }[] } };
  assert.equal(started.call.title, 'Revue hebdo');
  assert.deepEqual(started.call.participants.map((p) => p.name), ['Alice']);

  const again = await api('/api/calls/start', {
    method: 'POST',
    headers: { ...authB, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(again.status, 409);

  const join = await api('/api/calls/join', { method: 'POST', headers: authB });
  assert.equal(join.status, 200);
  const joined = (await join.json()) as { call: { participants: { name: string }[] } };
  assert.equal(joined.call.participants.length, 2);

  const end = await api('/api/calls/end', { method: 'POST', headers: authA });
  assert.equal(end.status, 200);
  const active1 = await api('/api/calls/active', { headers: authA });
  assert.equal(((await active1.json()) as { call: unknown }).call, null);
});

test('relais de signalisation WebRTC entre deux clients', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const bob = await loginAs('Bob', 'motdepasse2');
  const port = (ctx.server.address() as { port: number }).port;
  const meA = (await (await api('/api/me', { headers: { Authorization: `Bearer ${alice}` } })).json()) as { user: { id: number } };
  const meB = (await (await api('/api/me', { headers: { Authorization: `Bearer ${bob}` } })).json()) as { user: { id: number } };

  const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${bob}`);
  const sigPromise = waitForEvent(wsB, (e) => e.type === 'signal');
  await new Promise<void>((resolve, reject) => {
    wsB.once('open', resolve);
    wsB.once('error', reject);
  });

  const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${alice}`);
  await new Promise<void>((resolve, reject) => {
    wsA.once('open', resolve);
    wsA.once('error', reject);
  });
  wsA.send(JSON.stringify({ type: 'signal', to: meB.user.id, data: { sdp: { type: 'offer', sdp: 'fake' } } }));
  const sig = (await sigPromise) as unknown as { from: number; data: { sdp: { type: string } } };
  assert.equal(sig.from, meA.user.id);
  assert.equal(sig.data.sdp.type, 'offer');
  wsA.close();
  wsB.close();
});

test('upload d\u2019un enregistrement d\u2019appel + dérivation sans LLM (503)', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const auth = { Authorization: `Bearer ${alice}` };
  const start = await api('/api/calls/start', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Point synchro' }),
  });
  const { call } = (await start.json()) as { call: { id: number } };

  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'appel.webm');
  const up = await fetch(`${baseUrl}/api/calls/${call.id}/recording`, { method: 'POST', headers: auth, body: fd });
  assert.equal(up.status, 201);
  const upBody = (await up.json()) as { file: { id: number; callId: number }; transcriptPending: boolean };
  assert.equal(upBody.file.callId, call.id);
  assert.equal(upBody.transcriptPending, false);
  assert.ok(ctx.db.getFileById(upBody.file.id)?.call_id === call.id);

  const txtFd = new FormData();
  txtFd.append('file', new Blob(['Transcription test longue : décision de livrer le projet Alpha vendredi prochain, avec revue de code jeudi matin et démonstration à toute l equipe vendredi après-midi.'], { type: 'text/plain' }), 'transcription-appel.txt');
  txtFd.append('post', 'false');
  const upTxt = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers: auth, body: txtFd });
  const txtBody = (await upTxt.json()) as { file: { id: number } };

  const derive = await api(`/api/files/${txtBody.file.id}/derive`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'resume' }),
  });
  assert.equal(derive.status, 503);

  await api('/api/calls/end', { method: 'POST', headers: auth });
});

test('fichier audio déposé à la main : pas de transcription sans STT, endpoint transcribe 503/400', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const auth = { Authorization: `Bearer ${alice}` };

  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'note-vocale.webm');
  fd.append('post', 'false');
  const up = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers: auth, body: fd });
  assert.equal(up.status, 201);
  const upBody = (await up.json()) as { file: { id: number; name: string; mime: string } };
  assert.equal(upBody.file.mime, 'audio/webm');

  const tr = await api(`/api/files/${upBody.file.id}/transcribe`, { method: 'POST', headers: auth });
  assert.equal(tr.status, 503);

  const txtFd = new FormData();
  txtFd.append('file', new Blob(['texte'], { type: 'text/plain' }), 'doc.txt');
  txtFd.append('post', 'false');
  const upTxt = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers: auth, body: txtFd });
  const txtBody = (await upTxt.json()) as { file: { id: number } };
  const trTxt = await api(`/api/files/${txtBody.file.id}/transcribe`, { method: 'POST', headers: auth });
  assert.equal(trTxt.status, 400);
});

test('derive : 422 si la transcription est trop courte (garde-fou anti-hallucination)', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const auth = { Authorization: `Bearer ${alice}` };
  const fd = new FormData();
  fd.append('file', new Blob(['trop court'], { type: 'text/plain' }), 'transcription-mini.txt');
  fd.append('post', 'false');
  const up = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers: auth, body: fd });
  const upBody = (await up.json()) as { file: { id: number } };
  const res = await api(`/api/files/${upBody.file.id}/derive`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'cr' }),
  });
  assert.equal(res.status, 422);
});

test('enregistrement partagé d\'un appel : start/stop diffusé dans l\'état call', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const auth = { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' };
  const start = await api('/api/calls/start', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Sync' }) });
  const { call } = (await start.json()) as { call: { id: number; recording: unknown } };
  assert.equal(call.recording, null);

  const rs = await api(`/api/calls/${call.id}/recording/start`, { method: 'POST', headers: auth });
  assert.equal(rs.status, 200);
  const rsBody = (await rs.json()) as { call: { recording: { startedBy: { name: string } } } };
  assert.equal(rsBody.call.recording.startedBy.name, 'Alice');

  const rsAgain = await api(`/api/calls/${call.id}/recording/start`, { method: 'POST', headers: auth });
  assert.equal(rsAgain.status, 409);

  const rt = await api(`/api/calls/${call.id}/recording/stop`, { method: 'POST', headers: auth });
  assert.equal(rt.status, 200);
  const rtBody = (await rt.json()) as { call: { recording: unknown } };
  assert.equal(rtBody.call.recording, null);

  await api('/api/calls/end', { method: 'POST', headers: auth });
});

test('commande /lien : télécharge un média depuis une URL, le dépose, poste le récap bot', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const port = (ctx.server.address() as { port: number }).port;

  const http = await import('node:http');
  const payload = Buffer.alloc(2048, 7);
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const srvPort = (srv.address() as { port: number }).port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${alice}`);
  const done = waitForEvent(ws, (e) => {
    const m = (e as { message?: { user?: { isBot?: boolean }; content?: string } }).message;
    return e.type === 'message' && Boolean(m?.user?.isBot) && m?.content?.includes('Original :') === true;
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'message', content: `\/lien http://127.0.0.1:${srvPort}/emission.m4a ITEMA du 13/11` }));
  await done;
  const files = ctx.db.listFiles(10);
  const fetched = files.find((f) => f.name === 'emission.m4a');
  assert.ok(fetched, 'fichier téléchargé présent en base');
  assert.equal(fetched!.size, payload.length);
  assert.equal(fetched!.mime, 'audio/mp4');
  assert.ok(fetched!.message_id !== null);
  ws.close();
  srv.closeAllConnections?.();
  srv.close();
});

test('recordingId : start/stop, upload idempotent, auteur seul, dépôt après fin d appel', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const bob = await loginAs('Bob', 'motdepasse2');
  const authA = { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' };
  const authB = { Authorization: `Bearer ${bob}` };
  const upAuthA = { Authorization: `Bearer ${alice}` };
  const upAuthB = { Authorization: `Bearer ${bob}` };
  const start = await api('/api/calls/start', { method: 'POST', headers: authA, body: JSON.stringify({ title: 'Audit' }) });
  const { call } = (await start.json()) as { call: { id: number } };

  const rs = await api(`/api/calls/${call.id}/recording/start`, { method: 'POST', headers: authA });
  assert.equal(rs.status, 200);
  const rsBody = (await rs.json()) as { recordingId: string; call: { recording: { id: string } } };
  assert.ok(rsBody.recordingId);
  assert.equal(rsBody.call.recording.id, rsBody.recordingId);

  const badStop = await api(`/api/calls/${call.id}/recording/stop`, {
    method: 'POST',
    headers: authA,
    body: JSON.stringify({ recordingId: 'mauvais-id' }),
  });
  assert.equal(badStop.status, 409);

  const mkFd = (rid: string) => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'prise.webm');
    fd.append('recordingId', rid);
    return fd;
  };

  const upByBob = await fetch(`${baseUrl}/api/calls/${call.id}/recording`, { method: 'POST', headers: upAuthB, body: mkFd(rsBody.recordingId) });
  assert.equal(upByBob.status, 403);

  const up1 = await fetch(`${baseUrl}/api/calls/${call.id}/recording`, { method: 'POST', headers: upAuthA, body: mkFd(rsBody.recordingId) });
  assert.equal(up1.status, 201);
  const up1Body = (await up1.json()) as { file: { id: number }; recordingId: string };
  assert.equal(up1Body.recordingId, rsBody.recordingId);

  const up2 = await fetch(`${baseUrl}/api/calls/${call.id}/recording`, { method: 'POST', headers: upAuthA, body: mkFd(rsBody.recordingId) });
  assert.equal(up2.status, 200);
  const up2Body = (await up2.json()) as { duplicate: boolean; file: { id: number } };
  assert.equal(up2Body.duplicate, true);
  assert.equal(up2Body.file.id, up1Body.file.id);

  const stop = await api(`/api/calls/${call.id}/recording/stop`, {
    method: 'POST',
    headers: authA,
    body: JSON.stringify({ recordingId: rsBody.recordingId }),
  });
  assert.equal(stop.status, 200);

  await api('/api/calls/end', { method: 'POST', headers: authA });

  const upAfterEnd = await fetch(`${baseUrl}/api/calls/${call.id}/recording`, { method: 'POST', headers: upAuthA, body: mkFd(rsBody.recordingId) });
  assert.equal(upAfterEnd.status, 200);
  const upAfterEndBody = (await upAfterEnd.json()) as { duplicate: boolean; file: { id: number } };
  assert.equal(upAfterEndBody.duplicate, true);
  assert.equal(upAfterEndBody.file.id, up1Body.file.id);
});

test('signal avec callId : rejeté si un des deux pairs hors appel, relayé sinon', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const bob = await loginAs('Bob', 'motdepasse2');
  const port = (ctx.server.address() as { port: number }).port;
  const start = await api('/api/calls/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const { call } = (await start.json()) as { call: { id: number } };

  const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${bob}`);
  await new Promise<void>((resolve, reject) => {
    wsB.once('open', resolve);
    wsB.once('error', reject);
  });
  const got = waitForEvent(wsB, (e) => e.type === 'signal', 800).then(
    () => true,
    () => false,
  );
  const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${alice}`);
  await new Promise<void>((resolve, reject) => {
    wsA.once('open', resolve);
    wsA.once('error', reject);
  });
  wsA.send(JSON.stringify({ type: 'signal', to: 3, callId: call.id, data: { candidate: { candidate: 'x' } } }));
  assert.equal(await got, false);

  await api('/api/calls/join', { method: 'POST', headers: { Authorization: `Bearer ${bob}` } });
  const got2 = waitForEvent(wsB, (e) => e.type === 'signal' && (e as { callId?: number }).callId === call.id);
  wsA.send(JSON.stringify({ type: 'signal', to: 3, callId: call.id, data: { candidate: { candidate: 'y' } } }));
  await got2;
  wsA.close();
  wsB.close();
  await api('/api/calls/end', { method: 'POST', headers: { Authorization: `Bearer ${alice}` } });
});

test('STT simulé : upload recording → transcription déposée + coût/min tracé dans llm_usage', async () => {
  const http = await import('node:http');
  const sttSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'Bonjour, ceci est une transcription simulée de la réunion de test.', duration: 42 }));
  });
  await new Promise<void>((r) => sttSrv.listen(0, '127.0.0.1', r));
  sttSrv.unref();
  const sttPort = (sttSrv.address() as { port: number }).port;

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-stt-'));
  const cfg2 = loadConfig({
    ...process.env,
    DATA_DIR: dir2,
    JWT_SECRET: 'test-secret-123456',
    LLM_MODEL: '',
    STT_PROVIDER: 'openai-compatible',
    STT_BASE_URL: `http://127.0.0.1:${sttPort}/v1`,
    STT_API_KEY: 'k',
    STT_MODEL: 'whisper-large-v3',
    STT_COST_PER_AUDIO_MIN: '0.0032',
  });
  const ctx2 = createServer(cfg2, dir2);
  await new Promise<void>((r) => ctx2.server.listen(0, '127.0.0.1', r));
  const p2 = (ctx2.server.address() as { port: number }).port;
  const base2 = `http://127.0.0.1:${p2}`;
  const reg = await fetch(`${base2}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Zoe', password: 'secret123' }),
  });
  const { token } = (await reg.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const start = await fetch(`${base2}/api/calls/start`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const { call } = (await start.json()) as { call: { id: number } };
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(2048).fill(9)], { type: 'audio/webm' }), 'prise.webm');
  const up = await fetch(`${base2}/api/calls/${call.id}/recording`, { method: 'POST', headers: auth, body: fd });
  assert.equal(up.status, 201);
  const upBody = (await up.json()) as { transcriptPending: boolean };
  assert.equal(upBody.transcriptPending, true);
  for (let i = 0; i < 50; i++) {
    const tr = ctx2.db.listFiles(50).find((f) => /Transcription/.test(f.name));
    if (tr) {
      const usage = ctx2.db.statsOverview();
      assert.ok(usage.llmCalls >= 1);
      assert.ok(usage.costUsd > 0);
      sttSrv.closeAllConnections?.();
      sttSrv.close();
      await ctx2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  sttSrv.closeAllConnections?.();
  sttSrv.close();
  await ctx2.close();
  fs.rmSync(dir2, { recursive: true, force: true });
  assert.fail('transcription non déposée');
});

test('rtc-config : STUN public par défaut, TURN ajouté si TURN_URLS configuré', async () => {
  const alice = await loginAs('Alice', 'motdepasse1');
  const res = await api('/api/rtc-config', { headers: { Authorization: `Bearer ${alice}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { iceServers: { urls: string | string[] }[] };
  assert.ok(body.iceServers.some((s) => String(s.urls).includes('stun:')));
  assert.equal(body.iceServers.some((s) => String(s.urls).includes('turn:')), false);
  const noAuth = await api('/api/rtc-config');
  assert.equal(noAuth.status, 401);
});
