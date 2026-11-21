import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

test('à 320 px, administre la politique puis annule ou masque avant tout envoi externe', async ({ page }) => {
  const { createServer } = await import('../../server/dist/app.js');
  const { DB } = await import('../../server/dist/db.js');
  const { loadConfig } = await import('../../server/dist/config.js');
  const { hashPassword } = await import('../../server/dist/auth.js');
  const pii = 'jean.dupont@example.test';
  const sent: string[] = [];
  const provider = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    sent.push(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Réponse contrôlée ' + sent.length } }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-e2e-'));
  const seed = new DB(dir);
  seed.createUser('Camille', hashPassword('chat-security-e2e'));
  seed.close();
  const app = createServer(loadConfig({ JWT_SECRET: 'security-e2e-secret', ADMIN_NAMES: 'Camille', LLM_MODEL: 'test',
    LLM_BASE_URL: 'http://127.0.0.1:' + (provider.address() as AddressInfo).port + '/v1' }), dir, () => ({
    health: async () => ({ status: 'ok', agent: 'linguard', version: 'test', api: 'v1' }),
    analyze: async (texts: string[]) => ({
      texts: texts.map((text) => [...text.matchAll(/jean\.dupont@example\.test/g)].map((match) => ({
        type: 'EMAIL', start: Buffer.byteLength(text.slice(0, match.index)), end: Buffer.byteLength(text.slice(0, match.index)) + pii.length,
        text: pii, score: 9500,
      }))),
      model_errors: [],
    }),
  }));
  try {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port;
    const response = await page.request.post(base + '/api/auth/login', { data: { name: 'Camille', password: 'chat-security-e2e' } });
    const { token } = await response.json() as { token: string };
    await page.addInitScript((value) => localStorage.setItem('chat.token', value), token);
    await page.setViewportSize({ width: 320, height: 780 });
    await page.goto(base);
    await expect(page.getByRole('status', { name: 'Protection MaelGard' })).toContainText('active');
    const setPolicy = async (label: string) => {
      await page.getByRole('button', { name: 'Compte de Camille' }).click();
      await page.getByRole('menuitem', { name: 'Sécurité MaelGard', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Politique de sécurité MaelGard' });
      await settings.getByRole('combobox', { name: 'Si des données personnelles sont détectées' }).click();
      await page.getByRole('option', { name: label, exact: true }).click();
      await settings.getByRole('button', { name: 'Enregistrer la politique' }).click();
      await expect(settings).toBeHidden();
    };
    const send = async (label: string) => {
      const editor = page.getByRole('textbox', { name: 'Écrire un message' });
      await editor.fill('/ask ' + label + ' Élodie 🧪 ' + pii);
      await editor.press('Enter');
      await expect(page.locator('textarea[aria-label="Écrire un message"]')).toBeEmpty();
    };

    await setPolicy('Laisser l’utilisateur masquer ou annuler');
    await send('Annulation');
    const review = page.getByRole('dialog', { name: 'Données personnelles détectées' });
    await expect(review).toContainText('EMAIL');
    await expect(review).not.toContainText(pii);
    expect(sent.length).toBe(0);
    await review.getByRole('button', { name: 'Annuler l’envoi' }).click();
    await expect(review).toBeHidden();
    expect(sent.length).toBe(0);
    await send('Confirmation');
    await expect(review).toBeVisible();
    await expect(review.getByRole('button', { name: 'Masquer et envoyer' })).toBeInViewport();
    await review.getByRole('button', { name: 'Masquer et envoyer' }).click();
    await expect(page.getByText('Réponse contrôlée 1', { exact: true })).toBeVisible();
    expect(sent[0]).not.toContain(pii);
    expect(sent[0]).toContain('[EMAIL]');

    await setPolicy('Bloquer l’envoi');
    await send('Blocage');
    await expect(page.getByText(/Des données personnelles ont été détectées/)).toBeVisible();
    expect(sent.length).toBe(1);
    await expect(review).toBeHidden();
    await setPolicy('Masquer automatiquement et envoyer');
    await send('Masquage automatique');
    await expect(page.getByText('Réponse contrôlée 2', { exact: true })).toBeVisible();
    expect(sent[1]).not.toContain(pii);
    await expect(review).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
