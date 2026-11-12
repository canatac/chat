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
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}

export function isAdminUser(cfg: Config, name: string): boolean {
  const admins = cfg.ADMIN_NAMES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(name.toLowerCase());
}
