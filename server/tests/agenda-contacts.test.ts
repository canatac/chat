import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';

type Session = { token: string; roomId: number; user: { id: number } };
type Meeting = {
  id: number;
  canEnter: boolean;
  canManageParticipants: boolean;
  participants: { id: number; response: string }[];
  pendingContacts: { id: number; email?: string }[];
};
type MeetingResult = { meeting: Meeting; token?: string };

test('les contacts invités suivent les réunions et le retrait d’un appel préserve le contact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-agenda-contacts-'));
  const config = loadConfig({ JWT_SECRET: 'test-agenda-contacts' });
  const password = 'test-contacts-password';
  let server: ReturnType<typeof createServer>;
  let base: string;
  async function start() {
    server = createServer(config, dir);
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + (server.server.address() as AddressInfo).port + '/api';
  }
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();

  function request(route: string, session?: Session, method = 'GET', body?: unknown) {
    const form = body instanceof FormData;
    return fetch(base + route, {
      method,
      headers: {
        ...(session ? { Authorization: 'Bearer ' + session.token } : {}),
        ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function checked<T>(response: Promise<Response>, status = 200): Promise<T> {
    const result = await response;
    assert.equal(result.status, status, await result.clone().text());
    return result.json() as Promise<T>;
  }
  const register = (name: string) => checked<Session>(request('/auth/register', undefined, 'POST', {
    name, email: name + '@example.test', password, roomName: name,
  }), 201);
  const host = await register('Camille');
  const otherRoom = await register('Autre');
  const roomInvites = `/rooms/${host.roomId}/invitations`;
  const accept = (token: string, alias: string) => checked<Session>(request('/auth/invitations/accept', undefined, 'POST', {
    token, alias, password,
  }), 201);
  const memberLink = await checked<{ token: string }>(request(roomInvites, host, 'POST', { email: 'noemie@example.test' }), 201);
  const member = await accept(memberLink.token, 'Noémie');
  const details = { title: 'Revue', agenda: 'Décisions', startsAt: Date.now() + 86_400_000, durationMinutes: 30, timeZone: 'Europe/Paris' };
  const create = (session = host) => checked<MeetingResult>(request('/agenda', session, 'POST', details), 201);
  const first = (await create()).meeting;
  const second = (await create()).meeting;
  const own = (await create(member)).meeting;
  const route = '/agenda/' + first.id;
  const add = (id: number, body: unknown, session = host) => request('/agenda/' + id + '/participants', session, 'POST', body);
  const remove = (id: number, session = host) => request(route + '/participants/' + id, session, 'DELETE');
  const current = (id: number, session = host) => checked<MeetingResult>(request('/agenda/' + id, session));

  assert.equal((await add(first.id, { userId: otherRoom.user.id })).status, 400);
  assert.equal((await add(first.id, { userId: member.user.id }, member)).status, 403);
  assert.equal((await add(own.id, { email: 'externe@example.test' }, member)).status, 403);
  await checked<MeetingResult>(add(own.id, { userId: host.user.id }, member));
  assert.equal((await remove(host.user.id)).status, 409);
  await checked<MeetingResult>(add(first.id, { userId: member.user.id }));
  await checked<MeetingResult>(request(route + '/response', member, 'PATCH', { response: 'accepted' }));
  const { meeting: repeated } = await checked<MeetingResult>(add(first.id, { userId: member.user.id }));
  assert.equal(repeated.participants.find(({ id }) => id === member.user.id)?.response, 'accepted');
  assert.equal((await request(route, host, 'PATCH', { ...details, participantIds: [], expectedParticipantIds: [] })).status, 409);
  const { meeting: edited } = await checked<MeetingResult>(request(route, host, 'PATCH', { ...details, agenda: 'Suivi' }));
  assert.equal(edited.participants.find(({ id }) => id === member.user.id)?.response, 'accepted');

  const email = 'invite@example.test';
  const invite = await checked<MeetingResult>(add(first.id, { email: email.toUpperCase() }));
  assert.ok(invite.token);
  const [{ id: invitationId }] = invite.meeting.pendingContacts;
  assert.equal(invite.meeting.pendingContacts[0].email, email);
  const guestList = (await current(first.id, member)).meeting.pendingContacts;
  assert.equal(guestList.length, 1);
  assert.ok(!('email' in guestList[0]));
  const attached = await checked<MeetingResult>(add(second.id, { email }));
  assert.equal(attached.token, undefined);
  assert.equal(attached.meeting.pendingContacts[0].id, invitationId);
  const renewed = await checked<{ token: string; invitation: { id: number } }>(request(roomInvites, host, 'POST', { email }), 201);
  assert.equal(renewed.invitation.id, invitationId);
  assert.equal((await request('/auth/invitations/preview', undefined, 'POST', { token: invite.token })).status, 410);

  const unlinked = (await create()).meeting;
  await checked<MeetingResult>(add(unlinked.id, { email }));
  await checked<MeetingResult>(request(`/agenda/${unlinked.id}/contact-invitations/${invitationId}`, host, 'DELETE'));
  const cancelledLink = await checked<MeetingResult>(add(second.id, { email: 'annule@example.test' }));
  const cancelled = cancelledLink.meeting.pendingContacts.find((item) => item.email === 'annule@example.test')!;
  assert.equal((await request(roomInvites + '/' + cancelled.id, host, 'DELETE')).status, 204);
  assert.equal((await request('/auth/invitations/preview', undefined, 'POST', { token: cancelledLink.token })).status, 410);

  await server.close();
  await start();
  const contact = await accept(renewed.token, 'Léa');
  for (const id of [first.id, second.id]) {
    const { meeting } = await current(id, contact);
    assert.equal(meeting.canEnter, true);
    assert.equal(meeting.canManageParticipants, false);
    assert.equal(meeting.participants.find((person) => person.id === contact.user.id)?.response, 'pending');
    assert.deepEqual(meeting.pendingContacts, []);
  }
  assert.equal((await current(unlinked.id, contact)).meeting.canEnter, false);
  const { pending } = await checked<{ pending: number }>(request('/agenda/invitations', contact));
  assert.equal(pending, 2);

  const { call } = await checked<{ call: { id: number } }>(request('/calls/start', host, 'POST', { meetingId: first.id }), 201);
  assert.equal((await request('/calls/end', host, 'POST', { callId: call.id + 1 })).status, 409);
  const join = () => request('/calls/join', contact, 'POST', { meetingId: first.id, callId: call.id });
  await checked(join());
  const recordingPath = '/calls/' + call.id + '/recording';
  const { recordingId } = await checked<{ recordingId: string }>(request(recordingPath + '/start', contact, 'POST'));
  assert.equal((await remove(member.user.id, contact)).status, 403);
  await checked<MeetingResult>(remove(contact.user.id));
  assert.equal((await join()).status, 403);
  assert.equal((await request('/calls/end', contact, 'POST')).status, 403);
  assert.equal((await request(route + '/response', contact, 'PATCH', { response: 'accepted' })).status, 403);
  const { call: active } = await checked<{ call: { recording: unknown; participants: { id: number }[] } }>(request('/calls/active', host));
  assert.equal(active.recording, null);
  assert.deepEqual(active.participants.map(({ id }) => id), [host.user.id]);
  const { users } = await checked<{ users: { id: number }[] }>(request('/users', contact));
  assert.ok(users.some(({ id }) => id === contact.user.id));

  const audio = new FormData();
  audio.set('file', new Blob(['prise en cours'], { type: 'audio/webm' }), 'appel.webm');
  assert.equal((await request(recordingPath, contact, 'POST', audio)).status, 403);
  audio.set('recordingId', recordingId);
  await checked(request(recordingPath, contact, 'POST', audio), 201);
  await checked<MeetingResult>(add(first.id, { userId: contact.user.id }));
  await checked(join());
  await checked(request('/calls/end', host, 'POST', { callId: call.id }));
  assert.equal((await remove(contact.user.id)).status, 409);
});
