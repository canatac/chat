import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const fileName = '2026-11-15-EXEMPLE_AUDIO_COMITE_PROJET_1234567890_ABCDEFGHIJKLMN_98765432101234567890abcdef.m4a';
const fixtureAudio = Buffer.from('fixture de téléchargement');

async function withExplorer(page: Page, run: () => Promise<void>, seedNavigation = false) {
  const { createServer } = await import('../../server/dist/app.js');
  const { loadConfig } = await import('../../server/dist/config.js');
  const { DB } = await import('../../server/dist/db.js');
  const { hashPassword } = await import('../../server/dist/auth.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-doc-explorer-'));
  const legacy = new DB(dir);
  legacy.createUser('Camille', hashPassword('docs-e2e-password'));
  legacy.close();
  const ctx = createServer(loadConfig({ JWT_SECRET: 'docs-e2e-secret' }), dir);

  try {
    await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
    const { port } = ctx.server.address() as AddressInfo;
    const base = 'http://127.0.0.1:' + port;
    const login = await page.request.post(base + '/api/auth/login', {
      data: { name: 'Camille', password: 'docs-e2e-password' },
    });
    expect(login.status()).toBe(200);
    const { token, user } = await login.json() as { token: string; user: { id: number } };
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
    if (seedNavigation) {
      ctx.db.createFolder(user.id, 'Transcriptions', archives.id);
      const old = ctx.db.insertFile(user.id, null, 'Ancien compte rendu.txt', 'text/plain', 8, 'ancien.txt', null, archives.id);
      fs.writeFileSync(path.join(dir, 'uploads', 'ancien.txt'), 'Archive\n');
      const database = new DatabaseSync(path.join(dir, 'chat.db'));
      try {
        database.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(Date.now() - 45 * 86_400_000, old.id);
      } finally {
        database.close();
      }
    }

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

    const placesButton = page.getByRole('button', { name: 'Afficher les emplacements' });
    await placesButton.click();
    const places = page.getByRole('dialog', { name: 'Emplacements', exact: true });
    await expect(places).toBeVisible();
    await places.getByRole('button', { name: 'Aller au dossier Archives audio' }).click();
    await expect(places).toBeHidden();
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

test('navigue dans l’arborescence, revient en arrière et retrouve les fichiers récents en grille', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withExplorer(page, async () => {
    const drawer = page.getByRole('dialog', { name: 'Espace documentaire' });
    const places = drawer.getByRole('navigation', { name: 'Emplacements des documents' });
    const breadcrumb = drawer.getByRole('navigation', { name: 'Chemin du dossier' });
    const previous = drawer.getByRole('button', { name: 'Précédent' });
    const next = drawer.getByRole('button', { name: 'Suivant' });
    await expect(places.getByRole('button', { name: 'Racine' })).toHaveAttribute('aria-current', 'page');
    await expect(previous).toBeDisabled();
    await places.getByRole('button', { name: 'Déplier Archives audio' }).click();
    await expect(places.getByRole('button', { name: 'Aller au dossier Transcriptions' })).toBeVisible();
    await places.getByRole('button', { name: 'Aller au dossier Archives audio' }).click();
    await places.getByRole('button', { name: 'Aller au dossier Transcriptions' }).click();
    await expect(breadcrumb.getByRole('button', { name: 'Transcriptions' })).toHaveAttribute('aria-current', 'page');
    await expect(drawer.getByText('Ce dossier est vide')).toBeVisible();

    await previous.click();
    await expect(breadcrumb.getByRole('button', { name: 'Archives audio' })).toHaveAttribute('aria-current', 'page');
    await next.click();
    await expect(breadcrumb.getByRole('button', { name: 'Transcriptions' })).toHaveAttribute('aria-current', 'page');
    await breadcrumb.getByRole('button', { name: 'Archives audio' }).click();
    await expect(places.getByRole('button', { name: 'Aller au dossier Archives audio' })).toHaveAttribute('aria-current', 'page');

    await places.getByRole('button', { name: 'Récents' }).click();
    await expect(drawer.getByText('30 derniers jours')).toBeVisible();
    const recentFile = drawer.getByRole('button', { name: 'Détails de ' + fileName, exact: true });
    const oldFile = drawer.getByRole('button', { name: 'Détails de Ancien compte rendu.txt' });
    await expect(recentFile).toContainText('Archives audio');
    await expect(oldFile).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Trier par date, ordre décroissant' })).toBeVisible();

    await drawer.getByRole('button', { name: 'Vue grille' }).click();
    const grid = drawer.getByRole('list', { name: 'Documents en grille' });
    await expect(grid.getByRole('button', { name: 'Télécharger ' + fileName })).toBeVisible();
    await drawer.getByRole('button', { name: 'Filtrer par date', exact: true }).click();
    const filter = page.getByRole('dialog', { name: 'Filtrer par date' });
    await filter.getByLabel('Au', { exact: true }).fill('2000-01-01');
    await filter.getByRole('button', { name: 'Appliquer' }).click();
    await expect(drawer.getByText('Aucun résultat', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Effacer les filtres' }).click();
    await expect(recentFile).toBeVisible();

    await drawer.getByRole('textbox', { name: 'Rechercher dans tous les dossiers' }).fill('Ancien compte');
    await expect(oldFile).toBeVisible();
    await previous.click();
    await expect(recentFile).toBeVisible();
    await expect(oldFile).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Espace documentaire', exact: true }).click();
    await expect(drawer.getByRole('button', { name: 'Vue grille' })).toHaveAttribute('aria-pressed', 'true');
  }, true);
});

test('trie et filtre les fichiers depuis les en-têtes sur mobile, y compris au-delà de la première page', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 });
  await page.route('**/api/files?*', (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '2');
    return route.continue({ url: url.toString() });
  });
  await withExplorer(page, async () => {
    await page.getByRole('button', { name: 'Ouvrir le dossier Comptes rendus' }).click();
    const drawer = page.getByRole('dialog', { name: 'Espace documentaire' });
    const controls = drawer.getByRole('group', { name: 'Tri et filtres des fichiers' });
    const files = drawer.getByRole('button', { name: /^Détails de / });
    const expectFiles = async (...names: string[]) => {
      await expect.poll(() => files.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))))
        .toEqual(names.map((name) => 'Détails de ' + name));
    };
    for (const [name, size] of [['Zèbre.txt', 1024], ['Équipe.txt', 3072], ['Alpha.txt', 8192]] as const) {
      await drawer.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.alloc(size, 'a') });
      await expect(drawer.getByRole('button', { name: 'Détails de ' + name, exact: true })).toBeVisible();
    }

    await expectFiles('Alpha.txt', 'Équipe.txt');
    await drawer.getByRole('button', { name: 'Afficher plus de fichiers' }).click();
    await expectFiles('Alpha.txt', 'Équipe.txt', 'Zèbre.txt');

    const nameSort = controls.getByRole('button', { name: /^Trier par nom/ });
    await nameSort.focus();
    await page.keyboard.press('Enter');
    await expectFiles('Zèbre.txt', 'Équipe.txt');
    const dateSort = controls.getByRole('button', { name: /^Trier par date/ });
    await dateSort.click();
    await expectFiles('Alpha.txt', 'Équipe.txt');
    await dateSort.click();
    await expectFiles('Zèbre.txt', 'Équipe.txt');
    const sizeSort = controls.getByRole('button', { name: /^Trier par taille/ });
    await sizeSort.click();
    await expectFiles('Zèbre.txt', 'Équipe.txt');
    await sizeSort.click();
    await expectFiles('Alpha.txt', 'Équipe.txt');

    await controls.getByRole('button', { name: 'Filtrer par taille' }).click();
    const sizeFilter = page.getByRole('dialog', { name: 'Filtrer par taille' });
    await sizeFilter.getByLabel('Minimum (Ko)', { exact: true }).fill('2');
    await sizeFilter.getByLabel('Maximum (Ko)', { exact: true }).fill('4');
    await sizeFilter.getByRole('button', { name: 'Appliquer' }).click();
    await expectFiles('Équipe.txt');

    await controls.getByRole('button', { name: 'Filtrer par nom' }).click();
    const nameFilter = page.getByRole('dialog', { name: 'Filtrer par nom' });
    await nameFilter.getByLabel('Le nom contient').fill('EQUIPE');
    await nameFilter.getByRole('button', { name: 'Appliquer' }).click();
    await expectFiles('Équipe.txt');
    await expect(controls.getByRole('button', { name: 'Filtrer par nom, filtre actif' })).toBeVisible();

    const dateFilterButton = controls.getByRole('button', { name: 'Filtrer par date' });
    await dateFilterButton.click();
    const dateFilter = page.getByRole('dialog', { name: 'Filtrer par date' });
    await dateFilter.getByLabel('Du', { exact: true }).fill('2000-01-01');
    await dateFilter.getByLabel('Au', { exact: true }).fill('2000-01-01');
    await dateFilter.getByRole('button', { name: 'Appliquer' }).click();
    await expect(drawer.getByText('Aucun résultat', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'Effacer les filtres' }).click();
    await expectFiles('Alpha.txt', 'Équipe.txt');
  });
});
