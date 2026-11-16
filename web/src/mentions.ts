import type { Mention } from './types';

const tokenBefore = /[\p{L}\p{M}\p{N}_@./+-]$/u;

export function mentionAt(draft: string, caret: number | null, mentions: Mention[]) {
  if (caret === null || caret < 1) return null;
  const start = draft.lastIndexOf('@', caret - 1);
  if (start < 0 || tokenBefore.test(draft.slice(0, start)) || mentions.some((mention) => mention.start === start)) return null;
  const query = draft.slice(start + 1, caret);
  return query.length <= 40 && !/[\r\n]/.test(query) ? { start, end: caret, query } : null;
}

export function mentionsAfterEdit(previous: string, next: string, mentions: Mention[]): Mention[] {
  if (!mentions.length || previous === next) return mentions;
  let prefix = 0;
  while (prefix < Math.min(previous.length, next.length) && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(previous.length, next.length) - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const delta = next.length - previous.length;
  return mentions.flatMap((mention) => {
    if (mention.end <= prefix) return [mention];
    if (mention.start >= previous.length - suffix) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  });
}

export function insertMentionTrigger(draft: string, start: number, end: number) {
  const prefix = draft.slice(0, start);
  const insertion = tokenBefore.test(prefix) ? ' @' : '@';
  return { text: prefix + insertion + draft.slice(end), caret: start + insertion.length };
}
