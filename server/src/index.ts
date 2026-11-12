import { createServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
if (config.JWT_SECRET === 'dev-secret-change-me') {
  console.warn('ATTENTION : JWT_SECRET par défaut utilisé, définir JWT_SECRET dans le .env en production');
}

const ctx = createServer(config, config.DATA_DIR);
ctx.server.listen(config.PORT, () => {
  console.log(`Chat démarré sur http://localhost:${config.PORT}`);
});
