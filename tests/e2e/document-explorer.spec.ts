import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const fileName = '2026-11-15-EXEMPLE_AUDIO_COMITE_PROJET_1234567890_ABCDEFGHIJKLMN_98765432101234567890abcdef.m4a';
const fixtureAudio = Buffer.from('fixture de téléchargement');

async function withExplorer(page: Page, run: () => Promise<void>) {
  const { createServer } = await import('../../server/dist/app.js');
  const { loadConfig } = await import('../../server/dist/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-doc-explorer-'));
  const ctx = createServer(loadConfig({ JWT_SECRET: 'docs-e2e-secret' }), dir);

  try {
    await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
    const { port } = ctx.server.address() as AddressInfo;
    const base = 'http://127.0.0.1:' + port;
    const registration = await page.request.post(base + '/api/auth/register', {
      data: { name: 'Camille', password: 'docs-e2e-password' },
    });
    expect(registration.status()).toBe(201);
    const { token, user } = await registration.json() as { token: string; user: { id: number } };
    const archives = ctx.db.createFolder(user.id, 'Archives audio', null);
    ctx.db.createFolder(user.id, 'Comptes rendus', null);
    const audio = await page.request.post(base + '/api/files', {
      headers: { Authorization: 'Bearer ' + token },
      multipart: {
        post: 'false',
        folderId: String(archives.id),
        file: { name: fileName, mimeType: 'audio/mp4', buffer: fixtureAudio },
      },
    });
    expect(audio.status()).toBe(201);

    await page.addInitScript((sessionToken) => localStorage.setItem('chat.token', sessionToken), token);
    await page.goto(base);
    await page.getByRole('button', { name: 'Espace documentaire', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ouvrir le dossier Archives audio' })).toBeVisible();
    await run();
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('crée un dossier, distingue un doublon et retrouve un fichier par la recherche globale', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withExplorer(page, async () => {
    await page.getByRole('button', { name: 'Nouveau dossier', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Nouveau dossier' });
    const name = creation.getByRole('textbox', { name: 'Nom du dossier' });
    await name.fill('Archives audio');
    await creation.getByRole('button', { name: 'Créer le dossier' }).click();
    await expect(creation.getByText('Un dossier porte déjà ce nom à cet endroit')).toBeVisible();
    await name.fill('Projet Atlas');
    await name.press('Enter');
    await expect(creation).toBeHidden();
    await page.getByRole('button', { name: 'Ouvrir le dossier Projet Atlas' }).click();
    await expect(page.getByText('Ce dossier est vide')).toBeVisible();

    const search = page.getByRole('textbox', { name: 'Rechercher dans tous les dossiers' });
    await search.fill('EXEMPLE_AUDIO');
    const file = page.getByRole('button', { name: 'Détails de ' + fileName, exact: true });
    await expect(file).toBeVisible();
    await expect(file).toContainText('Archives audio');

    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Télécharger ' + fileName, exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(fileName);
    expect(fs.readFileSync((await download.path())!)).toEqual(fixtureAudio);

    await page.getByRole('button', { name: 'Effacer la recherche' }).click();
    await expect(page.getByRole('button', { name: 'Projet Atlas', exact: true })).toBeVisible();
    await expect(file).toBeHidden();
    await expect(page.getByText('Ce dossier est vide')).toBeVisible();
  });
});

test('sur mobile, le nom long laisse les actions accessibles et son détail affiche le nom entier', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await withExplorer(page, async () => {
    const upload = page.getByRole('button', { name: 'Déposer un fichier' });
    const { scrollWidth, clientWidth } = await upload.evaluate((button) => ({
      scrollWidth: button.scrollWidth,
      clientWidth: button.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

    await page.getByRole('button', { name: 'Ouvrir le dossier Archives audio' }).click();
    const file = page.getByRole('button', { name: 'Détails de ' + fileName, exact: true });
    const menu = page.getByRole('button', { name: 'Actions du fichier ' + fileName, exact: true });
    await expect(file).toBeVisible();
    await expect(menu).toBeInViewport();
    const [fileBox, menuBox] = await Promise.all([file.boundingBox(), menu.boundingBox()]);
    expect(fileBox!.x + fileBox!.width).toBeLessThanOrEqual(menuBox!.x);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(320);

    await file.click();
    const details = page.getByRole('dialog', { name: 'Détails du fichier' });
    await expect(details.getByText(fileName, { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Fermer', exact: true }).click();
    await menu.click();
    await expect(page.getByRole('menuitem', { name: 'Déplacer…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fermer l’espace documentaire' }).click();
    await expect(page.getByRole('dialog', { name: 'Espace documentaire' })).toBeHidden();
  });
});
