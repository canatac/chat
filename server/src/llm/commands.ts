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
  '• /ask <question> — question à l\u2019assistant, avec le contexte de la chatroom',
  '• /aide — afficher cette aide',
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
  return "Tu es l'assistant d'une chatroom d'équipe. Tu réponds en français, de manière concise et structurée (puces et titres courts quand c'est utile). Tu t'appuies sur la conversation fournie comme contexte et tu n'inventes pas de faits.";
}

export function formatContext(rows: ContextRow[]): string {
  return rows
    .map((r) => {
      const time = new Date(r.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return `${time} ${r.name} : ${r.content}`;
    })
    .join('\n');
}

export function buildUserPrompt(cmd: Command, context: string): string {
  switch (cmd.name) {
    case 'resume': {
      const n = cmd.arg ? Number.parseInt(cmd.arg, 10) : Number.NaN;
      const count = Number.isFinite(n) && n > 0 ? n : 50;
      return `Voici les ${count} derniers messages de la chatroom, du plus ancien au plus récent :\n\n${context}\n\nRédige un compte-rendu structuré de cette conversation : thèmes abordés, décisions prises, actions à suivre (avec responsable si mentionné), questions ouvertes. Si ce n'est pas une réunion, résume simplement les points importants.`;
    }
    case 'solve':
      return `Contexte de la chatroom :\n\n${context}\n\nProblème soulevé : ${cmd.arg || '(non précisé)'}\n\nPropose 2 à 4 pistes de solution concrètes, ordonnées par pertinence. Pour chaque piste : actions à mener, avantage, risque principal, prochaine étape immédiate.`;
    case 'ask':
      return `Contexte de la chatroom :\n\n${context}\n\nQuestion : ${cmd.arg || '(non précisée)'}\n\nRéponds à la question en t'appuyant sur le contexte ci-dessus quand c'est pertinent.`;
    case 'help':
      return '';
  }
}
