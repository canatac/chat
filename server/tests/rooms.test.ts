import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { createServer } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { DB } from '../src/db.js';
import { resolveMentions } from '../src/mentions.js';

const password = 'mot-de-passe-de-test';
const jwtSecret = 'test-secret-multi-chatrooms';

type Session = {
  token: string;
  user: { id: number; name: string; role: 'superadmin' | 'admin' | 'member' };
  roomId: number;
  rooms: { id: number; name: string; archivedAt: number | null }[];
};

async function start(t: TestContext, seed?: (dir: string) => void, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rooms-'));
  seed?.(dir);
  const config = loadConfig({
    JWT_SECRET: jwtSecret,
    DATA_DIR: dir,
    ADMIN_NAMES: 'Historique',
    SUPERADMIN_NAMES: 'Racine',
    SUPERADMIN_PASSWORD: password,
    LINK_FETCH_ALLOW_PRIVATE: '1',
    ...env,
  });
  const ctx = createServer(config, dir);
  t.after(async () => {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((done) => ctx.server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + (ctx.server.address() as AddressInfo).port;
  return { base, dir };
}

function api(base: string, pathname: string, options: { token?: string; room?: number; method?: string; body?: unknown } = {}) {
  const { token, room, method, body } = options;
  return fetch(base + '/api' + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(room === undefined ? {} : { 'X-Chat-Room': String(room) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function register(base: string, email: string, roomName: string): Promise<Session> {
  const response = await api(base, '/auth/register', { method: 'POST', body: { name: 'Propriétaire', email, password, roomName } });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<Session>;
}

async function login(base: string, name: string): Promise<Session> {
  const response = await api(base, '/auth/login', { method: 'POST', body: { name, password } });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<Session>;
}

function connect(base: string, token: string, room: number) {
  const params = new URLSearchParams({ token, room: String(room) });
  return new WebSocket(base.replace('http:', 'ws:') + '/ws?' + params);
}

type SocketEvent = {
  type: string;
  message?: { content: string };
  messages?: { content: string }[];
  notification?: { id: number; kind: string; messageId: number };
  receipts?: { messageId: number; received: number; read: number }[];
  typing?: { id: number }[];
  assistantResponding?: boolean;
};

function waitForMessage(ws: WebSocket, match: (event: SocketEvent) => boolean, timeout = 5000): Promise<SocketEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Événement WebSocket non reçu'));
    }, timeout);
    function onMessage(raw: WebSocket.RawData) {
      const event = JSON.parse(raw.toString()) as SocketEvent;
      if (!match(event)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(event);
    }
    ws.on('message', onMessage);
  });
}

test('les mentions suivent l’alias complet, même en cas d’homonymes choisis dans la saisie', () => {
  const members = [{ id: 2, alias: 'Léo' }, { id: 3, alias: 'Léo Martin' }, { id: 4, alias: 'Léo Martin' }];
  assert.deepEqual(resolveMentions('@Léo Martin', members, []), []);
  assert.deepEqual(resolveMentions('@Léo Martin', members, [{ start: 0, end: 11, userId: 4 }]), [{ start: 0, end: 11, userId: 4 }]);
  assert.deepEqual(resolveMentions('@Léo Martin', members, [{ start: 0, end: 11, userId: 99 }]), []);
  const prose = '🗂️ (@Le\u0301o) @Léonic @roommate abc@room `@room` https://example.test/@room et @room.';
  const matches = resolveMentions(prose, members, []);
  assert.deepEqual(matches.map(({ start, end, userId }) => [prose.slice(start, end), userId]), [['@Le\u0301o', 2], ['@room', null]]);
});

test('accuse la réception et la lecture par membre, sans effacer les non-lus sautés dans l’historique', async (t) => {
  const { base } = await start(t, (dir) => {
    const legacy = new DB(dir);
    const camille = legacy.createUser('Camille', hashPassword(password));
    legacy.createUser('Noémie', hashPassword(password));
    legacy.insertMessage(camille.id, 'Message antérieur à la mise à jour');
    legacy.close();
    const sqlite = new DatabaseSync(path.join(dir, 'chat.db'));
    sqlite.exec('DROP TABLE message_receipt_baseline; DROP TABLE message_receipts;');
    sqlite.close();
  });
  const author = await login(base, 'Camille');
  const reader = await login(base, 'Noémie');
  const stranger = await register(base, 'autre-activite@example.test', 'Autre salon');
  const sent = connect(base, author.token, author.roomId);
  const otherTab = connect(base, reader.token, reader.roomId);
  t.after(() => { sent.close(); otherTab.close(); });
  await Promise.all([once(sent, 'open'), once(otherTab, 'open')]);
  const post = async (content: string) => {
    const res = await api(base, '/messages', { token: author.token, method: 'POST', body: { content } });
    assert.equal(res.status, 201);
    const { message } = await res.json() as { message: { id: number } };
    return message.id;
  };
  const status = async (account: Session, ids: number[] = []) => {
    const res = await api(base, '/messages/activity' + (ids.length ? '?ids=' + ids.join(',') : ''), { token: account.token });
    assert.equal(res.status, 200);
    return res.json() as Promise<{ unread: { count: number; firstId: number | null }; receipts: SocketEvent['receipts'] }>;
  };
  const acknowledge = async (account: Session, receipts: { id: number; read: boolean }[]) => {
    const res = await api(base, '/messages/activity', { token: account.token, method: 'PATCH', body: { receipts } });
    assert.equal(res.status, 204);
  };

  const first = await post('Premier message');
  const second = await post('Deuxième message');
  assert.deepEqual((await status(reader)).unread, { count: 2, firstId: first });
  assert.deepEqual((await status(author)).unread, { count: 0, firstId: null });
  assert.deepEqual((await status(stranger)).unread, { count: 0, firstId: null });
  assert.equal((await api(base, '/messages/activity', { token: stranger.token, room: author.roomId })).status, 403);

  const delivered = waitForMessage(sent, (event) => event.type === 'messageReceipts');
  await acknowledge(reader, [{ id: second, read: false }]);
  assert.deepEqual((await delivered).receipts, [{ messageId: second, authorId: author.user.id, received: 1, read: 0 }]);
  assert.equal((await status(reader)).unread.count, 2);
  assert.deepEqual((await status(reader, [second])).receipts, []);

  const readUpdate = waitForMessage(otherTab, (event) => event.type === 'unreadMessagesChanged');
  await acknowledge(reader, [{ id: second, read: true }, { id: second, read: false }]);
  await readUpdate;
  await acknowledge(author, [{ id: second, read: true }]);
  await acknowledge(reader, [{ id: second + 10_000, read: true }]);
  assert.deepEqual((await status(author, [first, second])).receipts, [{ messageId: second, authorId: author.user.id, received: 1, read: 1 }]);
  assert.deepEqual((await status(reader)).unread, { count: 1, firstId: first });
  await acknowledge(reader, [{ id: first, read: true }]);
  assert.deepEqual((await status(reader)).unread, { count: 0, firstId: null });
});

test('la saisie expire par connexion et l’assistant reste actif jusqu’à sa dernière réponse', async (t) => {
  const provider = createHttpServer((req) => req.resume());
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => { provider.closeAllConnections(); return new Promise<void>((resolve) => provider.close(() => resolve())); });
  const { base } = await start(t, undefined, {
    LLM_MODEL: 'test-activite', LLM_BASE_URL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
  });
  const account = await register(base, 'activite@example.test', 'Salon Activité');
  const outside = await register(base, 'ailleurs@example.test', 'Salon Ailleurs');
  const first = connect(base, account.token, account.roomId);
  const second = connect(base, account.token, account.roomId);
  const observer = connect(base, account.token, account.roomId);
  const isolated = connect(base, outside.token, outside.roomId);
  t.after(() => [first, second, observer, isolated].forEach((ws) => ws.close()));
  const externalActivity: SocketEvent[] = [];
  isolated.on('message', (raw) => externalActivity.push(JSON.parse(raw.toString()) as SocketEvent));
  await Promise.all([first, second, observer, isolated].map((ws) => once(ws, 'open')));
  const activity = (match: (event: SocketEvent) => boolean) => waitForMessage(observer, (event) => event.type === 'conversationActivity' && match(event));
  const typing = activity((event) => event.typing?.length === 1);
  first.send(JSON.stringify({ type: 'typing', active: true, content: 'Mon brouillon privé' }));
  const shown = await typing;
  assert.deepEqual(shown.typing?.map(({ id }) => id), [account.user.id]);
  assert.equal(JSON.stringify(shown).includes('Mon brouillon privé'), false);
  const duplicate = activity((event) => event.typing?.length === 1);
  second.send(JSON.stringify({ type: 'typing', active: true }));
  assert.equal((await duplicate).typing?.length, 1);
  const stillTyping = activity((event) => event.typing?.length === 1);
  first.close();
  await stillTyping;
  const idle = activity((event) => event.typing?.length === 0);
  second.send(JSON.stringify({ type: 'typing', active: false }));
  await idle;

  const post = (content: string) => api(base, '/messages', { token: account.token, method: 'POST', body: { content } });
  const busy = activity((event) => event.assistantResponding === true);
  const firstRequest = once(provider, 'request');
  assert.equal((await post('/ask Première question')).status, 201);
  const [, firstResponse] = await firstRequest;
  await busy;
  const secondRequest = once(provider, 'request');
  assert.equal((await post('/resume')).status, 201);
  const [, secondResponse] = await secondRequest;

  const failed = waitForMessage(observer, (event) => event.message?.content.includes("Erreur lors de l'appel au LLM") === true);
  firstResponse.writeHead(503).end('Indisponibilité simulée');
  await failed;
  const newTab = connect(base, account.token, account.roomId);
  t.after(() => newTab.close());
  const activitySnapshot = await waitForMessage(newTab, (event) => event.type === 'conversationActivity');
  assert.equal(activitySnapshot.assistantResponding, true);
  const finished = activity((event) => event.assistantResponding === false);
  secondResponse.setHeader('Content-Type', 'application/json');
  secondResponse.end(JSON.stringify({ choices: [{ message: { content: 'Réponse simulée' } }] }));
  await finished;
  const startedAgain = activity((event) => event.typing?.length === 1);
  second.send(JSON.stringify({ type: 'typing', active: true }));
  await startedAgain;
  await waitForMessage(observer, (event) => event.type === 'conversationActivity' && event.typing?.length === 0, 7500);
  assert.equal(externalActivity.some((event) => event.assistantResponding || event.typing?.length), false);
});

test('notifie les bons membres, y compris hors ligne, et isole la lecture par salon et par destinataire', async (t) => {
  const { base } = await start(t);
  const alpha = await register(base, 'alpha-mentions@example.test', 'Salon Mentions');
  const other = await register(base, 'beta-mentions@example.test', 'Autre salon');
  const addMember = async (alias: string, email: string) => {
    const invited = await api(base, '/rooms/' + alpha.roomId + '/invitations', { method: 'POST', token: alpha.token, body: { email } });
    assert.equal(invited.status, 201);
    const { token } = await invited.json() as { token: string };
    const accepted = await api(base, '/auth/invitations/accept', { method: 'POST', body: { token, alias, password } });
    assert.equal(accepted.status, 201);
    return await accepted.json() as Session;
  };
  const leo = await addMember('Léo Martin', 'leo-mentions@example.test');
  const ariane = await addMember('Ariane', 'ariane-mentions@example.test');
  const watcher = connect(base, leo.token, alpha.roomId);
  const sender = connect(base, alpha.token, alpha.roomId);
  t.after(() => { watcher.close(); sender.close(); });
  const senderEvents: SocketEvent[] = [];
  sender.on('message', (raw) => senderEvents.push(JSON.parse(raw.toString()) as SocketEvent));
  await Promise.all([once(watcher, 'open'), once(sender, 'open')]);
  const directNotice = waitForMessage(watcher, (event) => event.type === 'notificationsChanged' && event.notification?.kind === 'member');
  const send = (content: string) => api(base, '/messages', { method: 'POST', token: alpha.token, body: { content } });
  const sent = await send('Pour @LÉO MARTIN et encore @Léo Martin. Alias @ArianeTech, `@room`, contact@room ; https://exemple.test/@room');
  assert.equal(sent.status, 201);
  const { message } = await sent.json() as { message: { id: number; mentions: { userId: number }[] } };
  assert.deepEqual(message.mentions.map(({ userId }) => userId), [leo.user.id, leo.user.id]);
  const direct = (await directNotice).notification!;
  assert.equal(direct.messageId, message.id);

  const inbox = async (account: Session, query = '') => {
    const response = await api(base, '/notifications' + query, { token: account.token });
    assert.equal(response.status, 200);
    return await response.json() as { notifications: { id: number; kind: 'member' | 'room'; readAt: string | null }[]; unread: number; nextBefore: number | null };
  };
  assert.equal((await inbox(leo)).unread, 1);
  assert.equal((await inbox(ariane)).unread, 0);
  assert.equal((await send('@room et @Léo Martin')).status, 201);
  const barrier = waitForMessage(sender, (event) => event.message?.content === 'Repère de test');
  assert.equal((await send('Repère de test')).status, 201);
  await barrier;
  assert.equal(senderEvents.some((event) => event.notification), false);
  const latest = await inbox(leo, '?limit=1');
  assert.equal(latest.unread, 2);
  assert.equal(latest.notifications[0].kind, 'member');
  assert.equal((await inbox(leo, '?before=' + latest.nextBefore)).notifications[0].id, direct.id);
  const roomNotice = await inbox(ariane);
  assert.deepEqual(roomNotice.notifications.map(({ kind }) => kind), ['room']);
  assert.equal((await inbox(other)).unread, 0);
  assert.equal((await api(base, '/notifications', { token: other.token, room: alpha.roomId })).status, 403);
  assert.equal((await api(base, '/notifications/' + direct.id, { token: alpha.token })).status, 404);

  const read = (account: Session, body: unknown) => api(base, '/notifications/read', { method: 'PATCH', token: account.token, body });
  assert.equal((await read(alpha, { id: direct.id })).status, 404);
  assert.equal((await read(leo, { through: direct.id })).status, 200);
  assert.equal((await inbox(leo)).unread, 1);
  assert.equal((await read(leo, { id: latest.notifications[0].id })).status, 200);
  assert.equal((await inbox(leo)).unread, 0);
  assert.equal((await inbox(ariane)).unread, 1);
});

test('création de salons, invitations, profils, révocation et droits par rôle', async (t) => {
  const { base } = await start(t);
  const alpha = await register(base, 'alpha@example.test', 'Atelier Alpha');
  const beta = await register(base, 'beta@example.test', 'Atelier Bêta');
  const superadmin = await login(base, 'Racine');
  assert.equal(superadmin.user.role, 'superadmin');
  assert.equal(superadmin.rooms.length, 3);
  assert.equal(alpha.user.role, 'admin');
  assert.deepEqual(alpha.rooms.map((room) => room.id), [alpha.roomId]);
  const { token, roomId } = alpha;
  const roomsPath = '/rooms/' + roomId;
  const betaPath = '/rooms/' + beta.roomId;
  assert.equal((await api(base, betaPath + '/members', { token })).status, 403);
  assert.equal((await api(base, betaPath + '/members', { token: superadmin.token })).status, 200);
  assert.equal((await api(base, '/rooms', { method: 'POST', body: { name: 'Salon technique' }, token })).status, 403);
  const created = await api(base, '/rooms', { method: 'POST', body: { name: 'Salon technique' }, token: superadmin.token });
  assert.equal(created.status, 201);
  const { room: extraRoom } = await created.json() as { room: { id: number } };
  assert.equal((await api(base, '/rooms/' + extraRoom.id, {
    method: 'PATCH', token: superadmin.token, body: { name: 'Salon technique renommé' },
  })).status, 200);
  assert.equal((await api(base, roomsPath + '/invitations', {
    method: 'POST', token, body: { email: 'responsable@example.test', role: 'admin' },
  })).status, 403);

  const adminInvite = await api(base, '/rooms/' + extraRoom.id + '/invitations', {
    method: 'POST', token: superadmin.token, body: { email: 'admin@example.test', role: 'admin' },
  });
  assert.equal(adminInvite.status, 201);
  const { token: adminInviteToken } = await adminInvite.json() as { token: string };
  const adminAcceptance = await api(base, '/auth/invitations/accept', {
    method: 'POST', body: { token: adminInviteToken, alias: 'Admin technique', password },
  });
  assert.equal(adminAcceptance.status, 201);
  const invitedAdmin = await adminAcceptance.json() as Session;
  assert.equal(invitedAdmin.user.role, 'admin');
  assert.deepEqual(invitedAdmin.rooms.map((room) => room.id), [extraRoom.id]);

  const invited = await api(base, roomsPath + '/invitations', { method: 'POST', token, body: { email: 'membre@example.test' } });
  assert.equal(invited.status, 201);
  const { token: inviteToken } = await invited.json() as { token: string };
  const preview = await api(base, '/auth/invitations/preview', { method: 'POST', body: { token: inviteToken } });
  const previewBody = await preview.json() as { room: { id: number }; email: string };
  assert.equal(preview.status, 200);
  assert.equal(previewBody.room.id, roomId);
  assert.equal(previewBody.email, 'membre@example.test');

  const accept = () => api(base, '/auth/invitations/accept', {
    method: 'POST', body: { token: inviteToken, alias: 'Membre initial', password },
  });
  const response = await accept();
  assert.equal(response.status, 201);
  const member = await response.json() as Session;
  assert.equal(member.user.role, 'member');
  assert.deepEqual(member.rooms.map((room) => room.id), [roomId]);
  assert.equal((await accept()).status, 410);
  assert.equal((await api(base, roomsPath + '/members', { token: member.token })).status, 403);
  assert.equal((await api(base, '/admin/stats', { token: member.token })).status, 403);
  assert.equal((await api(base, '/admin/stats', { token, room: beta.roomId })).status, 403);
  assert.equal((await api(base, '/admin/stats', { token: superadmin.token, room: beta.roomId })).status, 200);

  const memberPath = roomsPath + '/members/' + member.user.id;
  const updated = await api(base, memberPath, {
    method: 'PATCH', token, body: { alias: 'Membre renommé', email: 'renomme@example.test' },
  });
  assert.equal(updated.status, 200);
  const { user } = await login(base, 'renomme@example.test');
  assert.equal(user.name, 'Membre renommé');
  assert.equal((await api(base, '/auth/login', {
    method: 'POST', body: { name: 'membre@example.test', password },
  })).status, 401);
  const users = await (await api(base, '/users', { token })).json() as { users: Record<string, unknown>[] };
  assert.ok(users.users.some((entry) => entry.name === 'Membre renommé'));
  assert.ok(users.users.every((entry) => !('email' in entry)));
  assert.equal((await api(base, memberPath, {
    method: 'PATCH', token, body: { avatar: 'https://example.test/image' },
  })).status, 400);

  const socket = connect(base, member.token, roomId);
  await waitForMessage(socket, (event) => event.type === 'hello');
  const receivedClose = once(socket, 'close');
  assert.equal((await api(base, memberPath, { method: 'DELETE', token })).status, 204);
  assert.equal((await receivedClose)[0], 4003);
  assert.equal((await api(base, '/messages', { token: member.token })).status, 401);
  const reinvite = await api(base, roomsPath + '/invitations', {
    method: 'POST', token, body: { email: 'renomme@example.test' },
  });
  assert.equal(reinvite.status, 201);
  const invitation = await reinvite.json() as { token: string; invitation: { id: number } };
  assert.equal((await api(base, roomsPath + '/invitations/' + invitation.invitation.id, { method: 'DELETE', token })).status, 204);
  assert.equal((await api(base, '/auth/invitations/preview', {
    method: 'POST', body: { token: invitation.token },
  })).status, 410);
});

test('étanchéité des fichiers, de /lien, des appels et de la conversation, archivage réversible', async (t) => {
  const { base, dir } = await start(t);
  const alpha = await register(base, 'isolation-a@example.test', 'Salon A');
  const beta = await register(base, 'isolation-b@example.test', 'Salon B');
  const root = await login(base, 'Racine');
  const first = connect(base, alpha.token, alpha.roomId);
  const second = connect(base, beta.token, beta.roomId);
  t.after(() => { first.terminate(); second.terminate(); });
  await Promise.all([first, second].map((ws) => waitForMessage(ws, (event) => event.type === 'hello')));
  const invalid = connect(base, alpha.token, beta.roomId);
  assert.equal((await once(invalid, 'close'))[0], 4003);

  const alphaMessage = waitForMessage(first, (event) => event.type === 'message');
  first.send(JSON.stringify({ type: 'message', content: 'message privé alpha' }));
  assert.equal((await alphaMessage).message?.content, 'message privé alpha');
  const betaHistory = waitForMessage(second, (event) => event.type === 'history');
  second.send(JSON.stringify({ type: 'history' }));
  assert.deepEqual((await betaHistory).messages, []);
  assert.equal((await api(base, '/messages', { token: alpha.token, room: beta.roomId })).status, 403);
  const history = await api(base, '/messages', { token: root.token, room: alpha.roomId });
  assert.equal(((await history.json()) as { messages: { content: string }[] }).messages[0].content, 'message privé alpha');

  const source = createHttpServer((_req, res) => res.end('fichier privé alpha'));
  await new Promise<void>((done) => source.listen(0, '127.0.0.1', done));
  t.after(() => { source.closeAllConnections(); source.close(); });
  const port = (source.address() as AddressInfo).port;
  const linked = waitForMessage(first, (event) => event.type === 'message' && event.message?.content.includes('Original :'));
  assert.equal((await api(base, '/messages', {
    method: 'POST', token: alpha.token, body: { content: '/lien http://127.0.0.1:' + port + '/notes.txt' },
  })).status, 201);
  await linked;
  const { files } = await (await api(base, '/files', { token: alpha.token })).json() as { files: { id: number }[] };
  assert.equal(files.length, 1);
  assert.equal(await (await api(base, '/files/' + files[0].id + '/download', { token: alpha.token })).text(), 'fichier privé alpha');
  assert.equal((await api(base, '/files/' + files[0].id + '/download', { token: beta.token })).status, 404);
  assert.equal(fs.readdirSync(path.join(dir, 'rooms', String(alpha.roomId), 'uploads')).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'uploads')) || fs.readdirSync(path.join(dir, 'uploads')).length === 0);

  const startCall = (session: Session) => api(base, '/calls/start', { method: 'POST', token: session.token, body: { title: 'Appel ' + session.roomId } });
  for (const account of [alpha, beta]) assert.equal((await startCall(account)).status, 201);
  const alphaCall = await (await api(base, '/calls/active', { token: alpha.token })).json() as { call: { id: number; recording: unknown } };
  assert.equal((await api(base, '/calls/' + alphaCall.call.id + '/recording/start', { method: 'POST', token: alpha.token })).status, 200);
  const betaCall = await (await api(base, '/calls/active', { token: beta.token })).json() as { call: { recording: unknown } };
  assert.equal(betaCall.call.recording, null);

  const stop = once(first, 'close');
  const archive = (archived: boolean) => api(base, '/rooms/' + alpha.roomId + '/archive', { method: 'PUT', token: root.token, body: { archived } });
  assert.equal((await archive(true)).status, 200);
  assert.equal((await stop)[0], 4003);
  assert.equal((await api(base, '/files', { token: alpha.token })).status, 403);
  assert.equal((await api(base, '/calls/active', { token: beta.token })).status, 200);
  assert.equal((await archive(false)).status, 200);
  assert.equal((await api(base, '/messages', { token: alpha.token })).status, 200);
  assert.equal(await (await api(base, '/files/' + files[0].id + '/download', { token: alpha.token })).text(), 'fichier privé alpha');
  assert.deepEqual(await (await api(base, '/calls/active', { token: alpha.token })).json(), { call: null });
});

test('migration du salon historique, des identifiants et des anciennes sessions', async (t) => {
  let oldId = 0;
  const { base } = await start(t, (dir) => {
    const legacy = new DB(dir);
    oldId = legacy.createUser('Historique', hashPassword(password)).id;
    legacy.insertMessage(oldId, 'message avant mise à jour');
    legacy.close();
  });
  const legacyToken = jwt.sign({ sub: oldId, name: 'Historique' }, jwtSecret, { expiresIn: '1h' });
  const session = await login(base, 'Historique');
  assert.equal(session.user.id, oldId);
  assert.equal(session.user.role, 'admin');
  assert.equal(session.roomId, 1);
  const messages = await api(base, '/messages', { token: legacyToken });
  assert.equal(messages.status, 200);
  const body = await messages.json() as { messages: { content: string; user: { id: number } }[] };
  assert.equal(body.messages[0].content, 'message avant mise à jour');
  assert.equal(body.messages[0].user.id, oldId);
});
