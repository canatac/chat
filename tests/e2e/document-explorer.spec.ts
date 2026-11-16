import { expect, test, type Locator, type Page } from '@playwright/test';
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
    const upload = page.getByRole('button', { name: 'Déposer des fichiers' });
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
      await drawer.locator('input[aria-label="Fichiers à déposer"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.alloc(size, 'a') });
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

async function center(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Élément à déplacer introuvable');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragWithMouse(page: Page, source: Locator, target: Locator) {
  const from = await center(source);
  const to = await center(target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test('dépose depuis l’extérieur, regroupe deux fichiers et déplace un dossier dans un sous-dossier', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withExplorer(page, async () => {
    const drawer = page.getByRole('dialog', { name: 'Espace documentaire' });
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['a'], 'Alpha.txt', { type: 'text/plain' }));
      data.items.add(new File(['b'], 'Bravo.txt', { type: 'text/plain' }));
      return data;
    });
    await drawer.locator('[data-document-scroll][data-document-drop-id="root"]').dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
    const alpha = drawer.getByRole('button', { name: 'Détails de Alpha.txt', exact: true });
    const bravo = drawer.getByRole('button', { name: 'Détails de Bravo.txt', exact: true });
    await expect(bravo).toBeVisible();
    await dragWithMouse(page, alpha, bravo);
    const group = page.getByRole('dialog', { name: 'Regrouper les fichiers' });
    await group.getByRole('textbox', { name: 'Nom du dossier' }).fill('Dossier groupé');
    await group.getByRole('button', { name: 'Créer et regrouper' }).click();
    await expect(group).toBeHidden();
    await expect(alpha).toBeVisible();
    await expect(bravo).toBeVisible();

    const transfer2 = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['e'], 'Externe.txt', { type: 'text/plain' }));
      return data;
    });
    await bravo.dispatchEvent('drop', { dataTransfer: transfer2 });
    await transfer2.dispose();
    await group.getByRole('textbox', { name: 'Nom du dossier' }).fill('Pièces jointes');
    await group.getByRole('button', { name: 'Créer et regrouper' }).click();
    await expect(drawer.getByRole('button', { name: 'Détails de Externe.txt' })).toBeVisible();

    const places = drawer.getByRole('navigation', { name: 'Emplacements des documents' });
    await places.getByRole('button', { name: 'Racine', exact: true }).click();
    await places.getByRole('button', { name: 'Déplier Archives audio' }).click();
    const nested = places.getByRole('button', { name: 'Aller au dossier Transcriptions' });
    await drawer.getByRole('button', { name: 'Vue grille' }).click();
    const folder = drawer.getByRole('button', { name: 'Ouvrir le dossier Dossier groupé' });
    await dragWithMouse(page, folder, nested);
    await expect(folder).toHaveCount(0);
    await nested.click();
    await expect(folder).toBeVisible();
    await folder.click();
    await expect(alpha).toBeVisible();
    await drawer.getByRole('button', { name: 'Ouvrir le dossier Pièces jointes' }).click();
    await expect(bravo).toBeVisible();
  }, true);
});

test('déplace un fichier au toucher et parcourt la destination sur mobile', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 820 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  try {
    await withExplorer(page, async () => {
      const drawer = page.getByRole('dialog', { name: 'Espace documentaire' });
      await drawer.locator('input[aria-label="Fichiers à déposer"]').setInputFiles([
        { name: 'Tactile.txt', mimeType: 'text/plain', buffer: Buffer.from('premier') },
        { name: 'Clavier.txt', mimeType: 'text/plain', buffer: Buffer.from('second') },
      ]);
      const tactile = drawer.getByRole('button', { name: 'Détails de Tactile.txt' });
      await expect(tactile).toBeVisible();
      const from = await center(drawer.getByRole('button', { name: 'Déplacer Tactile.txt', exact: true }));
      const to = await center(drawer.getByRole('button', { name: 'Ouvrir le dossier Comptes rendus' }));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x - 20, y: from.y - 15 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(tactile).toHaveCount(0);
      await expect(drawer.getByText('Déplacé dans « Comptes rendus ».')).toBeVisible();

      await drawer.getByRole('button', { name: 'Déplacer Clavier.txt', exact: true }).tap();
      const destination = page.getByRole('dialog', { name: 'Déplacer vers' });
      await expect(destination).toBeVisible();
      await destination.getByRole('button', { name: 'Archives audio', exact: true }).tap();
      await destination.getByRole('button', { name: 'Transcriptions', exact: true }).tap();
      await destination.getByRole('button', { name: 'Déplacer ici' }).tap();
      await expect(destination).toBeHidden();
      await drawer.getByRole('button', { name: 'Ouvrir le dossier Comptes rendus' }).tap();
      await expect(tactile).toBeVisible();
      await drawer.getByRole('button', { name: 'Afficher les emplacements' }).tap();
      const places = page.getByRole('dialog', { name: 'Emplacements', exact: true });
      await places.getByRole('button', { name: 'Déplier Archives audio', exact: true }).tap();
      await places.getByRole('button', { name: 'Aller au dossier Transcriptions', exact: true }).tap();
      const keyboardFile = drawer.getByRole('button', { name: 'Détails de Clavier.txt' });
      await expect(keyboardFile).toBeVisible();
      await drawer.locator('input[aria-label="Fichiers à déposer"]').setInputFiles({ name: 'Autre.txt', mimeType: 'text/plain', buffer: Buffer.from('autre') });
      const other = drawer.getByRole('button', { name: 'Détails de Autre.txt' });
      await expect(other).toBeVisible();
      await drawer.getByRole('button', { name: 'Actions du fichier Clavier.txt' }).tap();
      await page.getByRole('menuitem', { name: 'Regrouper avec un fichier…' }).tap();
      await other.tap();
      const group = page.getByRole('dialog', { name: 'Regrouper les fichiers' });
      await group.getByRole('textbox', { name: 'Nom du dossier' }).fill('Réunis');
      await group.getByRole('button', { name: 'Créer et regrouper' }).tap();
      await expect(keyboardFile).toBeVisible();
      await expect(other).toBeVisible();
    }, true);
  } finally {
    await context.close();
  }
});

test('importe l’arborescence d’un dossier déposé et celle d’un dossier choisi', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-import-dossier-'));
  const directory = path.join(temporary, 'Sélection locale');
  const deepPath = path.join(directory, ...Array.from({ length: 12 }, (_, index) => 'Niveau ' + (index + 1)));
  const droppedDirectory = path.join(temporary, 'Dossier déposé');
  fs.mkdirSync(path.join(droppedDirectory, 'Vide'), { recursive: true });
  fs.mkdirSync(path.join(droppedDirectory, 'Sous-dossier'));
  fs.writeFileSync(path.join(droppedDirectory, 'Sous-dossier', 'Feuille.txt'), 'document déposé');
  fs.mkdirSync(deepPath, { recursive: true });
  fs.writeFileSync(path.join(deepPath, 'Profondeur.txt'), 'document importé');
  try {
    await withExplorer(page, async () => {
      const drawer = page.getByRole('dialog', { name: 'Espace documentaire' });
      const pane = await drawer.locator('[data-document-scroll][data-document-drop-id="root"]').boundingBox();
      if (!pane) throw new Error('Zone de dépôt introuvable');
      const cdp = await page.context().newCDPSession(page);
      const drag = { x: pane.x + 24, y: pane.y + pane.height - 24, data: { items: [], files: [droppedDirectory], dragOperationsMask: 1 } };
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...drag });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...drag });
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...drag });
      await cdp.detach();
      await drawer.getByRole('button', { name: 'Ouvrir le dossier Dossier déposé' }).click();
      await expect(drawer.getByRole('button', { name: 'Ouvrir le dossier Vide' })).toBeVisible();
      await drawer.getByRole('button', { name: 'Ouvrir le dossier Sous-dossier' }).click();
      await expect(drawer.getByRole('button', { name: 'Détails de Feuille.txt' })).toBeVisible();

      await drawer.getByRole('navigation', { name: 'Emplacements des documents' }).getByRole('button', { name: 'Racine', exact: true }).click();
      await drawer.locator('input[aria-label="Dossier à importer"]').setInputFiles(directory);
      await expect(drawer.getByRole('button', { name: 'Ouvrir le dossier Sélection locale' })).toBeVisible();
      await drawer.getByRole('textbox', { name: 'Rechercher dans tous les dossiers' }).fill('Profondeur');
      await expect(drawer.getByRole('button', { name: 'Détails de Profondeur.txt' })).toContainText('Niveau 12');
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('à 320 px, sélectionne toute la pagination, déplace le lot et confirme sa suppression', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 820 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.route('**/api/files?*', (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set('limit', '2');
      return route.continue({ url: url.toString() });
    });
    await withExplorer(page, async () => {
      const drawer = page.getByRole('dialog', { name: 'Espace documentaire' });
      await drawer.getByRole('button', { name: 'Ouvrir le dossier Comptes rendus' }).tap();
      await drawer.getByRole('button', { name: 'Nouveau dossier', exact: true }).tap();
      const create = page.getByRole('dialog', { name: 'Nouveau dossier' });
      await create.getByRole('textbox', { name: 'Nom du dossier' }).fill('Dossier du lot');
      await create.getByRole('button', { name: 'Créer le dossier' }).tap();
      await expect(drawer.getByRole('button', { name: 'Ouvrir le dossier Dossier du lot' })).toBeVisible();

      await drawer.locator('input[aria-label="Fichiers à déposer"]').setInputFiles(['Alpha.txt', 'Bravo.txt', 'Zèbre.txt'].map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
      await expect(drawer.getByRole('button', { name: 'Afficher plus de fichiers' })).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Détails de Zèbre.txt' })).toHaveCount(0);
      await drawer.getByRole('button', { name: 'Sélectionner', exact: true }).tap();
      const actions = drawer.getByRole('group', { name: 'Actions de sélection' });
      await actions.getByRole('button', { name: 'Tout sélectionner' }).tap();
      await expect(actions.getByRole('status')).toHaveText('4 éléments sélectionnés');
      const item = drawer.getByRole('checkbox', { name: 'Sélectionner Bravo.txt', exact: true });
      await expect(item).toHaveAttribute('aria-checked', 'true');
      await item.tap();
      await expect(actions.getByRole('status')).toHaveText('3 éléments sélectionnés');
      await item.tap();
      await expect(actions.getByRole('status')).toHaveText('4 éléments sélectionnés');
      expect(await actions.evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(1);

      await actions.getByRole('button', { name: 'Déplacer…' }).tap();
      const move = page.getByRole('dialog', { name: 'Déplacer vers' });
      await move.getByRole('button', { name: 'Racine', exact: true }).tap();
      await move.getByRole('button', { name: 'Archives audio', exact: true }).tap();
      await move.getByRole('button', { name: 'Transcriptions', exact: true }).tap();
      await move.getByRole('button', { name: 'Déplacer ici' }).tap();
      await expect(drawer.getByText('4 éléments déplacés dans « Transcriptions ».')).toBeVisible();
      await expect(drawer.getByText('Ce dossier est vide')).toBeVisible();

      await drawer.getByRole('button', { name: 'Afficher les emplacements' }).tap();
      const places = page.getByRole('dialog', { name: 'Emplacements', exact: true });
      await places.getByRole('button', { name: 'Déplier Archives audio' }).tap();
      await places.getByRole('button', { name: 'Aller au dossier Transcriptions' }).tap();
      await drawer.getByRole('button', { name: 'Afficher plus de fichiers' }).tap();
      await expect(drawer.getByRole('button', { name: 'Détails de Zèbre.txt' })).toBeVisible();
      await drawer.getByRole('button', { name: 'Sélectionner', exact: true }).tap();
      await actions.getByRole('button', { name: 'Tout sélectionner' }).tap();
      await expect(actions.getByRole('status')).toHaveText('4 éléments sélectionnés');
      await actions.getByRole('button', { name: 'Supprimer…' }).tap();
      const confirmation = page.getByRole('dialog', { name: 'Supprimer la sélection ?' });
      await expect(confirmation.getByText('Le contenu des dossiers sélectionnés sera aussi supprimé.')).toBeVisible();
      await confirmation.getByRole('button', { name: 'Annuler' }).tap();
      await expect(actions.getByRole('status')).toHaveText('4 éléments sélectionnés');
      await actions.getByRole('button', { name: 'Supprimer…' }).tap();
      await confirmation.getByRole('button', { name: 'Supprimer', exact: true }).tap();
      await expect(drawer.getByText('4 éléments supprimés.')).toBeVisible();
      await expect(drawer.getByText('Ce dossier est vide')).toBeVisible();
    }, true);
  } finally {
    await context.close();
  }
});

test('sélectionne les fichiers filtrés au clavier et déplace en glissant depuis la grille ou l’arborescence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withExplorer(page, async () => {
    const drawer = page.getByRole('dialog', { name: 'Espace documentaire' });
    const places = drawer.getByRole('navigation', { name: 'Emplacements des documents' });
    await drawer.locator('input[aria-label="Fichiers à déposer"]').setInputFiles(['Lot alpha.txt', 'Lot bravo.txt', 'À conserver.txt'].map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
    await expect(drawer.getByRole('button', { name: 'Détails de Lot bravo.txt' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Vue grille' }).click();
    await drawer.getByRole('button', { name: 'Filtrer par nom' }).click();
    const filter = page.getByRole('dialog', { name: 'Filtrer par nom' });
    await filter.getByLabel('Le nom contient').fill('Lot');
    await filter.getByRole('button', { name: 'Appliquer' }).click();
    await expect(drawer.getByRole('button', { name: 'Détails de À conserver.txt' })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Vue grille' }).focus();
    await page.keyboard.press('Control+a');
    const actions = drawer.getByRole('group', { name: 'Actions de sélection' });
    await expect(actions.getByRole('status')).toHaveText('2 éléments sélectionnés');
    const alpha = drawer.getByRole('checkbox', { name: 'Sélectionner Lot alpha.txt' });
    await expect(alpha).toHaveAttribute('aria-checked', 'true');

    const destination = places.getByRole('button', { name: 'Aller au dossier Comptes rendus' });
    await dragWithMouse(page, alpha, destination);
    await expect(drawer.getByText('2 éléments déplacés dans « Comptes rendus ».')).toBeVisible();
    await drawer.getByRole('button', { name: 'Effacer les filtres' }).click();
    await expect(drawer.getByRole('button', { name: 'Détails de À conserver.txt' })).toBeVisible();

    const archive = places.getByRole('button', { name: 'Aller au dossier Archives audio' });
    await dragWithMouse(page, archive, destination);
    await places.getByRole('button', { name: 'Déplier Comptes rendus' }).click();
    await expect(archive).toBeVisible();
    await destination.click();
    await expect(drawer.getByRole('button', { name: 'Ouvrir le dossier Archives audio' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Détails de Lot bravo.txt' })).toBeVisible();
  });
});

test('renomme, déplace et supprime un dossier depuis les emplacements tactiles', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 820 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await withExplorer(page, async () => {
      await page.getByRole('button', { name: 'Afficher les emplacements' }).tap();
      const places = page.getByRole('dialog', { name: 'Emplacements', exact: true });
      const actions = (name: string) => places.getByRole('button', { name: `Actions de ${name} dans l’arborescence`, exact: true });
      const menu = page.getByRole('menu');
      await actions('Archives audio').tap();
      await menu.getByRole('menuitem', { name: 'Renommer' }).tap();
      const rename = page.getByRole('dialog', { name: 'Renommer le dossier' });
      await rename.getByRole('textbox', { name: 'Nom du dossier' }).fill('Archives renommées');
      await rename.getByRole('button', { name: 'Enregistrer' }).tap();

      await actions('Archives renommées').tap();
      await menu.getByRole('menuitem', { name: 'Déplacer…' }).tap();
      const move = page.getByRole('dialog', { name: 'Déplacer vers' });
      await move.getByRole('button', { name: 'Comptes rendus' }).tap();
      await move.getByRole('button', { name: 'Déplacer ici' }).tap();
      await places.getByRole('button', { name: 'Déplier Comptes rendus' }).tap();

      await actions('Archives renommées').tap();
      await menu.getByRole('menuitem', { name: 'Supprimer' }).tap();
      const confirmation = page.getByRole('dialog', { name: 'Supprimer le dossier ?' });
      await expect(confirmation.getByText('« Archives renommées » sera supprimé définitivement.')).toBeVisible();
      await confirmation.getByRole('checkbox', { name: 'Supprimer aussi le contenu du dossier' }).tap();
      await confirmation.getByRole('button', { name: 'Supprimer', exact: true }).tap();
      await expect(places).toBeVisible();
      await expect(places.getByRole('button', { name: 'Replier Comptes rendus' })).toHaveCount(0);
      await expect(actions('Archives renommées')).toHaveCount(0);
      expect(await places.evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(1);
    });
  } finally {
    await context.close();
  }
});
