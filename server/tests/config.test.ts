import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, loadConfigWithEnvFile, parseEnvFileContent } from '../src/config.js';
import { sttConfigured } from '../src/llm/stt.js';

test('parseEnvFileContent : commentaires, quotes, export, CRLF, commentaire en ligne', () => {
  const vars = parseEnvFileContent(
    [
      '# commentaire',
      'PORT=4000',
      'export JWT_SECRET="abc # pas un commentaire"',
      "ADMIN_NAMES='Alice, Bob'",
      'EMPTY=',
      'INLINE=ma valeur  # commentaire en ligne',
      '',
      'ligne-invalide',
    ].join('\r\n'),
  );
  assert.equal(vars.PORT, '4000');
  assert.equal(vars.JWT_SECRET, 'abc # pas un commentaire');
  assert.equal(vars.ADMIN_NAMES, 'Alice, Bob');
  assert.equal(vars.EMPTY, '');
  assert.equal(vars.INLINE, 'ma valeur');
  assert.equal('ligne-invalide' in vars, false);
  assert.equal('# commentaire' in vars, false);
});

test('loadConfigWithEnvFile : le fichier .env prime sur l environnement du processus (conteneur Docker à env ancien)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-env-'));
  try {
    const file = path.join(dir, 'app.env');
    fs.writeFileSync(
      file,
      [
        'JWT_SECRET=secret-du-fichier-123456',
        'STT_PROVIDER=openai-compatible',
        'STT_BASE_URL=https://api.scaleway.ai/v1',
        'STT_API_KEY=cle-du-fichier',
        'STT_MODEL=whisper-large-v3',
        'STT_LANGUAGE=fr',
        '',
      ].join('\n'),
    );
    // simule un conteneur créé avec un ancien .env (env_file lu à la création uniquement)
    const baseEnv = {
      JWT_SECRET: 'secret-processus-123456',
      STT_BASE_URL: 'https://api.openai.com/v1',
    } as NodeJS.ProcessEnv;
    const { config, envFile } = loadConfigWithEnvFile(file, baseEnv);
    assert.ok(envFile);
    assert.equal(envFile.path, file);
    assert.equal(config.JWT_SECRET, 'secret-du-fichier-123456');
    assert.equal(config.STT_BASE_URL, 'https://api.scaleway.ai/v1');
    assert.equal(config.STT_API_KEY, 'cle-du-fichier');
    assert.ok(sttConfigured(config));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfigWithEnvFile : sans fichier, retombe sur l environnement du processus', () => {
  const missing = path.join(os.tmpdir(), `inexistant-${Date.now()}.env`);
  const baseEnv = { JWT_SECRET: 'x'.repeat(20) } as NodeJS.ProcessEnv;
  const { config, envFile } = loadConfigWithEnvFile(missing, baseEnv);
  assert.equal(envFile, null);
  assert.equal(config.JWT_SECRET, 'x'.repeat(20));
});

test('sttConfigured : faux sans rien, vrai avec STT_BASE_URL seul ou STT_API_KEY seul', () => {
  const base = { JWT_SECRET: 'x'.repeat(20) } as NodeJS.ProcessEnv;
  assert.equal(sttConfigured(loadConfig(base)), false);
  assert.ok(sttConfigured(loadConfig({ ...base, STT_BASE_URL: 'https://api.scaleway.ai/v1' })));
  assert.ok(sttConfigured(loadConfig({ ...base, STT_API_KEY: 'k' })));
});
