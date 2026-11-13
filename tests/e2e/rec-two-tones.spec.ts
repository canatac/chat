import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Test de régression navigateur : deux comptes, deux tonalités injectées dans le micro
// (440 Hz vs 880 Hz), REC lancé par A et arrêté par B. On télécharge le fichier déposé,
// on le décode (ffmpeg si dispo) et on vérifie durée + présence des deux fréquences.

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

test.beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-e2e-'));
  const { createServer } = await import('../../server/dist/app.js');
  const { loadConfig } = await import('../../server/dist/config.js');
  const config = loadConfig({
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    JWT_SECRET: 'e2e-secret-123456',
    LLM_MODEL: '',
  });
  const ctx = createServer(config, dataDir);
  await new Promise<void>((r) => ctx.server.listen(PORT, '127.0.0.1', r));
  (globalThis as Record<string, unknown>).__ctx = ctx;
  (globalThis as Record<string, unknown>).__dataDir = dataDir;
});

test.afterAll(async () => {
  const ctx = (globalThis as Record<string, unknown>).__ctx as { close: () => Promise<void> } | undefined;
  const dataDir = (globalThis as Record<string, unknown>).__dataDir as string;
  await ctx?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function registerAndLogin(page: Page, name: string, freq: number) {
  await page.addInitScript((f) => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (async (c?: MediaStreamConstraints) => {
      if (c?.audio) return dest.stream;
      return orig(c);
    }) as typeof navigator.mediaDevices.getUserMedia;
  }, freq);
  const res = await page.request.post(`${BASE}/api/auth/register`, {
    data: { name, password: 'secret123' },
  });
  const { token } = await res.json();
  await page.goto(BASE);
  await page.evaluate((t) => localStorage.setItem('chat.token', t), token);
  await page.reload();
  await page.getByText("Chat d'équipe").first().waitFor();
}

async function callApi(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const token = localStorage.getItem('chat.token');
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json();
    },
    { method, url, body },
  );
}

test('deux voix dans un seul fichier (440 Hz + 880 Hz), REC lancé par A arrêté par B', async ({ browser }) => {
  const ctxA = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const ctxB = await browser.newContext({ permissions: ['microphone', 'camera'] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await registerAndLogin(pageA, 'AliceE2E', 440);
  await registerAndLogin(pageB, 'BobE2E', 880);

  const call = await callApi(pageA, 'POST', `${BASE}/api/calls/start`, { title: 'E2E' });
  await callApi(pageB, 'POST', `${BASE}/api/calls/join`, {});

  await pageA.locator('button:has(svg[data-testid="PhoneIcon"])').first().click();
  await pageA.getByRole('button', { name: "Rejoindre l'appel" }).click();
  await pageB.locator('button:has(svg[data-testid="PhoneIcon"])').first().click();
  await pageB.getByRole('button', { name: "Rejoindre l'appel" }).click();

  await pageA.getByRole('button', { name: /Enregistrer l/i }).click();
  await pageA.getByText(/REC —/).waitFor();
  await pageB.getByText(/REC —/).waitFor();

  await pageA.waitForTimeout(3000);

  await pageB.getByRole('button', { name: /Arrêter l/i }).click();
  await pageA.getByText(/Déposé|Envoi en cours/).first().waitFor({ timeout: 15000 });

  const files = await callApi(pageA, 'GET', `${BASE}/api/files?query=appel-`);
  const file = (files as { files: { id: number; name: string; size: number }[] }).files[0];
  expect(file, 'fichier déposé').toBeTruthy();
  expect(file.size).toBeGreaterThan(1000);

  const dl = await pageA.request.get(`${BASE}/api/files/${file.id}/download`);
  const buf = Buffer.from(await dl.body());
  const dataDir = (globalThis as Record<string, unknown>).__dataDir as string;
  const out = path.join(dataDir, file.name);
  fs.writeFileSync(out, buf);

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  if (!ffmpeg) {
    console.warn('ffmpeg indisponible : décodage ignoré (taille vérifiée uniquement)');
    await ctxA.close();
    await ctxB.close();
    return;
  }
  const pcm = path.join(dataDir, 'pcm.raw');
  execFileSync('ffmpeg', ['-y', '-i', out, '-f', 's16le', '-ac', '1', '-ar', '8000', pcm], { stdio: 'ignore' });
  const raw = fs.readFileSync(pcm);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const durationSec = samples.length / 8000;
  expect(durationSec).toBeGreaterThan(2);
  expect(durationSec).toBeLessThan(8);

  const goertzel = (freq: number) => {
    const start = Math.floor(samples.length * 0.3);
    const len = Math.min(8000, samples.length - start);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    const w = (2 * Math.PI * freq) / 8000;
    const coeff = 2 * Math.cos(w);
    for (let i = 0; i < len; i++) {
      s0 = samples[start + i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / len;
  };
  const m440 = goertzel(440);
  const m880 = goertzel(880);
  console.log(`durée=${durationSec.toFixed(2)}s  magnitude440=${m440.toFixed(1)}  magnitude880=${m880.toFixed(1)}`);
  expect(m440).toBeGreaterThan(200);
  expect(m880).toBeGreaterThan(200);

  await ctxA.close();
  await ctxB.close();
});
