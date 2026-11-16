import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../../server/src/db';

const longFileName = '2026-11-15-EXEMPLE_COMPTE_RENDU_EQUIPE_DOCUMENT_ABCDEFGHIJKLMN_12345678901234567890.txt';
const longLink = 'https://media.example.org/reunions/' + 'archive-de-demonstration-'.repeat(10) + 'enregistrement.m4a';

type Account = { token: string; user: { id: number } };

async function login(page: Page, base: string, name: string): Promise<Account> {
  const response = await page.request.post(base + '/api/auth/login', { data: { name, password: 'chat-local-e2e' } });
  expect(response.status()).toBe(200);
  return response.json() as Promise<Account>;
}

async function withChat(page: Page, historySize: number, run: (base: string, colleague: Account, db: DB) => Promise<void>) {
  const { createServer } = await import('../../server/dist/app.js');
  const { loadConfig } = await import('../../server/dist/config.js');
  const { DB } = await import('../../server/dist/db.js');
  const { hashPassword } = await import('../../server/dist/auth.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-conversation-e2e-'));
  const legacy = new DB(dir);
  for (const name of ['Camille', 'Noémie']) legacy.createUser(name, hashPassword('chat-local-e2e'));
  legacy.close();
  const ctx = createServer(loadConfig({ JWT_SECRET: 'chat-e2e-secret', ADMIN_NAMES: 'Camille' }), dir);

  try {
    await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
    const { port } = ctx.server.address() as AddressInfo;
    const base = 'http://127.0.0.1:' + port;
    const account = await login(page, base, 'Camille');
    const colleague = await login(page, base, 'Noémie');
    for (let index = 1; index <= historySize; index++) {
      ctx.db.insertMessage(colleague.user.id, 'Message historique ' + index);
    }
    await page.addInitScript((token) => localStorage.setItem('chat.token', token), account.token);
    await page.goto(base);
    await expect(page.getByRole('heading', { name: "Chat d'équipe" })).toBeVisible();
    await expect(page.getByRole('status').getByText('Connecté', { exact: true })).toBeVisible();
    await run(base, colleague, ctx.db);
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('garde le brouillon après un échec et attend la confirmation avant de publier un fichier', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withChat(page, 0, async () => {
    const editor = page.getByRole('textbox', { name: 'Écrire un message' });
    const timeline = page.getByRole('log', { name: 'Messages', exact: true });
    const send = page.getByRole('button', { name: 'Envoyer', exact: true });
    let failNext = true;
    await page.route('**/api/messages', async (route) => {
      if (route.request().method() === 'POST' && failNext) {
        failNext = false;
        await route.fulfill({ status: 503, json: { error: 'Service temporairement indisponible' } });
      } else {
        await route.continue();
      }
    });

    await editor.fill('On valide la maquette du chat ?');
    await editor.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Impossible d’envoyer le message.');
    await expect(editor).toHaveValue('On valide la maquette du chat ?');
    await send.click();
    await expect(timeline.getByText('On valide la maquette du chat ?', { exact: true })).toHaveCount(1);
    await expect(editor).toBeEmpty();

    await page.getByRole('button', { name: 'Commandes de l’assistant' }).click();
    await page.getByRole('menuitem', { name: /\/ask/ }).click();
    await expect(editor).toHaveValue('/ask ');
    await expect(editor).toBeFocused();
    await editor.fill('Notes de la réunion');
    await editor.press('Shift+Enter');
    await editor.pressSequentially('À relire demain.');
    await expect(editor).toHaveValue('Notes de la réunion\nÀ relire demain.');

    const initialFile = Buffer.from('Exemple de document partagé.');
    await page.locator('input[aria-label="Fichier à joindre"]').setInputFiles({
      name: longFileName, mimeType: 'text/plain', buffer: initialFile,
    });
    const composer = page.getByRole('form', { name: 'Rédaction du message' });
    await expect(composer.getByText(longFileName, { exact: true })).toBeVisible();
    await expect(timeline.getByRole('button', { name: 'Télécharger ' + longFileName })).toHaveCount(0);
    await send.click();
    const attachment = timeline.getByRole('button', { name: 'Télécharger ' + longFileName, exact: true });
    await expect(attachment).toHaveCount(1);
    await expect(timeline.getByText('Notes de la réunion', { exact: false })).toContainText('À relire demain.');

    const downloadEvent = page.waitForEvent('download');
    await attachment.click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(longFileName);
    expect(fs.readFileSync((await download.path())!)).toEqual(initialFile);
  });
});

test('sur mobile, garde la position de lecture et rend les accès aux appels, documents et membres visibles', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await withChat(page, 58, async (base, colleague) => {
    const history = page.getByRole('region', { name: 'Historique de la conversation' });
    await expect(history.getByText('Message historique 58', { exact: true })).toBeInViewport();
    const callButton = page.getByRole('button', { name: "Appel d'équipe", exact: true });
    const documents = page.getByRole('button', { name: 'Espace documentaire', exact: true });
    const members = page.getByRole('button', { name: 'Membres', exact: true });
    const account = page.getByRole('button', { name: 'Compte de Camille', exact: true });
    for (const button of [callButton, documents, members, account]) {
      await expect(button).toBeInViewport();
      const bounds = await button.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }

    await callButton.click();
    await expect(page.getByRole('button', { name: "Démarrer l'appel" })).toBeVisible();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await documents.click();
    await expect(page.getByRole('dialog', { name: 'Espace documentaire' })).toBeVisible();
    await page.getByRole('button', { name: 'Fermer l’espace documentaire' }).click();
    await members.click();
    await expect(page.getByRole('dialog', { name: 'Membres' }).getByText('Noémie', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await account.click();
    await expect(page.getByRole('menuitem', { name: 'Administration' })).toBeVisible();
    await page.keyboard.press('Escape');

    await history.evaluate((element) => { element.scrollTop = 0; });
    const firstLoadedMessage = history.getByText('Message historique 9', { exact: true });
    const loadHistory = history.getByRole('button', { name: 'Charger les messages précédents' });
    await loadHistory.focus();
    const topBefore = await firstLoadedMessage.evaluate((message) => message.getBoundingClientRect().top);
    await loadHistory.press('Enter');
    await expect(history.getByText('Message historique 1', { exact: true })).toBeAttached();
    const topAfter = await firstLoadedMessage.evaluate((message) => message.getBoundingClientRect().top);
    expect(Math.abs(topAfter - topBefore)).toBeLessThan(3);

    const incoming = await page.request.post(base + '/api/messages', {
      headers: { Authorization: 'Bearer ' + colleague.token },
      data: { content: 'Enregistrement de la revue\n' + longLink },
    });
    expect(incoming.status()).toBe(201);
    const link = history.getByRole('link', { name: 'media.example.org / …', exact: true });
    await expect(link).toHaveAttribute('href', longLink);
    await expect(link).not.toBeInViewport();
    await page.getByRole('button', { name: 'Derniers messages' }).click();
    await expect(link).toBeInViewport();
    const dimensions = await page.evaluate(() => ({ screen: window.innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.screen);
  });
});

test('au toucher, suggère les alias puis retrouve un ancien message depuis une notification persistante', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await withChat(page, 0, async (base, colleague, db) => {
      const bell = page.getByRole('button', { name: /^Notifications/ });
      await expect(bell).toBeInViewport();
      const editor = page.getByRole('textbox', { name: 'Écrire un message' });
      await editor.fill('Bonjour ');
      await page.getByRole('button', { name: 'Mentionner quelqu’un' }).tap();
      const menu = page.getByRole('listbox', { name: 'Suggestions de mentions' });
      await expect(menu.getByRole('option', { name: /@room/ })).toBeInViewport();
      await expect(menu.getByRole('option', { name: '@Noémie' })).toBeInViewport();
      await menu.getByRole('option', { name: '@Noémie' }).tap();
      await expect(editor).toHaveValue('Bonjour @Noémie ');
      await editor.pressSequentially('voici le document.');
      await page.locator('input[aria-label="Fichier à joindre"]').setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Document de test') });
      await page.getByRole('button', { name: 'Envoyer', exact: true }).tap();
      const timeline = page.getByRole('log', { name: 'Messages', exact: true });
      await expect(timeline.locator('[data-mention="person"]')).toHaveText('@Noémie');
      await expect(timeline.getByRole('button', { name: 'Télécharger Notes.txt' })).toBeVisible();
      const headers = { Authorization: 'Bearer ' + colleague.token };
      const received = await page.request.get(base + '/api/notifications', { headers });
      expect((await received.json()).unread).toBe(1);

      const posted = await page.request.post(base + '/api/messages', { headers, data: { content: 'Annonce @room à retrouver dans l’historique.' } });
      expect(posted.status()).toBe(201);
      const { message } = await posted.json() as { message: { id: number } };
      await expect(bell).toHaveAccessibleName('Notifications, 1 non lue');
      for (let index = 1; index <= 64; index++) db.insertMessage(colleague.user.id, 'Plus récent ' + index);
      await page.reload();
      await expect(timeline.getByText('Plus récent 64', { exact: true })).toBeInViewport();
      await expect(timeline.locator(`[data-message-id="${message.id}"]`)).toHaveCount(0);

      await bell.tap();
      const notifications = page.getByRole('dialog', { name: 'Notifications' });
      await expect(notifications.getByRole('button', { name: /Noémie a mentionné le salon/ })).toBeVisible();
      const fit = await notifications.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      expect(fit).toBeTruthy();
      await notifications.getByRole('button', { name: /Noémie a mentionné le salon/ }).tap();
      await expect(notifications).toBeHidden();
      await expect(timeline.locator(`[data-message-id="${message.id}"] [data-mention="room"]`)).toBeInViewport();
      await expect(bell).toHaveAccessibleName('Notifications');
      await page.getByRole('button', { name: 'Derniers messages' }).tap();
      await expect(timeline.getByText('Plus récent 64', { exact: true })).toBeInViewport();

      await page.request.post(base + '/api/messages', { headers, data: { content: 'Autre mention @Camille.' } });
      await expect(bell).toHaveAccessibleName('Notifications, 1 non lue');
      await bell.tap();
      await notifications.getByRole('button', { name: 'Tout marquer comme lu' }).tap();
      await expect(notifications.getByText('0 non lues', { exact: true })).toBeVisible();
    });
  } finally {
    await context.close();
  }
});

test('propose les mentions au clavier et transmet une alerte système après autorisation', async ({ page, context }) => {
  await withChat(page, 0, async (base, colleague) => {
    const editor = page.getByRole('textbox', { name: 'Écrire un message' });
    await editor.fill('Pour @noe');
    await expect(page.getByRole('option', { name: '@Noémie' })).toBeVisible();
    await editor.press('ArrowDown');
    await expect(page.getByRole('option', { name: '@Noémie', selected: true })).toBeVisible();
    await editor.press('Enter');
    await expect(editor).toHaveValue('Pour @Noémie ');
    await editor.press('Enter');
    await expect(page.getByRole('log', { name: 'Messages' }).locator('[data-mention="person"]')).toHaveText('@Noémie');

    await context.grantPermissions(['notifications'], { origin: base });
    const bell = page.getByRole('button', { name: /^Notifications/ });
    await bell.click();
    const notifications = page.getByRole('dialog', { name: 'Notifications' });
    await notifications.getByRole('button', { name: 'Activer les alertes système' }).click();
    await expect(notifications.getByRole('button', { name: 'Désactiver les alertes système' })).toBeVisible();
    await notifications.getByRole('button', { name: 'Fermer les notifications' }).click();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      // Le moteur sans interface ne présente pas de notifications au système d’exploitation.
      const alerts: { title: string; body?: string; notificationId: number }[] = [];
      Object.assign(window, { testSystemAlerts: alerts });
      ServiceWorkerRegistration.prototype.showNotification = async (title, options) => {
        alerts.push({ title, body: options?.body, notificationId: options?.data?.notificationId as number });
      };
    });
    const response = await page.request.post(base + '/api/messages', {
      headers: { Authorization: 'Bearer ' + colleague.token }, data: { content: 'Texte de notification @Camille' },
    });
    expect(response.status()).toBe(201);
    const { message } = await response.json() as { message: { id: number } };
    await expect(bell).toHaveAccessibleName('Notifications, 1 non lue');
    const system = () => page.evaluate(() => (window as typeof window & {
      testSystemAlerts: { title: string; body?: string; notificationId: number }[];
    }).testSystemAlerts);
    await expect.poll(async () => (await system()).map(({ body }) => body)).toEqual(['Noémie vous a mentionné']);
    const [delivered] = await system();
    expect(delivered.title).toBe("Chat d'équipe");
    const url = new URL(page.url());
    url.searchParams.set('notification', String(delivered.notificationId));
    await page.goto(url.toString());
    const target = page.locator(`[data-message-id="${message.id}"] [data-mention="person"]`);
    await expect(target).toHaveText('@Camille');
    await expect(bell).toHaveAccessibleName('Notifications');
    await expect(page).not.toHaveURL(/notification=/);
  });
});
