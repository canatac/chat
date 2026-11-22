import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ServerContext } from '../../server/src/app';
import type { DB } from '../../server/src/db';

const longFileName = '2026-11-15-EXEMPLE_COMPTE_RENDU_EQUIPE_DOCUMENT_ABCDEFGHIJKLMN_12345678901234567890.txt';
const longLink = 'https://media.example.org/reunions/' + 'archive-de-demonstration-'.repeat(10) + 'enregistrement.m4a';

type Account = { token: string; user: { id: number } };

async function login(page: Page, base: string, name: string): Promise<Account> {
  const response = await page.request.post(base + '/api/auth/login', { data: { name, password: 'chat-local-e2e' } });
  expect(response.status()).toBe(200);
  return response.json() as Promise<Account>;
}

async function withChat(page: Page, historySize: number, run: (base: string, colleague: Account, db: DB, ctx: ServerContext) => Promise<void>) {
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
    await run(base, colleague, ctx.db, ctx);
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const width of [320, 1440]) {
  test(`interprète le Markdown de l’assistant en direct et dans l’historique à ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await withChat(page, 0, async (_base, _colleague, db, ctx) => {
      const { serializeMessage } = await import('../../server/dist/app.js');
      const content = [
        '### **Compte rendu de la conversation**',
        '**Durée** : 32 minutes\n**Participants** : Camille et Noémie',
        '---',
        '#### Thèmes abordés',
        '1. **Disponibilité du service**\n   - Vérifier la connexion\n   - Relire le résultat',
        '> Une citation avec du *texte en italique* et du ~~texte barré~~.',
        '| Action | Responsable | Échéance | Statut |\n| --- | --- | --- | --- |\n| Relire | Camille | Demain | À faire |',
        '- [x] Connexion vérifiée\n- [ ] Revue à terminer',
        'Utiliser la commande `npm run build`.',
        '```ts\nconst exemple = "<script>aucuneExecution()</script>";\nconst ligneLongue = "' + 'exemple'.repeat(60) + '";\n```',
        '[Documentation](https://example.org/guide)',
      ].join('\n\n');
      const row = db.insertMessage(db.getBot().id, content);
      ctx.broadcast({ type: 'message', message: serializeMessage(db, row) });
      const bubble = page.locator(`[data-message-id="${row.id}"]`);

      for (const fromHistory of [false, true]) {
        if (fromHistory) await page.reload();
        await expect(bubble.getByRole('heading', { level: 3, name: 'Compte rendu de la conversation' })).toBeVisible();
        await expect(bubble.locator('strong').getByText('Durée', { exact: true })).toBeVisible();
        await expect(bubble.getByRole('heading', { level: 4, name: 'Thèmes abordés' })).toBeVisible();
        await expect(bubble.locator('ol > li > ul > li')).toHaveText(['Vérifier la connexion', 'Relire le résultat']);
        await expect(bubble.locator('blockquote em')).toHaveText('texte en italique');
        await expect(bubble.locator('del')).toHaveText('texte barré');
        await expect(bubble.locator('hr')).toHaveCount(1);
        await expect(bubble.getByRole('columnheader')).toHaveText(['Action', 'Responsable', 'Échéance', 'Statut']);
        await expect(bubble.getByRole('checkbox')).toHaveCount(2);
        await expect(bubble.getByRole('checkbox').first()).toBeChecked();
        await expect(bubble.getByRole('checkbox').last()).toBeDisabled();
        await expect(bubble.locator('p > code')).toHaveText('npm run build');
        await expect(bubble.locator('pre code')).toContainText('<script>aucuneExecution()</script>');
        await expect(bubble.locator('script')).toHaveCount(0);
        const link = bubble.getByRole('link', { name: 'Documentation' });
        await expect(link).toHaveAttribute('href', 'https://example.org/guide');
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        if (width === 320) {
          for (const area of [bubble.getByRole('region', { name: 'Tableau' }), bubble.locator('pre')]) {
            expect(await area.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
            await area.focus();
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => area.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
          }
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(db.getMessageById(row.id)?.content).toBe(content);
      }

      const editor = page.getByRole('textbox', { name: 'Écrire un message' });
      await editor.fill('**Texte littéral** pour @Noémie\n' + longLink);
      await editor.press('Enter');
      const own = page.getByRole('article').filter({ hasText: '**Texte littéral**' });
      await expect(own.locator('[data-mention="person"]')).toHaveText('@Noémie');
      await expect(own.getByRole('link', { name: 'media.example.org / …' })).toHaveAttribute('href', longLink);
      await expect(own.locator('strong').getByText('Texte littéral', { exact: true })).toHaveCount(0);
    });
  });
}

test('neutralise le HTML et les liens dangereux sans charger les images distantes de l’assistant', async ({ page }) => {
  let imageRequests = 0;
  await page.route('https://tracking.example.test/**', async (route) => {
    imageRequests++;
    await route.abort();
  });
  await withChat(page, 0, async (_base, _colleague, db) => {
    const content = [
      '<script>document.documentElement.dataset.markdownInjected = "oui"</script>',
      '<img src="https://tracking.example.test/html.png" onerror="document.documentElement.dataset.markdownInjected=\'oui\'">',
      '<iframe src="https://tracking.example.test/frame"></iframe>',
      '<svg onload="document.documentElement.dataset.markdownInjected=\'oui\'"></svg>',
      '[Lien script](javascript:alert%281%29)',
      '[Lien data](data:text/html,test)',
      '[Lien avec identifiants](https://secret:password@tracking.example.test/)',
      '![Illustration](https://tracking.example.test/image.png)',
      '[Documentation sûre](https://example.org/guide)',
    ].join('\n\n');
    const row = db.insertMessage(db.getBot().id, content);
    await page.reload();
    const bubble = page.locator(`[data-message-id="${row.id}"]`);
    await expect(bubble.getByText('Lien script', { exact: true })).toBeVisible();
    await expect(bubble.getByText('Lien data', { exact: true })).toBeVisible();
    await expect(bubble.getByText('Lien avec identifiants', { exact: true })).toBeVisible();
    await expect(bubble.getByRole('link')).toHaveCount(2);
    await expect(bubble.getByRole('link', { name: 'Illustration' })).toHaveAttribute('href', 'https://tracking.example.test/image.png');
    await expect(bubble.getByRole('link', { name: 'Documentation sûre' })).toHaveAttribute('href', 'https://example.org/guide');
    await expect(bubble.locator('script, img, iframe, svg')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.dataset.markdownInjected)).toBeUndefined();
    expect(imageRequests).toBe(0);
  });
});

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

for (const width of [320, 1440]) {
  test(`commande IA accessible avec un fichier joint et réutilisation depuis le chat à ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await withChat(page, 0, async () => {
      let uploads = 0;
      const references: number[][] = [];
      await page.route('**/api/files', async (route) => {
        if (route.request().method() === 'POST') uploads++;
        await route.continue();
      });
      await page.route('**/api/messages', async (route) => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON() as { fileIds?: number[] };
          if (body.fileIds) references.push(body.fileIds);
        }
        await route.continue();
      });
      const composer = page.getByRole('form', { name: 'Rédaction du message' });
      const editor = page.getByRole('textbox', { name: 'Écrire un message' });
      const name = 'Rapport de projet.txt';
      await page.locator('input[aria-label="Fichier à joindre"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Budget du projet et conclusion.') });
      const commands = page.getByRole('button', { name: 'Commandes de l’assistant' });
      await expect(commands).toBeEnabled();
      await commands.click();
      await expect(page.getByRole('menuitem', { name: /\/ask/ })).toBeEnabled();
      await expect(page.getByRole('menuitem', { name: /\/lien/ })).toBeDisabled();
      await page.getByRole('menuitem', { name: /\/resume/ }).click();
      await expect(editor).toHaveValue('/resume ');
      await expect(composer).toContainText('Résumer le document joint');
      await composer.getByRole('button', { name: 'Envoyer', exact: true }).click();
      const timeline = page.getByRole('log', { name: 'Messages', exact: true });
      await expect(timeline.getByRole('button', { name: 'Télécharger ' + name, exact: true })).toHaveCount(1);
      await expect(timeline.getByText(/LLM non configuré côté serveur/)).toHaveCount(1);
      await timeline.getByRole('button', { name: 'Analyser ' + name, exact: true }).click();
      await expect(editor).toHaveValue('/ask ');
      await expect(composer.getByText(name, { exact: true })).toBeVisible();
      await editor.fill('/ask Quel est le budget ?');
      await composer.getByRole('button', { name: 'Envoyer', exact: true }).click();
      await expect.poll(() => references.length).toBe(1);
      expect(references[0]).toHaveLength(1);
      expect(uploads).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  });
}

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

test('sur mobile, synchronise le titre, la réception, la lecture et la saisie entre deux comptes et deux onglets', async ({ browser, page }) => {
  await withChat(page, 0, async (base, colleague, db) => {
    const receiver = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
    await receiver.addInitScript((token) => localStorage.setItem('chat.token', token), colleague.token);
    try {
      const editor = page.getByRole('textbox', { name: 'Écrire un message' });
      await editor.fill('Premier message à lire');
      await editor.press('Enter');
      const sent = page.getByRole('article').filter({ hasText: 'Premier message à lire' });
      await expect(sent.getByText('Envoyé', { exact: true })).toBeVisible();

      const background = await receiver.newPage();
      await background.addInitScript(() => {
        // Les moteurs en mode headless peuvent laisser tous les onglets visibles.
        Object.defineProperty(document, 'hidden', { get: () => true });
      });
      await background.goto(base);
      await expect(background).toHaveTitle("(1) Chat d'équipe");
      await expect(background.locator('link[rel="icon"]')).toHaveAttribute('href', /\/chatroom-unread.svg$/);
      await expect(sent.getByText('Reçu par 1', { exact: true })).toBeVisible();

      await editor.fill('Deuxième message à lire');
      await editor.press('Enter');
      await expect(background).toHaveTitle("(2) Chat d'équipe");
      for (let index = 1; index <= 55; index++) db.insertMessage(colleague.user.id, 'Notes suivantes ' + index);
      await background.reload();
      await expect(background).toHaveTitle("(2) Chat d'équipe");

      const foreground = await receiver.newPage();
      await foreground.goto(base);
      await foreground.bringToFront();
      const first = foreground.getByText('Premier message à lire', { exact: true });
      await expect(first).toHaveCount(0);
      await foreground.getByRole('button', { name: '2 nouveaux messages', exact: true }).tap();
      await expect(first).toBeInViewport();
      await expect(background).toHaveTitle("Chat d'équipe");
      await expect(background.locator('link[rel="icon"]')).toHaveAttribute('href', '/chatroom.svg');
      await expect(sent.getByText('Lu par 1', { exact: true })).toBeVisible();

      const reply = foreground.getByRole('textbox', { name: 'Écrire un message' });
      await reply.fill('Un brouillon');
      await expect(page.getByRole('status', { name: 'Activité de la conversation' })).toHaveText('Noémie écrit');
      await reply.fill('');
      await expect(page.getByRole('status', { name: 'Activité de la conversation' })).toBeEmpty();
      expect(await foreground.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    } finally {
      await receiver.close();
    }
  });
});

test('affiche l’activité pendant la réponse de l’assistant de l’agenda', async ({ page }) => {
  await withChat(page, 0, async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/agenda/assistant', async (route) => {
      await pending;
      await route.fulfill({ status: 503, json: { error: 'Indisponibilité simulée' } });
    });
    const editor = page.getByRole('textbox', { name: 'Écrire un message' });
    await editor.fill('/agenda Combien d’appels prévus ?');
    await editor.press('Enter');
    const status = page.getByRole('status', { name: 'Activité de la conversation' });
    try {
      await expect(status).toHaveText('L’assistant consulte l’agenda');
    } finally {
      release();
    }
    await expect(status).toBeEmpty();
    await expect(page.getByRole('alert')).toContainText('Impossible d’interroger l’agenda.');
  });
});

async function observeRingtone(page: Page) {
  await page.addInitScript(() => {
    const scope = window as typeof window & { callTones: number[] };
    scope.callTones = [];
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const oscillator = create.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (when?: number) => {
        scope.callTones.push(oscillator.frequency.value);
        start(when);
      };
      return oscillator;
    };
  });
}

function tones(page: Page) {
  return page.evaluate(() => (window as typeof window & { callTones: number[] }).callTones);
}

test('à 320 px, active la sonnerie depuis un appel reçu avant le premier clic', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await observeRingtone(page);
  await withChat(page, 0, async (base, colleague) => {
    const call = await page.request.post(base + '/api/calls/start', {
      headers: { Authorization: 'Bearer ' + colleague.token }, data: { title: 'Appel de Noémie' },
    });
    expect(call.status()).toBe(201);
    await expect(page.getByRole('alert')).toContainText('Active le son pour entendre la sonnerie.');
    expect(await tones(page)).toEqual([]);
    await page.getByRole('button', { name: 'Activer le son', exact: true }).click();
    await expect.poll(() => tones(page)).toEqual([659, 880, 659, 880]);
    await expect(page.getByText('Nouvel appel. Active le son pour entendre la sonnerie.')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});

test('joue une seule sonnerie entre deux onglets et synchronise le réglage de silence', async ({ page, context }) => {
  await observeRingtone(page);
  await withChat(page, 0, async (base, colleague) => {
    const own = await login(page, base, 'Camille');
    const account = (target: Page) => target.getByRole('button', { name: 'Compte de Camille' });
    const testRingtone = async (target: Page) => {
      await target.evaluate(() => { (window as typeof window & { callTones: number[] }).callTones = []; });
      await account(target).click();
      await target.getByRole('menuitem', { name: 'Tester la sonnerie', exact: true }).click();
      await expect.poll(() => tones(target)).toEqual([659, 880, 659, 880]);
      await target.evaluate(() => { (window as typeof window & { callTones: number[] }).callTones = []; });
    };
    await testRingtone(page);
    const other = await context.newPage();
    await observeRingtone(other);
    await other.goto(base);
    await expect(other.getByRole('status').getByText('Connecté', { exact: true })).toBeVisible();
    await testRingtone(other);
    const totalTones = async () => (await tones(page)).length + (await tones(other)).length;
    const call = async (action: 'start' | 'join' | 'end', token = colleague.token) => {
      const response = await page.request.post(base + '/api/calls/' + action, {
        headers: { Authorization: 'Bearer ' + token }, data: {},
      });
      expect(response.ok()).toBe(true);
    };
    try {
      await call('start');
      await expect.poll(totalTones).toBe(4);
      await call('join', own.token);
      await expect(page.getByRole('button', { name: 'Appel en cours', exact: true })).toBeVisible();
      expect(await totalTones()).toBe(4);

      await other.reload();
      await expect(other.getByRole('status').getByText('Connecté', { exact: true })).toBeVisible();
      expect(await tones(other)).toEqual([]);
      await account(page).click();
      await page.getByRole('menuitem', { name: 'Couper la sonnerie des appels', exact: true }).click();
      await account(other).click();
      await expect(other.getByRole('menuitem', { name: 'Activer la sonnerie des appels', exact: true })).toBeVisible();
      await other.keyboard.press('Escape');
      const before = await totalTones();
      await call('end');
      await expect(page.getByRole('button', { name: "Appel d'équipe", exact: true })).toBeVisible();
      await call('start');
      await expect(page.getByRole('button', { name: 'Appel en cours', exact: true })).toBeVisible();
      expect(await totalTones()).toBe(before);
      await expect(page.getByText('Nouvel appel. Active le son pour entendre la sonnerie.')).toHaveCount(0);

      await call('end');
      await testRingtone(page);
      await call('start', own.token);
      await expect(page.getByRole('button', { name: 'Appel en cours', exact: true })).toBeVisible();
      expect(await tones(page)).toEqual([]);
      expect(await tones(other)).toEqual([]);
    } finally {
      await other.close();
    }
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
