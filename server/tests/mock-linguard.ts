import type { AnalyzerFactory } from '../src/security/ai-guard.js';

export const cleanAnalyzer: AnalyzerFactory = () => ({
  health: async () => ({ status: 'ok', agent: 'linguard', version: 'test', api: 'v1' }),
  analyze: async (texts) => ({ texts: texts.map(() => []), model_errors: [] }),
});
