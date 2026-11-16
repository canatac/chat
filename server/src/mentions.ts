import { z } from 'zod';

export const positiveId = z.number().int().positive().safe();
export const mentionHints = z.array(z.object({
  start: z.number().int().min(0).max(3999),
  end: z.number().int().min(1).max(4000),
  userId: positiveId.nullable(),
})).max(1334);

export type Mention = z.infer<typeof mentionHints>[number];
export type MentionKind = 'member' | 'room';

const aliasKey = (alias: string) => alias.normalize('NFC').toLocaleLowerCase('fr');
const tokenBefore = /[\p{L}\p{M}\p{N}_@./+-]$/u;
const tokenAfter = /^[\p{L}\p{M}\p{N}_@-]/u;
const candidateOffset = /https?:\/\/[^\s<>"«»`]+|```[\s\S]*?(?:```|$)|`[^`\n]*`|@/gi;
const quote = (alias: string) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveMentions(content: string, members: { id: number; alias: string }[], hints: Mention[]): Mention[] {
  const aliases = new Map<string, number[]>();
  const byId = new Map(members.map(({ id, alias }) => [id, aliasKey(alias)]));
  const spellings = new Set<string>();
  for (const { id, alias } of members) {
    if (!alias) continue;
    const key = aliasKey(alias);
    const matches = aliases.get(key) ?? [];
    matches.push(id);
    aliases.set(key, matches);
    spellings.add(alias.normalize('NFC'));
    spellings.add(alias.normalize('NFD'));
  }
  const ordered = [...spellings].sort((left, right) => right.length - left.length).map(quote);
  const matcher = ordered.length ? new RegExp('(?:' + ordered.join('|') + ')(?![\\p{L}\\p{M}\\p{N}_@-])', 'iyu') : null;
  const preferred = new Map(hints.map((hint) => [hint.start, hint]));
  const mentions: Mention[] = [];
  let consumed = 0;
  for (const match of content.matchAll(candidateOffset)) {
    const start = match.index;
    if (match[0] !== '@' || start < consumed || tokenBefore.test(content.slice(0, start))) continue;
    const hint = preferred.get(start);
    if (hint && hint.end > start + 1 && hint.end <= content.length && !tokenAfter.test(content.slice(hint.end)) &&
        aliasKey(content.slice(start + 1, hint.end)) === (hint.userId === null ? 'room' : byId.get(hint.userId))) {
      mentions.push(hint);
      consumed = hint.end;
      continue;
    }
    const roomEnd = start + 5;
    if (content.slice(start + 1, roomEnd).toLowerCase() === 'room' && !tokenAfter.test(content.slice(roomEnd))) {
      mentions.push({ start, end: roomEnd, userId: null });
      consumed = roomEnd;
      continue;
    }
    if (!matcher) continue;
    matcher.lastIndex = start + 1;
    const alias = matcher.exec(content);
    if (!alias) continue;
    consumed = matcher.lastIndex;
    const matches = aliases.get(aliasKey(alias[0]));
    if (matches?.length === 1) mentions.push({ start, end: consumed, userId: matches[0] });
  }
  return mentions;
}

export function mentionRecipients(senderId: number, mentions: Mention[], roomMembers: { id: number }[]): Map<number, MentionKind> {
  const recipients = new Map<number, MentionKind>();
  if (mentions.some(({ userId }) => userId === null)) {
    for (const { id } of roomMembers) if (id !== senderId) recipients.set(id, 'room');
  }
  for (const { userId } of mentions) {
    if (userId !== null && userId !== senderId) recipients.set(userId, 'member');
  }
  return recipients;
}
