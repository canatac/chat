import fs from 'node:fs';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATA_DIR: z.string().default('./data'),
  JWT_SECRET: z.string().min(8).default('dev-secret-change-me'),
  ADMIN_NAMES: z.string().default(''),
  LLM_PROVIDER: z.string().default('openai-compatible'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
  LLM_MAX_TOKENS: z.coerce.number().int().min(16).max(16384).default(1024),
  LLM_CONTEXT_MESSAGES: z.coerce.number().int().min(1).max(500).default(50),
  LLM_INPUT_PRICE_PER_1M: z.coerce.number().min(0).optional(),
  LLM_OUTPUT_PRICE_PER_1M: z.coerce.number().min(0).optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(25),
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  RAG_CHUNK_SIZE: z.coerce.number().int().min(200).max(4000).default(1200),
  STT_PROVIDER: z.string().default('openai'),
  STT_BASE_URL: z.string().optional(),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default('whisper-1'),
  STT_LANGUAGE: z.string().optional(),
  RECORDING_MAX_MB: z.coerce.number().int().min(1).max(2000).default(200),
  STT_COST_PER_AUDIO_MIN: z.coerce.number().min(0).optional(),
  STT_MAX_FILE_MB: z.coerce.number().min(1).max(5000).default(24),
  STT_CHUNK_MINUTES: z.coerce.number().int().min(1).max(180).default(10),
  TURN_URLS: z.string().default(''),
  TURN_USERNAME: z.string().default(''),
  TURN_CREDENTIAL: z.string().default(''),
  LINK_FETCH_ALLOWED_DOMAINS: z.string().default(''),
  MAX_LINK_FETCH_MB: z.coerce.number().int().min(1).max(5000).default(500),
  LINK_FETCH_ALLOW_PRIVATE: z.string().default('0'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Parse un fichier .env (format dotenv minimal) : lignes `CLE=valeur`, commentaires `#`,
 * préfixe `export ` accepté, valeurs entre quotes simples/doubles protégées (le `#` y est conservé),
 * commentaire en ligne ` # ...` retiré pour les valeurs non quotées, CRLF géré.
 */
export function parseEnvFileContent(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    const m = line.match(ENV_LINE);
    if (!m) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Cherche un fichier .env : chemin explicite, ou `ENV_FILE`, ou `/app/.env` (conteneur Docker),
 * ou `.env` (lancement local). Retourne null si aucun fichier lisible.
 */
export function loadEnvFile(filePath?: string): { path: string; vars: Record<string, string> } | null {
  const candidates = (filePath ? [filePath] : [process.env.ENV_FILE, '/app/.env', '.env'].filter(Boolean)) as string[];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { path: candidate, vars: parseEnvFileContent(fs.readFileSync(candidate, 'utf8')) };
      }
    } catch {
      // candidat illisible : on essaie le suivant
    }
  }
  return null;
}

/**
 * Charge la config en lisant un fichier .env au démarrage. Les variables du fichier **priment**
 * sur l'environnement du processus : dans Docker, `env_file` n'est relu que lors d'une
 * recréation du conteneur, donc un simple `docker compose restart chat` après édition du .env
 * suffit à appliquer la nouvelle config (le .env est monté en lecture seule dans le conteneur).
 */
export function loadConfigWithEnvFile(
  filePath?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { config: Config; envFile: { path: string; vars: Record<string, string> } | null } {
  const envFile = loadEnvFile(filePath);
  const env = { ...baseEnv, ...(envFile?.vars ?? {}) };
  return { config: loadConfig(env), envFile };
}

export function isAdminUser(cfg: Config, name: string): boolean {
  const admins = cfg.ADMIN_NAMES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(name.toLowerCase());
}
