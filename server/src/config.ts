import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATA_DIR: z.string().default('./data'),
  JWT_SECRET: z.string().min(8).default('dev-secret-change-me'),
  LLM_PROVIDER: z.string().default('openai-compatible'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
  LLM_MAX_TOKENS: z.coerce.number().int().min(16).max(16384).default(1024),
  LLM_CONTEXT_MESSAGES: z.coerce.number().int().min(1).max(500).default(50),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
