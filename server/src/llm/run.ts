import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { askLLM, llmConfigured } from './index.js';
import { buildSystemPrompt, buildUserPrompt, formatContext, parseCommand, COMMAND_HELP } from './commands.js';
import type { ChatMessage } from './providers.js';

export interface CommandDeps {
  db: DB;
  config: Config;
  postBot: (content: string) => void;
}

export async function handleCommand(
  deps: CommandDeps,
  msg: { id: number; content: string },
): Promise<void> {
  const cmd = parseCommand(msg.content);
  if (!cmd) return;
  if (cmd.name === 'help') {
    deps.postBot(COMMAND_HELP);
    return;
  }
  if (!llmConfigured(deps.config)) {
    deps.postBot('LLM non configuré côté serveur : définir LLM_PROVIDER, LLM_MODEL et LLM_API_KEY/LLM_BASE_URL dans le .env.');
    return;
  }
  const rows = deps.db.listMessagesJoined(deps.config.LLM_CONTEXT_MESSAGES, msg.id).reverse();
  const context = formatContext(rows);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(cmd, context) },
  ];
  try {
    const answer = await askLLM(deps.config, messages, { timeoutMs: 90000 });
    deps.postBot(answer);
  } catch (err) {
    deps.postBot(`Erreur lors de l'appel au LLM : ${err instanceof Error ? err.message : String(err)}`);
  }
}
