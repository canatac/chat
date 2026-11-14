import { createServer } from './app.js';
import { loadConfigWithEnvFile } from './config.js';
import { llmConfigured } from './llm/index.js';
import { sttConfigured, toSttConfig } from './llm/stt.js';

const { config, envFile } = loadConfigWithEnvFile();
if (envFile) {
  console.log(
    `[config] ${Object.keys(envFile.vars).length} variables chargées depuis ${envFile.path} (le fichier .env prime sur l'environnement du conteneur)`,
  );
} else {
  console.log("[config] aucun fichier .env trouvé : variables d'environnement du processus uniquement");
}
if (config.JWT_SECRET === 'dev-secret-change-me') {
  console.warn('ATTENTION : JWT_SECRET par défaut utilisé, définir JWT_SECRET dans le .env en production');
}
const stt = toSttConfig(config);
console.log(
  `[config] LLM : ${
    llmConfigured(config)
      ? `configuré (${config.LLM_PROVIDER}, modèle ${config.LLM_MODEL ?? '?'})`
      : 'NON configuré (LLM_MODEL vide)'
  }`,
);
console.log(
  `[config] STT : ${
    sttConfigured(config)
      ? `configuré (${stt.provider}, modèle ${stt.model}, baseUrl=${stt.baseUrl ? 'définie' : 'par défaut'}, apiKey=${stt.apiKey ? 'définie' : 'absente'})`
      : 'NON configuré — définir STT_BASE_URL et/ou STT_API_KEY dans le .env, puis `docker compose restart chat`'
  }`,
);

const ctx = createServer(config, config.DATA_DIR);
ctx.server.listen(config.PORT, () => {
  console.log(`Chat démarré sur http://localhost:${config.PORT}`);
});
