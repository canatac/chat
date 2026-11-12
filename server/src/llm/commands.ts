import type { ContextRow } from '../db.js';

export type CommandName = 'resume' | 'solve' | 'ask' | 'help';

export interface Command {
  name: CommandName;
  arg: string;
}

export const COMMAND_HELP = [
  'Commandes disponibles :',
  '• /resume [n] — compte-rendu des n derniers messages (50 par défaut)',
  '• /solve <problème> — pistes de solution pour un problème soulevé dans la chatroom',
  '• /ask <question> — question à l\u2019assistant (contexte de la chatroom + documents déposés)',
  '• /aide — afficher cette aide',
  'Les commandes /ask et /solve fouillent aussi les documents déposés dans l\u2019espace documentaire (RAG).',
].join('\n');

export function parseCommand(content: string): Command | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const name = (head ?? '').toLowerCase();
  if (name === 'resume') return { name: 'resume', arg };
  if (name === 'solve') return { name: 'solve', arg };
  if (name === 'ask' || name === 'question') return { name: 'ask', arg };
  return { name: 'help', arg: '' };
}

export function buildSystemPrompt(): string {
  return "Tu es l'assistant d'une chatroom d'équipe. Tu réponds en français, de manière concise et structurée (puces et titres courts quand c'est utile). Tu t'appuies sur la conversation et, quand elle est fournie, sur les documents de référence ; tu n'inventes pas de faits et tu cites le document concerné quand tu t'en sers.";
}

export function formatContext(rows: ContextRow[]): string {
  return rows
    .map((r) => {
      const time = new Date(r.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return `${time} ${r.name} : ${r.content}`;
    })
    .join('\n');
}

export function buildUserPrompt(cmd: Command, context: string, docs = ''): string {
  const ctx = docs ? `${docs}\n\nConversation récente :\n${context}` : context;
  switch (cmd.name) {
    case 'resume': {
      const n = cmd.arg ? Number.parseInt(cmd.arg, 10) : Number.NaN;
      const count = Number.isFinite(n) && n > 0 ? n : 50;
      return `Voici les ${count} derniers messages de la chatroom, du plus ancien au plus récent :\n\n${ctx}\n\nRédige un compte-rendu structuré de cette conversation : thèmes abordés, décisions prises, actions à suivre (avec responsable si mentionné), questions ouvertes. Si ce n'est pas une réunion, résume simplement les points importants.`;
    }
    case 'solve':
      return `Contexte de la chatroom et documents :\n\n${ctx}\n\nProblème soulevé : ${cmd.arg || '(non précisé)'}\n\nPropose 2 à 4 pistes de solution concrètes, ordonnées par pertinence. Pour chaque piste : actions à mener, avantage, risque principal, prochaine étape immédiate. Cite les documents utilisés quand c'est pertinent.`;
    case 'ask':
      return `Contexte (chatroom + documents) :\n\n${ctx}\n\nQuestion : ${cmd.arg || '(non précisée)'}\n\nRéponds à la question en t'appuyant d'abord sur les documents de référence fournis quand ils sont pertinents, puis sur la conversation. Indique entre parenthèses le nom du document utilisé.`;
    case 'help':
      return '';
  }
}
