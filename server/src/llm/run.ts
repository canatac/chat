import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { askLLM, llmConfigured } from './index.js';
import { buildSystemPrompt, buildUserPrompt, formatContext, parseCommand, COMMAND_HELP } from './commands.js';
import { buildDocsSection, retrieveRelevantChunks } from './rag.js';
import { handleLinkCommand, maybeAutoLink } from './link.js';
import { costUsd, type Usage } from './pricing.js';
import type { ChatMessage } from './providers.js';

export interface CommandDeps {
  db: DB;
  config: Config;
  userId: number;
  postBot: (content: string) => void;
}

export async function handleCommand(
  deps: CommandDeps,
  msg: { id: number; content: string },
): Promise<void> {
  const cmd = parseCommand(msg.content);
  if (!cmd) return;
  if (cmd.name === 'lien') {
    void handleLinkCommand(deps, msg, cmd.arg);
    return;
  }
  if (!cmd && (await maybeAutoLink(deps, msg))) return;
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
  let docs = '';
  if (cmd.name === 'ask' || cmd.name === 'solve') {
    const query = cmd.name === 'solve' ? `${cmd.arg}\n${context.slice(-800)}` : cmd.arg;
    docs = buildDocsSection(retrieveRelevantChunks(deps.db, query, deps.config.RAG_TOP_K));
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(cmd, context, docs) },
  ];
  const baseUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const record = (usage: Usage, error: string | null) => {
    deps.db.insertUsage({
      userId: deps.userId,
      messageId: msg.id,
      command: cmd.name,
      provider: deps.config.LLM_PROVIDER,
      model: deps.config.LLM_MODEL ?? '',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      costUsd: costUsd(usage, deps.config.LLM_MODEL ?? '', deps.config),
      error,
    });
  };
  try {
    const { text, usage } = await askLLM(deps.config, messages, { timeoutMs: 90000 });
    record(usage, null);
    deps.postBot(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(baseUsage, message);
    deps.postBot(`Erreur lors de l'appel au LLM : ${message}`);
  }
}
