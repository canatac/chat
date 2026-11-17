import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { meetingInstant, meetingLocalTime } from '../src/agenda-time.js';
import { createServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const password = 'mot-de-passe-agenda';
const report = '# Compte rendu\n\nDécision : valider le prototype.';
const transcript = 'Camille présente la maquette. Le groupe valide le prototype puis décide de vérifier les parcours sur ordinateur et sur téléphone.';
const zone = 'Europe/Paris';

type Session = { token: string; roomId: number; user: { id: number } };
type Meeting = { id: number; status: string; participants: { id: number; response: string }[]; artifacts: { id: number; kind: string }[] };

test('convertit les heures locales avec les règles du fuseau et vérifie les dates réelles', () => {
  assert.equal(meetingInstant('2032-06-11T14:00', zone), Date.parse('2032-06-11T12:00:00Z'));
  assert.equal(meetingInstant('2032-01-11T14:00', zone), Date.parse('2032-01-11T13:00:00Z'));
  assert.equal(meetingInstant('2026-03-29T02:30', zone), undefined);
  assert.equal(meetingInstant('2026-10-25T02:30', zone), Date.parse('2026-10-25T00:30:00Z'));
  assert.equal(meetingInstant('2032-02-30T14:00', zone), undefined);
});

test('planifie, recueille les réponses, relie un compte rendu et interroge les appels dans le bon salon', async (t) => {
  let intent: unknown = { intent: 'schedule', title: 'Revue, démo', agenda: 'Décisions; suivi\n' + 'É'.repeat(80),
    localStart: '2032-06-11T14:00', durationMinutes: 45, participants: ['noemie', 'Inconnu'] };
  let reportPrompt = '';
  const provider = createHttpServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/v1/audio/transcriptions') {
      res.end(JSON.stringify({ text: transcript, duration: 60 }));
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: string }[] };
    const agenda = payload.messages[0].role === 'system';
    if (!agenda) reportPrompt = payload.messages[0].content;
    res.end(JSON.stringify({ choices: [{ message: { content: agenda ? JSON.stringify(intent) : report } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-agenda-'));
  const config = loadConfig({
    JWT_SECRET: 'test-secret-chat-agenda', DATA_DIR: dir,
    LLM_MODEL: 'test-agenda', LLM_BASE_URL: providerUrl, STT_MODEL: 'test-stt', STT_BASE_URL: providerUrl,
  });
  const app = createServer(config, dir);
  t.after(async () => {
    await app.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  const request = (route: string, account?: Session, method = 'GET', data?: unknown, room?: number) => {
    const form = data instanceof FormData;
    return fetch(base + route, {
      method,
      headers: {
        ...(data !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
        ...(account ? { Authorization: 'Bearer ' + account.token } : {}),
        ...(room ? { 'X-Chat-Room': String(room) } : {}),
      },
      body: form ? data : data === undefined ? undefined : JSON.stringify(data),
    });
  };
  async function json<T>(response: Response, status = 200): Promise<T> {
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<T>;
  }
  const register = (name: string) => request('/auth/register', undefined, 'POST', { name, email: name + '@example.test', roomName: name, password })
    .then((res) => json<Session>(res, 201));
  const organizer = await register('Camille');
  const otherRoom = await register('AutreSalon');
  async function invite(alias: string, email: string) {
    const { token } = await json<{ token: string }>(await request(`/rooms/${organizer.roomId}/invitations`, organizer, 'POST', { email }), 201);
    return json<Session>(await request('/auth/invitations/accept', undefined, 'POST', { token, alias, password }), 201);
  }
  const guest = await invite('Noémie', 'guest@example.test');
  const observer = await invite('Léo', 'observer@example.test');
  const ask = () => request('/agenda/assistant', organizer, 'POST', { prompt: 'Vérifier l’agenda', timeZone: zone });
  const preview = await json<{ kind: string; draft: { title: string; agenda: string; localStart: string; durationMinutes: number; participantIds: number[] }; unresolved: string[] }>(await ask());
  assert.equal(preview.kind, 'draft');
  assert.deepEqual(preview.draft.participantIds, [guest.user.id]);
  assert.deepEqual(preview.unresolved, ['Inconnu']);
  assert.deepEqual(await json(await request('/agenda', organizer)), { meetings: [] });

  const input = { ...preview.draft, timeZone: zone, startsAt: meetingInstant(preview.draft.localStart, zone)! };
  assert.equal((await request('/agenda', organizer, 'POST', { ...input, participantIds: [otherRoom.user.id] })).status, 400);
  const { meeting } = await json<{ meeting: Meeting }>(await request('/agenda', organizer, 'POST', input), 201);
  const route = '/agenda/' + meeting.id;
  assert.equal(meeting.status, 'scheduled');
  assert.equal((await request(route, otherRoom, 'GET', undefined, organizer.roomId)).status, 403);
  assert.equal((await request(route, otherRoom)).status, 404);
  assert.equal((await request(route, guest, 'PATCH', input)).status, 403);
  assert.equal((await request(route + '/response', observer, 'PATCH', { response: 'accepted' })).status, 403);
  assert.deepEqual(await json(await request('/agenda/invitations', guest)), { pending: 1 });
  const response = (value: string) => request(route + '/response', guest, 'PATCH', { response: value });
  const edit = async (patch: Record<string, unknown>) =>
    (await json<{ meeting: Meeting }>(await request(route, organizer, 'PATCH', { ...input, ...patch }))).meeting;
  const reply = (item: Meeting) => item.participants.find(({ id }) => id === guest.user.id)?.response;
  assert.equal(reply((await json<{ meeting: Meeting }>(await response('tentative'))).meeting), 'tentative');
  assert.deepEqual(await json(await request('/agenda/invitations', guest)), { pending: 0 });
  assert.equal(reply(await edit({ agenda: preview.draft.agenda + '\nRelire les décisions' })), 'tentative');
  assert.equal(reply(await edit({ startsAt: input.startsAt + 60_000 })), 'pending');
  assert.deepEqual(await json(await request('/agenda/invitations', guest)), { pending: 1 });

  const icsResponse = await request(route + '/ics', guest);
  assert.equal(icsResponse.status, 200);
  const ics = await icsResponse.text();
  assert.match(icsResponse.headers.get('content-type') ?? '', /^text\/calendar/);
  assert.match(ics, /DTSTART:20320611T120100Z\r\nDTEND:20320611T124600Z/);
  assert.match(ics.replace(/\r\n /g, ''), /SUMMARY:Revue\\, démo\r\nDESCRIPTION:Décisions\\; suivi\\n/);
  assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));

  const start = (account: Session, meetingId: number) => request('/calls/start', account, 'POST', { meetingId });
  assert.equal((await start(observer, meeting.id)).status, 403);
  const { call } = await json<{ call: { id: number; meetingId: number } }>(await start(organizer, meeting.id), 201);
  assert.equal(call.meetingId, meeting.id);
  assert.equal((await request('/calls/join', guest, 'POST', { callId: call.id + 1, meetingId: meeting.id })).status, 409);
  assert.equal((await request('/calls/join', observer, 'POST', { callId: call.id })).status, 403);
  assert.equal((await request('/calls/join', guest, 'POST', { callId: call.id, meetingId: meeting.id })).status, 200);
  assert.equal((await request(route, organizer, 'DELETE')).status, 409);
  assert.equal((await request('/calls/end', organizer, 'POST')).status, 200);

  const audio = new FormData();
  audio.set('file', new Blob(['fixture audio'], { type: 'audio/webm' }), 'appel.webm');
  assert.equal((await request(`/calls/${call.id}/recording`, observer, 'POST', audio)).status, 403);
  assert.equal((await request(`/calls/${call.id}/recording`, organizer, 'POST', audio)).status, 201);
  const getMeeting = async () => (await json<{ meeting: Meeting }>(await request(route, organizer))).meeting;
  let transcriptionId: number | undefined;
  for (let attempt = 0; attempt < 50 && !transcriptionId; attempt++) {
    transcriptionId = (await getMeeting()).artifacts.find(({ kind }) => kind === 'transcript')?.id;
    if (!transcriptionId) await delay(30);
  }
  assert.ok(transcriptionId);
  const { file } = await json<{ file: { id: number } }>(await request(`/files/${transcriptionId}/derive`, organizer, 'POST', { kind: 'cr' }), 201);
  const held = await getMeeting();
  assert.equal(held.status, 'held');
  assert.deepEqual(held.artifacts.map(({ kind }) => kind), ['report', 'transcript', 'recording']);
  assert.equal(held.artifacts[0].id, file.id);
  assert.match(reportPrompt, /Revue, démo/);
  assert.equal(await (await request(`/files/${file.id}/download`, guest)).text(), report);

  const second = (await json<{ meeting: Meeting }>(await request('/agenda', organizer, 'POST', { ...input, title: 'Autre réunion' }), 201)).meeting;
  assert.equal((await start(organizer, second.id)).status, 201);
  assert.equal((await request('/calls/end', organizer, 'POST')).status, 200);
  const actualDay = meetingLocalTime(Date.now(), zone).slice(0, 10);
  intent = { intent: 'search', when: 'held', result: 'count', participant: 'Noémie', from: actualDay, through: actualDay };
  const count = await json<{ total: number; answer: string; meetings: Meeting[] }>(await ask());
  assert.equal(count.total, 1);
  assert.match(count.answer, /1 réunion tenue avec Noémie/);
  assert.deepEqual(count.meetings.map(({ id }) => id), [meeting.id]);
  intent = { intent: 'search', result: 'report', from: '2032-06-11', through: '2032-06-11' };
  const query = await json<{ total: number; answer: string; meetings: Meeting[] }>(await ask());
  assert.equal(query.total, 2);
  assert.match(query.answer, /1 avec un compte rendu disponible/);
  assert.equal(query.meetings[0].id, meeting.id);
  assert.equal(query.meetings[0].artifacts[0].id, file.id);

  intent = { intent: 'search', participant: 'Inconnu' };
  assert.equal((await json<{ kind: string }>(await ask())).kind, 'clarify');
  intent = { intent: 'search', result: 'report', from: '2032-06-12', through: '2032-06-12' };
  assert.equal((await json<{ total: number }>(await ask())).total, 0);
});
