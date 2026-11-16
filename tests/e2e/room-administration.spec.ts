import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function openAdmin(page: Page, alias: string) {
  await page.getByRole('button', { name: 'Compte de ' + alias }).click();
  await page.getByRole('menuitem', { name: 'Administration' }).click();
  const dialog = page.getByRole('dialog', { name: 'Administration' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('crée un salon, invite et modifie un membre, puis change de salon en superadmin', async ({ browser, page }) => {
  const { createServer } = await import('../../server/dist/app.js');
  const { loadConfig } = await import('../../server/dist/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-room-admin-e2e-'));
  const ctx = createServer(loadConfig({
    JWT_SECRET: 'room-admin-e2e-secret',
    SUPERADMIN_NAMES: 'Administrateur',
    SUPERADMIN_PASSWORD: 'e2e-superadmin-password',
  }), dir);
  const member = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const root = await browser.newPage();
  try {
    await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (ctx.server.address() as AddressInfo).port;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await page.getByRole('tab', { name: 'Créer un compte' }).click();
    await page.getByLabel('Nom du salon').fill('Projet Sépia');
    await page.getByLabel('Alias').fill('Camille');
    await page.getByLabel('Adresse e-mail').fill('camille@example.test');
    await page.getByLabel('Mot de passe').fill('e2e-password-camille');
    await page.getByRole('button', { name: 'Créer mon salon' }).click();
    await expect(page.getByRole('heading', { name: 'Projet Sépia' })).toBeVisible();
    const roomUrl = page.url();
    const admin = await openAdmin(page, 'Camille');
    await expect(admin.getByLabel('Salon à gérer')).toHaveCount(0);
    await expect(admin.getByRole('button', { name: 'Nouveau salon' })).toHaveCount(0);
    await admin.getByLabel('E-mail à inviter').fill('leo@example.test');
    await admin.getByRole('button', { name: 'Créer le lien' }).click();
    const link = admin.getByLabel('Lien d’invitation');
    await expect(link).toHaveValue(/#invitation=/);

    await member.goto(await link.inputValue());
    await expect(member.getByText('Invitation pour leo@example.test')).toBeVisible();
    await member.getByLabel('Alias').fill('Léo');
    await member.getByLabel('Mot de passe').fill('e2e-password-member');
    await member.getByRole('button', { name: 'Rejoindre le salon' }).click();
    await expect(member.getByRole('heading', { name: 'Projet Sépia' })).toBeVisible();
    await expect(member).toHaveURL(roomUrl);
    await member.getByRole('button', { name: 'Compte de Léo' }).click();
    await expect(member.getByRole('menuitem', { name: 'Se déconnecter' })).toBeVisible();
    await expect(member.getByRole('menuitem', { name: 'Administration' })).toHaveCount(0);
    await member.keyboard.press('Escape');
    await expect(member.getByText('Connecté', { exact: true })).toBeVisible();

    await admin.getByRole('button', { name: 'Actualiser les membres' }).click();
    await admin.getByRole('button', { name: 'Modifier Léo' }).click();
    const editor = page.getByRole('dialog', { name: 'Modifier le profil' });
    await editor.getByLabel('Alias').fill('Léo Martin');
    await editor.getByLabel('Adresse e-mail').fill('leo.martin@example.test');
    const avatar = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 20;
      const c = canvas.getContext('2d')!;
      c.fillStyle = '#11655c';
      c.fillRect(0, 0, 20, 20);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await editor.locator('input[type=file]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(avatar, 'base64') });
    await expect(editor.getByRole('button', { name: 'Retirer l’avatar' })).toBeVisible();
    await editor.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(editor).toBeHidden();
    await expect(admin.getByText('leo.martin@example.test')).toBeVisible();
    const account = member.getByRole('button', { name: 'Compte de Léo Martin' });
    await expect(account).toBeVisible();
    await expect(account.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);

    await root.goto(base);
    await root.getByLabel('E-mail ou identifiant').fill('Administrateur');
    await root.getByLabel('Mot de passe').fill('e2e-superadmin-password');
    await root.getByRole('button', { name: 'Se connecter' }).click();
    const rootDialog = await openAdmin(root, 'Administrateur');
    await rootDialog.getByRole('combobox', { name: 'Salon à gérer' }).click();
    await root.getByRole('option', { name: 'Projet Sépia' }).click();
    await expect(rootDialog.getByText('leo.martin@example.test')).toBeVisible();
    await rootDialog.getByRole('button', { name: 'Ouvrir le salon' }).click();
    await expect(root).toHaveURL(roomUrl);
    await expect(root.getByRole('heading', { name: 'Projet Sépia' })).toBeVisible();

    await admin.getByRole('button', { name: 'Retirer Léo Martin' }).click();
    await page.getByRole('dialog', { name: 'Retirer Léo Martin ?' }).getByRole('button', { name: 'Confirmer' }).click();
    await expect(member.getByRole('tab', { name: 'Connexion' })).toBeVisible();
  } finally {
    await Promise.all([member.close(), root.close()]);
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
