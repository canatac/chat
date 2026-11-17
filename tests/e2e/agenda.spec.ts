import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Meeting } from '../../web/src/types';

type Account = { token: string; user: { id: number } };
const reportText = 'Décision du point de suivi : la revue est validée.';
const password = 'chat-agenda-e2e';

async function signIn(page: Page, base: string, name: string): Promise<Account> {
  const response = await page.request.post(base + '/api/auth/login', { data: { name, password } });
  expect(response.status()).toBe(200);
  const account = await response.json() as Account;
  await page.addInitScript((token) => localStorage.setItem('chat.token', token), account.token);
  await page.goto(base);
  await expect(page.getByText('Connecté', { exact: true })).toBeVisible();
  return account;
}

test('planifie un appel depuis le prompt et ouvre son compte rendu depuis l’agenda sur mobile', async ({ browser }) => {
  const { createServer } = await import('../../server/dist/app.js');
  const { loadConfig } = await import('../../server/dist/config.js');
  const { DB } = await import('../../server/dist/db.js');
  const { hashPassword } = await import('../../server/dist/auth.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-agenda-e2e-'));
  const legacy = new DB(dir);
  for (const name of ['Camille', 'Noémie']) legacy.createUser(name, hashPassword(password));
  legacy.close();
  const ctx = createServer(loadConfig({ JWT_SECRET: 'test-chat-agenda-e2e', ADMIN_NAMES: 'Camille' }), dir);
  const mobile = { viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true, timezoneId: 'Europe/Paris' };
  const host = await browser.newContext(mobile);
  const guest = await browser.newContext(mobile);
  try {
    await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (ctx.server.address() as AddressInfo).port;
    await host.grantPermissions(['microphone'], { origin: base });
    const page = await host.newPage();
    const guestPage = await guest.newPage();
    const organizer = await signIn(page, base, 'Camille');
    const invitee = await signIn(guestPage, base, 'Noémie');
    const headers = { Authorization: 'Bearer ' + organizer.token };
    const { startsAt, localStart } = await page.evaluate(() => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      date.setHours(14, 0, 0, 0);
      return { startsAt: date.getTime(), localStart: new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) };
    });
    const conflict = await page.request.post(base + '/api/agenda', { headers, data: {
      title: 'Atelier de priorisation', agenda: '', startsAt, durationMinutes: 45, timeZone: 'Europe/Paris',
    } });
    expect(conflict.status()).toBe(201);
    const draft = { title: 'Point de suivi', agenda: 'Avancement et décisions', durationMinutes: 45, localStart, participantIds: [invitee.user.id] };
    let meeting: Meeting | undefined;
    await page.route('**/api/agenda/assistant', async (route) => {
      const body = route.request().postDataJSON() as { prompt: string; timeZone: string };
      expect(body.timeZone).toBe('Europe/Paris');
      if (body.prompt.startsWith('Planifie')) await route.fulfill({ json: { kind: 'draft', draft, unresolved: [] } });
      else {
        const response = await page.request.get(base + '/api/agenda/' + meeting!.id, { headers });
        const stored = (await response.json()).meeting;
        await route.fulfill({ json: { kind: 'results', meetings: [stored], total: 1, answer: '1 réunion avec un compte rendu disponible.' } });
      }
    });

    const composer = page.getByRole('textbox', { name: 'Écrire un message' });
    const entry = 'Planifie un point de suivi avec Noémie.';
    await composer.fill('/agenda ' + entry);
    await composer.press('Enter');
    const editor = page.getByRole('dialog', { name: 'Planifier un appel' });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Titre' })).toHaveValue(draft.title);
    await expect(editor.getByText('Noémie', { exact: true })).toBeVisible();
    expect(await editor.evaluate((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
    const before = await page.request.get(base + '/api/agenda', { headers });
    expect((await before.json()).meetings).toHaveLength(1);
    await editor.getByRole('button', { name: 'Suggérer des créneaux' }).tap();
    await expect(editor.getByText('Un participant est déjà invité à une réunion sur ce créneau.')).toBeVisible();
    const slots = editor.getByRole('button', { name: /\d{2}:\d{2}/ });
    await expect(slots).toHaveCount(3);
    await slots.first().tap();
    const created = page.waitForResponse((response) => response.url().endsWith('/api/agenda') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: 'Créer la réunion' }).tap();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    meeting = (await createdResponse.json()).meeting as Meeting;
    expect(meeting.startsAt).toBeGreaterThanOrEqual(startsAt + 45 * 60_000);
    const agenda = page.getByRole('dialog', { name: 'Agenda des appels' });
    await expect(agenda.getByRole('heading', { name: 'Point de suivi' })).toBeVisible();

    const invitation = guestPage.getByRole('button', { name: 'Agenda, 1 en attente' });
    await expect(invitation).toBeInViewport();
    await invitation.tap();
    const guestAgenda = guestPage.getByRole('dialog', { name: 'Agenda des appels' });
    await guestAgenda.getByRole('button', { name: 'Invitations (1)' }).tap();
    await guestAgenda.getByRole('button', { name: /Point de suivi/ }).tap();
    const accept = guestAgenda.getByRole('button', { name: 'Accepter' });
    await accept.tap();
    await expect(accept).toHaveAttribute('aria-pressed', 'true');
    await expect(agenda.getByText('Accepté', { exact: true })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await agenda.getByRole('button', { name: 'Exporter en .ics' }).tap();
    expect((await downloadPromise).suggestedFilename()).toBe(`appel-${meeting.id}.ics`);
    await agenda.getByRole('button', { name: 'Ouvrir l’appel' }).tap();
    const callWindow = page.getByRole('dialog', { name: /Point de suivi/ });
    await expect(callWindow.getByText('Avancement et décisions')).toBeVisible();
    const started = page.waitForResponse((response) => response.url().endsWith('/api/calls/start'));
    await callWindow.getByRole('button', { name: "Démarrer l'appel" }).tap();
    const startResponse = await started;
    expect(startResponse.status()).toBe(201);
    const { call } = await startResponse.json() as { call: { id: number; meetingId: number } };
    expect(call.meetingId).toBe(meeting.id);
    const filename = 'rapport-e2e.md';
    fs.writeFileSync(path.join(dir, 'uploads', filename), reportText);
    ctx.db.insertFile(organizer.user.id, null, filename, 'text/markdown', Buffer.byteLength(reportText), filename, call.id, null, 'report');
    ctx.broadcast({ type: 'docsChanged' });

    async function readReport(from: ReturnType<Page['getByRole']>) {
      await from.getByRole('button', { name: 'Lire le compte rendu' }).tap();
      const reader = page.getByRole('dialog', { name: 'Compte rendu' });
      await expect(reader.getByText(reportText)).toBeVisible();
      expect(await reader.evaluate((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
      await reader.getByRole('button', { name: 'Fermer', exact: true }).tap();
    }
    const activeCall = page.getByRole('dialog', { name: /Appel en cours.*Point de suivi/ });
    await readReport(activeCall);
    await activeCall.getByRole('button', { name: "Terminer l'appel" }).tap();
    await callWindow.getByRole('button', { name: 'Fermer', exact: true }).tap();
    await readReport(agenda);
    await agenda.getByRole('button', { name: 'Fermer l’agenda' }).tap();
    await expect(page.getByRole('log', { name: 'Messages' }).getByText(entry)).toHaveCount(0);
    await composer.fill('/agenda Ai-je un compte rendu pour le point de suivi ?');
    await composer.press('Enter');
    await expect(agenda.getByText('1 réunion avec un compte rendu disponible.')).toBeVisible();
    await agenda.getByRole('button', { name: /Point de suivi/ }).tap();
    await readReport(agenda);
  } finally {
    await host.close();
    await guest.close();
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const layout of [
  { name: 'mobile à 320 px', width: 320, height: 780, touch: true },
  { name: 'ordinateur', width: 1440, height: 900, touch: false },
]) {
  test(`gère les contacts pendant un appel sur ${layout.name}`, async ({ browser }) => {
    const { createServer } = await import('../../server/dist/app.js');
    const { loadConfig } = await import('../../server/dist/config.js');
    const { DB } = await import('../../server/dist/db.js');
    const { hashPassword } = await import('../../server/dist/auth.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-contacts-e2e-'));
    const legacy = new DB(dir);
    for (const name of ['Camille', 'Noémie']) legacy.createUser(name, hashPassword(password));
    legacy.close();
    const server = createServer(loadConfig({ JWT_SECRET: 'test-chat-contacts-e2e', ADMIN_NAMES: 'Camille' }), dir);
    const display = { viewport: { width: layout.width, height: layout.height }, isMobile: layout.touch, hasTouch: layout.touch };
    const host = await browser.newContext(display);
    const guest = await browser.newContext(display);
    const newcomer = await browser.newContext(display);
    const press = (locator: Locator) => layout.touch ? locator.tap() : locator.click();
    try {
      await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + (server.server.address() as AddressInfo).port;
      await Promise.all([host.grantPermissions(['microphone'], { origin: base }), guest.grantPermissions(['microphone'], { origin: base })]);
      const page = await host.newPage();
      const guestPage = await guest.newPage();
      await guestPage.addInitScript(() => {
        const media = navigator.mediaDevices;
        if (!media) return;
        const getUserMedia = media.getUserMedia.bind(media);
        const tracks: MediaStreamTrack[] = [];
        Object.assign(window, { testMicrophoneTracks: tracks });
        media.getUserMedia = async (constraints) => {
          const stream = await getUserMedia(constraints);
          tracks.push(...stream.getAudioTracks());
          return stream;
        };
      });
      await signIn(page, base, 'Camille');
      await signIn(guestPage, base, 'Noémie');

      await press(page.getByRole('button', { name: 'Agenda', exact: true }));
      const agenda = page.getByRole('dialog', { name: 'Agenda des appels' });
      await press(agenda.getByRole('button', { name: 'Planifier' }));
      const editor = page.getByRole('dialog', { name: 'Planifier un appel' });
      await editor.getByRole('textbox', { name: 'Titre' }).fill('Revue ouverte');
      await press(editor.getByRole('button', { name: 'Créer la réunion' }));
      await press(agenda.getByRole('button', { name: 'Ouvrir l’appel' }));
      const call = page.getByRole('dialog', { name: /Revue ouverte/ });
      await press(call.getByRole('button', { name: "Démarrer l'appel" }));
      await expect(call.getByRole('button', { name: "Quitter l'appel" })).toBeVisible();
      await press(call.getByRole('button', { name: 'Gérer les participants' }));
      const people = page.getByRole('dialog', { name: 'Gérer les participants' });
      const search = people.getByRole('combobox', { name: 'Chercher un contact' });
      await search.fill('Noemie');
      await press(page.getByRole('option', { name: 'Noémie' }));
      await press(people.getByRole('button', { name: 'Ajouter à l’appel' }));
      await expect(people.getByText('Invitation ajoutée pour Noémie.')).toBeVisible();

      await expect(guestPage.getByText('Invitation à « Revue ouverte »')).toBeVisible();
      await press(guestPage.getByRole('button', { name: 'Ouvrir l’appel' }));
      const joining = guestPage.getByRole('dialog', { name: /Revue ouverte/ });
      await press(joining.getByRole('button', { name: "Rejoindre l'appel" }));
      await expect(joining.getByRole('button', { name: "Quitter l'appel" })).toBeVisible();

      const address = 'contact.avec.un.identifiant.assez.long@example.test';
      await people.getByLabel('Adresse e-mail du contact').fill(address);
      await press(people.getByRole('button', { name: 'Inviter', exact: true }));
      const link = people.getByLabel('Lien d’invitation');
      await expect(link).toHaveValue(/#invitation=/);
      await expect(people.getByText(address, { exact: true })).toBeVisible();
      expect(await people.evaluate((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);

      const newPage = await newcomer.newPage();
      await newPage.goto(await link.inputValue());
      await expect(newPage.getByText('Invitation pour ' + address)).toBeVisible();
      await newPage.getByLabel('Alias').fill('Léa');
      await newPage.getByLabel('Mot de passe').fill(password);
      await press(newPage.getByRole('button', { name: 'Rejoindre le salon' }));
      await expect(newPage.getByRole('button', { name: 'Agenda, 1 en attente' })).toBeVisible();
      await expect(people.getByText('Léa', { exact: true })).toBeVisible();
      await expect(people.getByText(address, { exact: true })).toHaveCount(0);

      await press(people.getByRole('button', { name: 'Retirer Noémie de l’appel' }));
      const removal = page.getByRole('dialog', { name: 'Retirer Noémie de l’appel ?' });
      await press(removal.getByRole('button', { name: 'Confirmer le retrait' }));
      await expect(joining.getByText('Tu as été retiré de l’appel.')).toBeVisible();
      await expect(joining.getByRole('button', { name: "Rejoindre l'appel" })).toHaveCount(0);
      expect(await guestPage.evaluate(() => {
        const tracks = (window as Window & { testMicrophoneTracks: MediaStreamTrack[] }).testMicrophoneTracks;
        return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
      })).toBe(true);

      await press(people.getByRole('button', { name: 'Fermer', exact: true }));
      await press(call.getByRole('button', { name: 'Fermer', exact: true }));
      await press(agenda.getByRole('button', { name: 'Fermer l’agenda' }));
      await press(page.getByRole('button', { name: 'Membres', exact: true }));
      const contacts = page.getByRole('dialog', { name: 'Membres' });
      await contacts.getByLabel('Rechercher un contact').fill('noemie');
      await expect(contacts.getByText('Noémie', { exact: true })).toBeVisible();
      await expect(contacts.getByText('Léa', { exact: true })).toHaveCount(0);
      expect(await contacts.evaluate((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
      await press(contacts.getByRole('button', { name: 'Gérer les contacts' }));
      const admin = page.getByRole('dialog', { name: 'Administration' });
      await admin.getByLabel('Rechercher par alias ou e-mail').fill('contact.avec');
      await expect(admin.getByRole('button', { name: 'Modifier Léa' })).toBeVisible();
      expect(await admin.evaluate((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
    } finally {
      await Promise.all([host.close(), guest.close(), newcomer.close()]);
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
