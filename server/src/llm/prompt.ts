import type { ChatMessage } from './providers.js';

export type PromptSourceKind = 'question' | 'history' | 'documents' | 'agenda' | 'instructions' | 'context';

export interface PromptSource {
  kind: PromptSourceKind;
  start: number;
  end: number;
}

export type PromptPart = string | { kind: PromptSourceKind; text: string };

export function sourcedMessage(role: ChatMessage['role'], parts: PromptPart[]): ChatMessage {
  const sources: PromptSource[] = [];
  let content = '';
  let offset = 0;
  for (const part of parts) {
    const text = typeof part === 'string' ? part : part.text;
    const kind = typeof part === 'string' ? 'instructions' : part.kind;
    const end = offset + Buffer.byteLength(text);
    // Les plages suivent les offsets UTF-8 renvoyés par LinGuard.
    if (end > offset) sources.push({ kind, start: offset, end });
    content += text;
    offset = end;
  }
  return { role, content, sources };
}
