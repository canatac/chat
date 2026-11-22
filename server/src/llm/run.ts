import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { askLLM, llmConfigured } from './index.js';
import { buildDocumentUserMessage, buildSystemPrompt, buildUserMessage, formatContext, parseCommand, supportsDocuments, COMMAND_HELP } from './commands.js';
import { buildDocsSection, retrieveRelevantChunks } from './rag.js';
import { handleLinkCommand, maybeAutoLink } from './link.js';
import { costUsd, type Usage } from './pricing.js';
import type { ChatMessage } from './providers.js';
import { DOCUMENT_LIMITS, DocumentError } from '../documents/limits.js';
import { SecurityBlocked } from '../security/ai-guard.js';

export interface CommandDeps {
  db: DB;
  config: Config;
  uploadsDir: string;
  userId: number;
  postBot: (content: string) => void;
  onResponseActivity?: (active: boolean) => void;
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
  deps.onResponseActivity?.(true);
  try {
    const attached = deps.db.listFilesByMessage(msg.id);
    if (attached.length && supportsDocuments(cmd)) {
      const documents: string[] = [];
      let chars = 0;
      for (const file of attached) {
        await deps.config.documents?.waitReady(deps.db, file.id);
        const current = deps.db.getFileById(file.id);
        if (!current) throw new DocumentError(404, 'Le document sélectionné a été supprimé.');
        if (current.document_status !== 'ready') throw new DocumentError(422, current.document_error ?? 'Le document doit être extrait avant l’envoi à l’IA. Réessayer son analyse.');
        const text = deps.db.documentText(file.id);
        if (!text) throw new DocumentError(422, 'Le texte du document est indisponible. Réessayer son analyse.');
        const document = `--- ${current.name} ---\n${text}`;
        chars += document.length;
        if (chars > DOCUMENT_LIMITS.textChars) throw new DocumentError(413, 'Les documents sélectionnés dépassent 200 000 caractères. Réduire la sélection ou scinder les fichiers.');
        documents.push(document);
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt() },
        buildDocumentUserMessage(cmd, documents.join('\n\n')),
      ];
      const { text, usage } = await askLLM(deps.config, messages, { timeoutMs: 90000, userId: deps.userId });
      record(usage, null);
      deps.postBot(text);
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
      buildUserMessage(cmd, context, docs),
    ];
    const { text, usage } = await askLLM(deps.config, messages, { timeoutMs: 90000, userId: deps.userId });
    record(usage, null);
    deps.postBot(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(baseUsage, message);
    if (err instanceof DocumentError) {
      deps.postBot(`Extraction du document — ${err.issue.title}\n\n${message}\n\nAction : ${err.issue.action}\n\nLe contrôle LinGuard n’a pas pu être effectué. Aucun contenu n’a été envoyé au fournisseur IA pour cette demande.`);
    } else if (err instanceof SecurityBlocked) {
      deps.postBot(`Contrôle LinGuard — envoi à l’IA interrompu\n\n${message}`);
    } else deps.postBot(`Erreur lors de l'appel au LLM : ${message}`);
  } finally {
    deps.onResponseActivity?.(false);
  }
}
