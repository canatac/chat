import express from 'express';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { canEnterMeeting, mountAgenda } from './agenda.js';
import type { MeetingRow } from './agenda-store.js';
import { hashPassword } from './auth.js';
import type { Config } from './config.js';
import { DB, type CallRow, type FileEventListRow, type FileListRow, type FileRow, type FolderRow, type MentionNotificationRow, type MessageRow, type UserRow } from './db.js';
import { MoveConflicts, moveDecision, planDocumentMove } from './document-moves.js';
import { deriveDocument, HttpError, type DeriveKind } from './llm/derive.js';
import { handleCommand } from './llm/run.js';
import { chunkText, extractText } from './llm/rag.js';
import { pricesFor } from './llm/pricing.js';
import { isAudioMime, sttConfigured, transcribeFile } from './llm/stt.js';
import { mentionHints, mentionRecipients, positiveId, resolveMentions, type Mention } from './mentions.js';
import type { MessageReceipt } from './message-receipts.js';
import { mountRoomAdmin, parseRoomId, publicAccount } from './room-admin.js';
import { LEGACY_ROOM_ID, RoomDirectory, type Account } from './rooms.js';
import { AIGuard, type AnalyzerFactory } from './security/ai-guard.js';
import { mountSecurity } from './security/routes.js';

export interface PublicUser {
  id: number;
  name: string;
  isBot: boolean;
}

export interface PublicFile {
  id: number;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  updatedAt: string | null;
  callId: number | null;
  folderId: number | null;
}

export interface PublicFolder {
  id: number;
  name: string;
  parentId: number | null;
  createdAt: string;
  updatedAt: string | null;
  createdBy: PublicUser;
}

export interface PublicFileEvent {
  id: number;
  fileId: number | null;
  folderId: number | null;
  action: string;
  detail: string;
  createdAt: string;
  user: PublicUser;
}

export interface SerializedMessage {
  id: number;
  content: string;
  createdAt: string;
  user: PublicUser;
  files: PublicFile[];
  mentions: Mention[];
}

export function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, name: u.display_name ?? u.name, isBot: u.is_bot === 1 };
}

export function toPublicFile(f: FileRow): PublicFile {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    createdAt: new Date(f.created_at).toISOString(),
    updatedAt: f.updated_at ? new Date(f.updated_at).toISOString() : null,
    callId: f.call_id,
    folderId: f.folder_id ?? null,
  };
}

export function serializeMessage(db: DB, row: MessageRow): SerializedMessage {
  const user = db.getUserById(row.user_id) as UserRow;
  return {
    id: row.id,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    user: toPublicUser(user),
    files: db.listFilesByMessage(row.id).map(toPublicFile),
    mentions: JSON.parse(row.mentions) as Mention[],
  };
}

function messagePreview(content: string): string {
  const text = Array.from(content.replace(/\s+/g, ' ').trim());
  return text.length > 180 ? text.slice(0, 179).join('') + '…' : text.join('');
}

function publicNotification(row: MentionNotificationRow) {
  return {
    id: row.id,
    messageId: row.message_id,
    kind: row.kind,
    senderName: row.sender_name,
    preview: messagePreview(row.content),
    createdAt: new Date(row.created_at).toISOString(),
    readAt: row.read_at === null ? null : new Date(row.read_at).toISOString(),
  };
}

export interface CallRecording {
  id: string;
  startedBy: PublicUser;
  startedAt: number;
}

export interface CallInfo {
  id: number;
  title: string;
  meetingId: number | null;
  startedBy: PublicUser;
  participants: PublicUser[];
  active: boolean;
  recording: CallRecording | null;
}

export interface ServerContext {
  config: Config;
  db: DB;
  broadcast: (payload: unknown) => void;
  server: http.Server;
  onlineUserIds: () => number[];
  close: () => Promise<void>;
}

function createRoomRuntime(config: Config, dataDir: string, db: DB, roomId: number, directory: RoomDirectory, analyzer?: AnalyzerFactory) {
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  db.agenda.endInterruptedCalls();

  const app = express.Router();
  const clients = new Set<WebSocket>();

  const online = new Map<number, Set<WebSocket>>();
  const guard = new AIGuard(db.security, notifyUser, analyzer, (userId) => {
    const account = directory.getAccount(userId);
    return Boolean(account && directory.accessRoom(account, roomId));
  });
  config = { ...config, reviewAI: (messages, userId) => guard.protect(messages, userId) };
  mountSecurity(app, db.security, guard, () => broadcast({ type: 'securityPolicyChanged' }), (userId) => notifyUser(userId, { type: 'securityMaskingChanged' }));
  const typing = new Map<WebSocket, { user: PublicUser; timer: NodeJS.Timeout }>();
  let assistantRequests = 0;

  function conversationActivity() {
    const people = new Map([...typing.values()].map(({ user }) => [user.id, user]));
    return { type: 'conversationActivity', typing: [...people.values()], assistantResponding: assistantRequests > 0 };
  }

  function setTyping(ws: WebSocket, user: PublicUser, active: boolean): void {
    const current = typing.get(ws);
    if (current) clearTimeout(current.timer);
    if (active) {
      const timer = setTimeout(() => setTyping(ws, user, false), 5500);
      timer.unref();
      typing.set(ws, { user, timer });
    } else {
      typing.delete(ws);
    }
    if (Boolean(current) !== active) broadcast(conversationActivity());
  }

  function stopTyping(ws: WebSocket): void {
    const current = typing.get(ws);
    if (current) setTyping(ws, current.user, false);
  }

  function assistantActivity(active: boolean): void {
    const wasResponding = assistantRequests > 0;
    assistantRequests += active ? 1 : -1;
    if (wasResponding !== (assistantRequests > 0)) broadcast(conversationActivity());
  }

  function onlineUserIds(): number[] {
    return [...online.keys()];
  }

  let activeCall: { row: CallRow; participants: Set<number>; recording: { id: string; startedBy: number; startedAt: number } | null } | null = null;

  function serializeCall(): CallInfo | null {
    if (!activeCall) return null;
    const startedBy = db.getUserById(activeCall.row.started_by) as UserRow;
    return {
      id: activeCall.row.id,
      title: activeCall.row.title,
      meetingId: activeCall.row.meeting_id,
      startedBy: toPublicUser(startedBy),
      participants: [...activeCall.participants].map((id) => toPublicUser(db.getUserById(id) as UserRow)),
      active: true,
      recording: activeCall.recording
        ? {
            id: activeCall.recording.id,
            startedBy: toPublicUser(db.getUserById(activeCall.recording.startedBy) as UserRow),
            startedAt: activeCall.recording.startedAt,
          }
        : null,
    };
  }

  function broadcastCall(): void {
    broadcast({ type: 'call', call: serializeCall() });
  }

  function broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  function notifyUser(userId: number, payload: unknown): void {
    const sockets = online.get(userId);
    if (!sockets) return;
    const data = JSON.stringify(payload);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }

  function notifyMeetingInvite(meeting: MeetingRow, userId: number): void {
    if (activeCall?.row.meeting_id === meeting.id) {
      notifyUser(userId, { type: 'agendaInvitation', meeting: { id: meeting.id, title: meeting.title } });
    }
  }

  function activateContact(invitationId: number, account: Account): void {
    const meetings = db.transaction(() => {
      if (account.removed_at !== null) {
        db.agenda.discardContactInvitation(invitationId);
        return [];
      }
      db.ensureActor(account);
      return db.agenda.acceptContact(invitationId, account.id, activeCall?.row.meeting_id ?? null);
    });
    for (const meeting of meetings) notifyMeetingInvite(meeting, account.id);
    if (meetings.length) broadcast({ type: 'agendaChanged' });
  }

  function dropCallParticipant(userId: number, removed = false): void {
    if (!activeCall?.participants.delete(userId)) return;
    if (removed) notifyUser(userId, { type: 'callParticipantRemoved', callId: activeCall.row.id });
    if (activeCall.recording?.startedBy === userId) activeCall.recording = null;
    if (activeCall.participants.size === 0) {
      db.endCall(activeCall.row.id);
      activeCall = null;
    }
    broadcastCall();
  }

  function broadcastPresence(): void {
    broadcast({ type: 'presence', online: onlineUserIds() });
  }

  function postBotMessage(text: string): void {
    const botRow = db.insertMessage(db.getBot().id, text);
    broadcast({ type: 'message', message: serializeMessage(db, botRow) });
  }

  function toPublicFolder(r: FolderRow): PublicFolder {
    return {
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      createdBy: toPublicUser(db.getUserById(r.created_by) as UserRow),
    };
  }

  function toPublicEvent(r: FileEventListRow): PublicFileEvent {
    return {
      id: r.id,
      fileId: r.file_id,
      folderId: r.folder_id,
      action: r.action,
      detail: r.detail,
      createdAt: new Date(r.created_at).toISOString(),
      user: toPublicUser(db.getUserById(r.user_id) as UserRow),
    };
  }

  function logDocEvent(userId: number, e: { fileId?: number | null; folderId?: number | null; action: string; detail?: string }): void {
    db.insertFileEvent({ fileId: e.fileId ?? null, folderId: e.folderId ?? null, action: e.action, detail: e.detail, userId });
  }

  function docsChanged(): void {
    broadcast({ type: 'docsChanged' });
  }

  function saveUserMessage(userId: number, content: string, hints: Mention[] = [], useMentions = true) {
    const members = useMentions && content.includes('@') ? directory.listMembers(roomId) : [];
    const mentions = members.length ? resolveMentions(content, members, hints) : [];
    const row = db.insertMessage(userId, content, mentions);
    const notifications = db.createMentionNotifications(row.id, mentionRecipients(userId, mentions, members));
    return { row, notifications };
  }

  function publishUserMessage({ row, notifications }: ReturnType<typeof saveUserMessage>): SerializedMessage {
    const msg = serializeMessage(db, row);
    broadcast({ type: 'message', message: msg });
    if (notifications.length) {
      const preview = messagePreview(msg.content);
      for (const { id, kind, recipientId } of notifications) {
        notifyUser(recipientId, {
          type: 'notificationsChanged',
          notification: { id, kind, messageId: msg.id, senderName: msg.user.name, preview, createdAt: msg.createdAt, readAt: null },
        });
      }
    }
    return msg;
  }

  function postMessage(userId: number, content: string, hints: Mention[] = []): SerializedMessage {
    const publication = db.transaction(() => saveUserMessage(userId, content, hints));
    const msg = publishUserMessage(publication);
    if (content.trimStart().startsWith('/')) {
      void handleCommand(
        {
          db,
          config,
          uploadsDir,
          userId,
          postBot: postBotMessage,
          onResponseActivity: assistantActivity,
        },
        { id: msg.id, content: msg.content },
      );
    }
    return msg;
  }


  async function transcribeAndStore(
    fileRow: FileRow,
    displayName: string,
    mime: string,
    userId: number,
  ): Promise<FileRow | null> {
    if (!sttConfigured(config)) return null;
    try {
      const bigFile = fileRow.size > (config.STT_MAX_FILE_MB ?? 24) * 1048576;
      if (bigFile) {
        postBotMessage(
          `⚙️ « ${displayName} » (${(fileRow.size / 1048576).toFixed(0)} Mo) : compression + découpage en segments avant transcription — cela peut prendre plusieurs minutes.`,
        );
      }
      const result = await transcribeFile(
        config,
        path.join(uploadsDir, fileRow.path),
        displayName,
        mime,
        bigFile
          ? (p) => {
              if (p.phase === 'prepare') postBotMessage(`⚙️ « ${displayName} » : compression 16 kHz mono en cours…`);
              else if (p.phase === 'segment') postBotMessage(`🎙️ « ${displayName} » : segment ${p.segment}/${p.totalSegments} transcrit…`);
            }
          : undefined,
      );
      const text = result.text;
      if (!text) return null;
      const costPerMin = config.STT_COST_PER_AUDIO_MIN ?? 0;
      const sttCost = result.durationSeconds ? (result.durationSeconds / 60) * costPerMin : 0;
      const date = new Date().toLocaleString('fr-FR');
      const tName = `🎙️ Transcription — ${displayName} (${date}).txt`;
      const tFname = `${Date.now()}-tr-${Math.random().toString(36).slice(2, 8)}.txt`;
      fs.writeFileSync(path.join(uploadsDir, tFname), text);
      const transcriptRow = db.insertFile(
        db.getBot().id,
        null,
        tName,
        'text/plain',
        Buffer.byteLength(text),
        tFname,
        fileRow.call_id,
        null,
        'transcript',
      );
      chunkText(text, config.RAG_CHUNK_SIZE).forEach((c, i) => db.insertChunk(transcriptRow.id, i, c));
      db.insertUsage({
        userId,
        messageId: fileRow.message_id,
        command: 'stt',
        provider: config.STT_PROVIDER,
        model: config.STT_MODEL,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: sttCost,
        error: null,
      });
      logDocEvent(userId, { fileId: transcriptRow.id, folderId: fileRow.folder_id ?? null, action: 'file_transcribed', detail: `« ${displayName} » transcrit (${text.length} caractères)` });
      docsChanged();
      return transcriptRow;
    } catch (err) {
      db.insertUsage({
        userId,
        messageId: fileRow.message_id,
        command: 'stt',
        provider: config.STT_PROVIDER,
        model: config.STT_MODEL,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      // remonter l'erreur réelle dans la chat (sinon on ne voit que le silence) — le fichier reste réessayable (🎙️)
      try {
        const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        postBotMessage(
          `⚠️ Transcription échouée pour « ${displayName} » : ${errMsg} — le fichier reste disponible, réessaie avec le bouton 🎙️ dans l'espace documentaire.`,
        );
      } catch {
        // ignore
      }
      return null;
    }
  }

  const adminOnly: express.RequestHandler = (req, res, next) => {
    if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
      res.status(403).json({ error: 'Réservé aux administrateurs du salon' });
      return;
    }
    next();
  };

  app.get('/api/users', (req, res) => {
    const members = new Map(directory.listMembers(roomId).map((member) => [member.id, member]));
    const onlineIds = new Set(onlineUserIds());
    const viewer = res.locals.account as Account;
    for (const id of [...onlineIds, viewer.id]) {
      if (members.has(id)) continue;
      const visitor = directory.getAccount(id);
      if (visitor && directory.role(visitor) === 'superadmin') members.set(id, visitor);
    }
    res.json({
      users: [...members.values()].map((member) => ({
        ...publicAccount(directory, member),
        online: onlineIds.has(member.id),
        mentionable: member.room_id === roomId && member.removed_at === null,
      })),
    });
  });

  mountAgenda(app, {
    db, config, directory, roomId,
    activeMeeting: () => activeCall?.row.meeting_id ?? null,
    activeParticipants: (meetingId) => activeCall?.row.meeting_id === meetingId ? [...activeCall.participants] : [],
    removeFromCall: (meetingId, userId) => {
      if (activeCall?.row.meeting_id === meetingId) dropCallParticipant(userId, true);
    },
    invited: notifyMeetingInvite,
    changed: () => broadcast({ type: 'agendaChanged' }),
  });

  app.get('/api/calls/active', (req, res) => {
    res.json({ call: serializeCall() });
  });

  app.get('/api/rtc-config', (req, res) => {
    const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    if (config.TURN_URLS) {
      iceServers.push({
        urls: config.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
        username: config.TURN_USERNAME || undefined,
        credential: config.TURN_CREDENTIAL || undefined,
      });
    }
    res.json({ iceServers });
  });

  const callTitleSchema = z.object({ title: z.string().trim().max(120).optional(), meetingId: positiveId.optional() });
  const callJoinSchema = z.object({ callId: positiveId.optional(), meetingId: positiveId.optional() });
  const callActionSchema = callJoinSchema.pick({ callId: true });
  const isCurrentCall = (body: unknown) => {
    const parsed = callActionSchema.safeParse(body ?? {});
    return parsed.success && (parsed.data.callId === undefined || parsed.data.callId === activeCall?.row.id);
  };
  const canUseCall = (row: CallRow, req: express.Request) => row.meeting_id === null || canEnterMeeting(db, row.meeting_id, req.user?.id ?? -1, req.user?.role);

  app.post('/api/calls/start', (req, res) => {
    if (activeCall) {
      res.status(409).json({ error: 'Un appel est déjà en cours', call: serializeCall() });
      return;
    }
    const parsed = callTitleSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Appel invalide.' }); return; }
    const { meetingId, title } = parsed.data;
    const meeting = meetingId === undefined ? undefined : db.agenda.get(meetingId);
    if (meetingId !== undefined && !meeting) { res.status(404).json({ error: 'Réunion introuvable' }); return; }
    if (meeting?.cancelled_at != null) { res.status(409).json({ error: 'Cette réunion a été annulée.' }); return; }
    const userId = req.user?.id ?? -1;
    if (meeting && !canEnterMeeting(db, meeting.id, userId, req.user?.role)) {
      res.status(403).json({ error: 'Cet appel est réservé aux participants invités.' }); return;
    }
    const row = db.startCall(userId, meeting?.title ?? title ?? '', meeting?.id ?? null);
    activeCall = { row, participants: new Set([userId]), recording: null };
    broadcastCall();
    for (const accountId of online.keys()) {
      if (accountId === userId) continue;
      const account = directory.getAccount(accountId);
      if (!account || (meeting && !canEnterMeeting(db, meeting.id, accountId, directory.role(account)))) continue;
      notifyUser(accountId, { type: 'callStarted', call: serializeCall() });
    }
    res.status(201).json({ call: serializeCall() });
  });

  app.post('/api/calls/join', (req, res) => {
    if (!activeCall) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    const parsed = callJoinSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Appel invalide.' }); return; }
    const { callId, meetingId } = parsed.data;
    if ((callId !== undefined && activeCall.row.id !== callId) || (meetingId !== undefined && activeCall.row.meeting_id !== meetingId)) {
      res.status(409).json({ error: 'L’appel actif a changé.' }); return;
    }
    if (!canUseCall(activeCall.row, req)) { res.status(403).json({ error: 'Cet appel est réservé aux participants invités.' }); return; }
    const userId = req.user?.id ?? -1;
    if (activeCall.row.meeting_id !== null) db.agenda.attend(activeCall.row.id, userId);
    activeCall.participants.add(userId);
    broadcastCall();
    res.json({ call: serializeCall() });
  });

  app.post('/api/calls/leave', (req, res) => {
    if (!activeCall) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    if (!isCurrentCall(req.body)) { res.status(409).json({ error: 'L’appel actif a changé.' }); return; }
    dropCallParticipant(req.user?.id ?? -1);
    res.json({ call: serializeCall() });
  });

  app.post('/api/calls/end', (req, res) => {
    if (!activeCall) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    if (!isCurrentCall(req.body)) { res.status(409).json({ error: 'L’appel actif a changé.' }); return; }
    if (!canUseCall(activeCall.row, req)) { res.status(403).json({ error: 'Cet appel est réservé aux participants invités.' }); return; }
    db.endCall(activeCall.row.id);
    activeCall = null;
    broadcastCall();
    res.json({ ok: true });
  });

  const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().optional(),
  });

  app.get('/api/messages', (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Paramètres invalides' });
      return;
    }
    const rows = db.listMessages(parsed.data.limit, parsed.data.before);
    res.json({ messages: rows.reverse().map((r) => serializeMessage(db, r)) });
  });

  const receiptQuery = z.object({
    ids: z.string().max(1699).regex(/^\d+(,\d+)*$/)
      .transform((value) => value.split(',').map(Number)).pipe(z.array(positiveId).max(100)).optional(),
  });

  app.get('/api/messages/activity', (req, res) => {
    const parsed = receiptQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Identifiants de messages invalides' });
      return;
    }
    const userId = req.user!.id;
    res.json({ unread: db.receipts.unread(userId), receipts: db.receipts.summaries(parsed.data.ids ?? [], userId) });
  });

  const receiptInput = z.object({ receipts: z.array(z.object({ id: positiveId, read: z.boolean() }).strict()).min(1).max(100) }).strict();

  app.patch('/api/messages/activity', (req, res) => {
    const parsed = receiptInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Accusés de réception invalides' });
      return;
    }
    const userId = req.user!.id;
    const { changedIds, readChanged } = db.transaction(() => db.receipts.acknowledge(userId, parsed.data.receipts));
    const receiptsByAuthor = new Map<number, MessageReceipt[]>();
    for (const receipt of db.receipts.summaries(changedIds)) {
      if (!online.has(receipt.authorId)) continue;
      const receipts = receiptsByAuthor.get(receipt.authorId) ?? [];
      receipts.push(receipt);
      receiptsByAuthor.set(receipt.authorId, receipts);
    }
    for (const [authorId, receipts] of receiptsByAuthor) notifyUser(authorId, { type: 'messageReceipts', receipts });
    if (readChanged) notifyUser(userId, { type: 'unreadMessagesChanged' });
    res.status(204).end();
  });

  app.get('/api/messages/around/:id', (req, res) => {
    const id = positiveId.safeParse(Number(req.params.id));
    const row = id.success ? db.getMessageById(id.data) : undefined;
    if (!row) {
      res.status(404).json({ error: 'Message introuvable' });
      return;
    }
    const side = 25;
    const older = db.listMessages(side + 1, row.id);
    const newer = db.listMessagesAfter(side + 1, row.id);
    const messages = [...older.slice(0, side).reverse(), row, ...newer.slice(0, side)];
    res.json({ messages: messages.map((item) => serializeMessage(db, item)), hasMore: older.length > side, hasNewer: newer.length > side });
  });

  const postSchema = z.object({
    content: z.string().trim().min(1).max(4000),
    mentions: mentionHints.optional(),
  });

  app.post('/api/messages', (req, res) => {
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'content requis (1-4000 caractères)' });
      return;
    }
    res.status(201).json({ message: postMessage(req.user?.id ?? -1, parsed.data.content, parsed.data.mentions) });
  });

  const notificationsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.coerce.number().pipe(positiveId).optional(),
  });

  app.get('/api/notifications', (req, res) => {
    const parsed = notificationsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Paramètres invalides' });
      return;
    }
    const userId = req.user?.id ?? -1;
    const { limit, before } = parsed.data;
    const rows = db.listMentionNotifications(userId, limit + 1, before);
    const page = rows.slice(0, limit);
    res.json({ notifications: page.map(publicNotification), unread: db.unreadMentions(userId), nextBefore: rows.length > limit ? page[page.length - 1].id : null });
  });

  app.get('/api/notifications/:id', (req, res) => {
    const id = positiveId.safeParse(Number(req.params.id));
    const row = id.success ? db.getMentionNotification(req.user?.id ?? -1, id.data) : undefined;
    if (!row) {
      res.status(404).json({ error: 'Notification introuvable' });
      return;
    }
    res.json({ notification: publicNotification(row) });
  });

  const notificationRead = z.union([z.object({ id: positiveId }).strict(), z.object({ through: positiveId }).strict()]);
  app.patch('/api/notifications/read', (req, res) => {
    const parsed = notificationRead.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Notification ou borne de lecture requise' });
      return;
    }
    const userId = req.user?.id ?? -1;
    if ('id' in parsed.data && !db.getMentionNotification(userId, parsed.data.id)) {
      res.status(404).json({ error: 'Notification introuvable' });
      return;
    }
    db.markMentionsRead(userId, parsed.data);
    notifyUser(userId, { type: 'notificationsChanged' });
    res.json({ unread: db.unreadMentions(userId) });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
        cb(null, `${Date.now()}-${randomUUID()}-${safe}`);
      },
    }),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  });

  function discardUploadedFile(file?: Express.Multer.File): void {
    if (!file) return;
    try {
      fs.rmSync(file.path, { force: true });
    } catch {
      // Le fichier peut avoir été retiré entre-temps.
    }
  }

  function uploadedName(file: Express.Multer.File): string {
    return Buffer.from(file.originalname, 'latin1').toString('utf8');
  }

  async function indexUploadedDocument(file: FileRow): Promise<void> {
    try {
      if (isAudioMime(file.mime, file.name)) {
        await transcribeAndStore(file, file.name, file.mime, file.user_id);
        return;
      }
      const text = await extractText(path.join(uploadsDir, file.path), file.mime, file.name);
      if (text.trim()) chunkText(text, config.RAG_CHUNK_SIZE).forEach((chunk, i) => db.insertChunk(file.id, i, chunk));
    } catch {
      // L’extraction est facultative après l’enregistrement du fichier.
    }
  }

  app.post('/api/files', upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Champ "file" requis' });
      return;
    }
    const uploaded = req.file;
    let registered = false;
    try {
      const displayName = uploadedName(uploaded);
      const post = req.body.post !== 'false';
      const text = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 4000) : '';
      let hints: Mention[] = [];
      if (post && text && typeof req.body.mentions === 'string') {
        try {
          const parsed = mentionHints.safeParse(JSON.parse(req.body.mentions));
          if (parsed.success) hints = parsed.data;
        } catch {
          // Le texte du message reste utilisable sans indication de sélection.
        }
      }
      const userId = req.user?.id ?? -1;
      let folderId: number | null = null;
      if (req.body.folderId !== undefined && req.body.folderId !== '' && req.body.folderId !== 'root') {
        folderId = Number(req.body.folderId);
        if (!Number.isInteger(folderId) || !db.getFolderById(folderId)) {
          discardUploadedFile(uploaded);
          res.status(400).json({ error: 'folderId invalide' });
          return;
        }
      }
      const { fileRow, publication } = db.transaction(() => {
        const publication = post ? saveUserMessage(userId, text || `📎 ${displayName}`, hints, Boolean(text)) : null;
        const fileRow = db.insertFile(userId, publication?.row.id ?? null, displayName, uploaded.mimetype || 'application/octet-stream', uploaded.size, uploaded.filename, null, folderId);
        logDocEvent(userId, { fileId: fileRow.id, folderId, action: 'file_created', detail: `« ${displayName} » déposé (${(uploaded.size / 1048576).toFixed(1)} Mo)` });
        return { fileRow, publication };
      });
      registered = true;
      docsChanged();
      void indexUploadedDocument(fileRow);
      const message = publication ? publishUserMessage(publication) : null;
      res.status(201).json({ file: toPublicFile(fileRow), message });
    } catch (err) {
      if (!registered) discardUploadedFile(uploaded);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erreur upload' });
    }
  });

  const fileIdField = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive().safe());
  const groupFilesSchema = z.object({ name: z.string().trim().min(1).max(120), targetId: fileIdField, sourceId: fileIdField.optional() });

  app.post('/api/files/group', upload.single('file'), (req, res) => {
    const uploaded = req.file;
    const parsed = groupFilesSchema.safeParse(req.body);
    if (!parsed.success || Boolean(parsed.data.sourceId) === Boolean(uploaded)) {
      discardUploadedFile(uploaded);
      res.status(400).json({ error: 'Indiquez le nom du dossier et les deux fichiers à regrouper.' });
      return;
    }
    const { name, sourceId, targetId } = parsed.data;
    const userId = req.user?.id ?? -1;
    let result: { folder: FolderRow; imported: FileRow | null };
    try {
      result = db.transaction(() => {
        if (sourceId === targetId) throw new HttpError(400, 'Choisissez deux fichiers différents.');
        const target = db.getFileById(targetId);
        const source = sourceId === undefined ? undefined : db.getFileById(sourceId);
        if (!target || (sourceId !== undefined && !source)) throw new HttpError(404, 'Un des fichiers est introuvable.');
        const incomingName = uploaded ? uploadedName(uploaded) : '';
        const otherName = source?.name ?? incomingName;
        if (otherName.toLowerCase() === target.name.toLowerCase()) throw new HttpError(409, 'Les deux fichiers portent le même nom. Renommez-en un pour les regrouper.');
        if (db.folderExistsWithSiblingName(target.folder_id, name)) throw new HttpError(409, 'Un dossier porte déjà ce nom à cet endroit');

        const folder = db.createFolder(userId, name, target.folder_id);
        logDocEvent(userId, { folderId: folder.id, action: 'folder_created', detail: `Dossier « ${name} » créé par regroupement` });
        for (const file of source ? [target, source] : [target]) {
          db.moveFile(file.id, folder.id);
          logDocEvent(userId, { fileId: file.id, folderId: folder.id, action: 'file_moved', detail: `déplacé vers le dossier « ${name} »` });
        }
        const imported = uploaded
          ? db.insertFile(userId, null, incomingName, uploaded.mimetype || 'application/octet-stream', uploaded.size, uploaded.filename, null, folder.id)
          : null;
        if (imported) logDocEvent(userId, { fileId: imported.id, folderId: folder.id, action: 'file_created', detail: `« ${imported.name} » déposé` });
        return { folder, imported };
      });
    } catch (error) {
      discardUploadedFile(uploaded);
      res.status(error instanceof HttpError ? error.statusCode : 500).json({ error: error instanceof HttpError ? error.message : 'Impossible de regrouper les fichiers.' });
      return;
    }
    docsChanged();
    if (result.imported) void indexUploadedDocument(result.imported);
    res.status(201).json({ folder: toPublicFolder(result.folder) });
  });

  const timestamp = z.string().regex(/^-?\d+$/).transform(Number).pipe(z.number().int().safe());
  const byteThreshold = z.string().trim().min(1).pipe(z.coerce.number().min(0).max(Number.MAX_SAFE_INTEGER));
  const filesQuerySchema = z.object({
    select: z.literal('all').optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().optional(),
    query: z.string().max(100).optional(),
    folder: z.string().optional(), // absent = tout ; 'root' = racine ; sinon id de dossier
    sort: z.enum(['name', 'date', 'size']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    name: z.string().trim().max(100).optional(),
    activityFrom: timestamp.optional(),
    activityBefore: timestamp.optional(),
    minBytes: byteThreshold.optional(),
    maxBytes: byteThreshold.optional(),
  }).refine(({ activityFrom, activityBefore, minBytes, maxBytes }) => (
    (activityFrom === undefined || activityBefore === undefined || activityFrom < activityBefore)
    && (minBytes === undefined || maxBytes === undefined || minBytes <= maxBytes)
  ));

  app.get('/api/files', (req, res) => {
    const parsed = filesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Paramètres invalides' });
      return;
    }
    const { limit, before, query, folder, select, ...options } = parsed.data;
    let folderId: number | null | undefined;
    if (folder !== undefined) {
      if (folder === 'root') folderId = null;
      else {
        folderId = Number(folder);
        if (!Number.isInteger(folderId) || folderId <= 0) {
          res.status(400).json({ error: "folder invalide (id ou 'root')" });
          return;
        }
      }
    }
    if (select === 'all') {
      const filtered = Boolean(query || options.name) ||
        [options.activityFrom, options.activityBefore, options.minBytes, options.maxBytes].some((value) => value !== undefined);
      res.json({
        fileIds: db.listFileIds(query, folderId, options),
        folderIds: folderId !== undefined && !filtered ? db.listFolderIds(folderId) : [],
      });
      return;
    }
    const rows: FileListRow[] = db.listFiles(options.sort ? limit + 1 : limit, before, query, folderId, options);
    const page = rows.slice(0, limit);
    res.json({
      files: page.map((f) => ({
        ...toPublicFile(f),
        messageId: f.message_id,
        user: { id: f.user_id, name: f.user_name },
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    });
  });

  function deleteDocumentRows(userId: number, files: FileRow[], folders: FolderRow[]): void {
    const folderIds = new Set(folders.map(({ id }) => id));
    for (const file of files) {
      const source = file.folder_id !== null && folderIds.has(file.folder_id)
        ? 'suppression du dossier' : `${(file.size / 1048576).toFixed(1)} Mo`;
      logDocEvent(userId, { fileId: file.id, folderId: file.folder_id, action: 'file_deleted', detail: `fichier « ${file.name} » supprimé (${source})` });
      db.deleteFile(file.id);
    }
    for (let index = folders.length - 1; index >= 0; index--) {
      const folder = folders[index];
      logDocEvent(userId, { folderId: folder.id, action: 'folder_deleted', detail: `dossier « ${folder.name} » supprimé` });
      db.deleteFolder(folder.id);
    }
  }

  function removeDeletedBytes(files: FileRow[]): void {
    for (const file of files) {
      try {
        fs.rmSync(path.join(uploadsDir, file.path), { force: true });
      } catch (error) {
        console.error('Nettoyage du fichier supprimé impossible', roomId, file.id, (error as NodeJS.ErrnoException).code);
      }
    }
  }

  const documentId = z.number().int().positive().safe();
  const selectionFields = { fileIds: z.array(documentId), folderIds: z.array(documentId) };
  const documentBatchSchema = z.discriminatedUnion('action', [
    z.object({ ...selectionFields, action: z.literal('move'), destination: documentId.nullable(), decisions: z.array(moveDecision).default([]) }),
    z.object({ ...selectionFields, action: z.literal('delete') }),
  ]).refine(({ fileIds, folderIds }) => fileIds.length > 0 || folderIds.length > 0);

  app.post('/api/documents/batch', (req, res) => {
    const parsed = documentBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Sélection de documents invalide.' });
      return;
    }
    const operation = parsed.data;
    const fileIds = [...new Set(operation.fileIds)];
    const folderIds = [...new Set(operation.folderIds)];
    const userId = req.user?.id ?? -1;
    try {
      const result = db.transaction(() => {
        const files = db.getFilesByIds(fileIds);
        const folders = db.listFolderTree(folderIds);
        const treeIds = new Set(folders.map(({ id }) => id));
        if (operation.action === 'delete') {
          const combined = new Map(files.map((file) => [file.id, file]));
          for (const file of db.listFilesInFolders([...treeIds])) combined.set(file.id, file);
          const deleted = [...combined.values()];
          deleteDocumentRows(userId, deleted, folders);
          return { files: deleted.length, folders: folders.length, deleted, skipped: 0 };
        }

        const { destination } = operation;
        if (files.length !== fileIds.length || folderIds.some((id) => !treeIds.has(id))) {
          throw new HttpError(409, 'La sélection a changé. Sélectionnez les éléments de nouveau.');
        }
        const target = destination === null ? null : db.getFolderById(destination);
        if (destination !== null && !target) throw new HttpError(404, 'Dossier cible introuvable');
        if (destination !== null && treeIds.has(destination)) {
          throw new HttpError(409, 'Choisissez une destination en dehors des dossiers sélectionnés.');
        }

        const roots = folders.filter(({ parent_id }) => parent_id !== destination && (parent_id === null || !treeIds.has(parent_id)));
        const looseFiles = files.filter(({ folder_id }) => folder_id !== destination && (folder_id === null || !treeIds.has(folder_id)));
        const plan = planDocumentMove(db, [
          ...roots.map((folder) => ({ ...folder, kind: 'folder' as const })),
          ...looseFiles.map((file) => ({ ...file, kind: 'file' as const })),
        ], destination, { file: new Set(fileIds), folder: new Set(folderIds) }, operation.decisions);
        const replacedFolders = db.listFolderTree(plan.replaced.folder);
        const deleted = [...db.getFilesByIds(plan.replaced.file), ...db.listFilesInFolders(replacedFolders.map(({ id }) => id))];
        deleteDocumentRows(userId, deleted, replacedFolders);

        const detail = target ? `déplacé vers le dossier « ${target.name} »` : 'déplacé vers la racine';
        let movedFiles = 0;
        let movedFolders = 0;
        for (const { kind, id, name, sourceName } of plan.moves) {
          const renamed = name !== sourceName;
          const renameDetail = `« ${sourceName} » renommé en « ${name} »`;
          if (kind === 'folder') {
            db.updateFolder(id, { parentId: destination, name: renamed ? name : undefined });
            if (renamed) logDocEvent(userId, { folderId: id, action: 'folder_renamed', detail: renameDetail });
            logDocEvent(userId, { folderId: id, action: 'folder_moved', detail });
            movedFolders++;
          } else {
            if (renamed) {
              db.renameFile(id, name);
              logDocEvent(userId, { fileId: id, folderId: destination, action: 'file_renamed', detail: renameDetail });
            }
            db.moveFile(id, destination);
            logDocEvent(userId, { fileId: id, folderId: destination, action: 'file_moved', detail });
            movedFiles++;
          }
        }
        return { files: movedFiles, folders: movedFolders, deleted, skipped: plan.skipped };
      });
      removeDeletedBytes(result.deleted);
      if (result.files || result.folders) docsChanged();
      res.json({ files: result.files, folders: result.folders, ...(result.skipped ? { skipped: result.skipped } : {}) });
    } catch (error) {
      if (error instanceof MoveConflicts) {
        res.status(409).json({ error: error.message, conflicts: error.conflicts });
        return;
      }
      res.status(error instanceof HttpError ? error.statusCode : 500)
        .json({ error: error instanceof HttpError ? error.message : 'Impossible de traiter la sélection.' });
    }
  });

  // ---------- explorateur de documents : dossiers ----------
  app.get('/api/folders', (req, res) => {
    res.json({ folders: db.listFolders().map((f) => toPublicFolder(f)) });
  });

  app.post('/api/folders', (req, res) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(120), parentId: z.number().int().nullable().optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'name requis (1-120 caractères), parentId optionnel (null = racine)' });
      return;
    }
    const parentId = parsed.data.parentId ?? null;
    if (parentId !== null && !db.getFolderById(parentId)) {
      res.status(404).json({ error: 'Dossier parent introuvable' });
      return;
    }
    if (db.folderExistsWithSiblingName(parentId, parsed.data.name)) {
      res.status(409).json({ error: 'Un dossier porte déjà ce nom à cet endroit' });
      return;
    }
    const userId = req.user?.id ?? -1;
    const folder = db.createFolder(userId, parsed.data.name, parentId);
    logDocEvent(userId, { folderId: folder.id, action: 'folder_created', detail: `Dossier « ${folder.name} » créé${parentId === null ? ' à la racine' : ''}` });
    docsChanged();
    res.status(201).json({ folder: toPublicFolder(folder) });
  });

  app.patch('/api/folders/:id', (req, res) => {
    const id = Number(req.params.id);
    const folder = db.getFolderById(id);
    if (!folder) {
      res.status(404).json({ error: 'Dossier introuvable' });
      return;
    }
    const parsed = z
      .object({ name: z.string().trim().min(1).max(120).optional(), parentId: z.number().int().nullable().optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success || (parsed.data.name === undefined && parsed.data.parentId === undefined)) {
      res.status(400).json({ error: 'name et/ou parentId requis' });
      return;
    }
    const { name, parentId } = parsed.data;
    if (parentId !== undefined && parentId !== null && !db.getFolderById(parentId)) {
      res.status(404).json({ error: 'Dossier parent introuvable' });
      return;
    }
    if (parentId !== undefined && parentId === id) {
      res.status(409).json({ error: 'Un dossier ne peut pas être son propre parent' });
      return;
    }
    if (parentId !== undefined && parentId !== null && db.isFolderDescendant(parentId, id)) {
      res.status(409).json({ error: 'Déplacement impossible : la cible est un sous-dossier de ce dossier' });
      return;
    }
    const newName = name ?? folder.name;
    const newParent = parentId === undefined ? folder.parent_id : parentId;
    if ((newParent !== folder.parent_id || newName.toLowerCase() !== folder.name.toLowerCase()) && db.folderExistsWithSiblingName(newParent, newName, id)) {
      res.status(409).json({ error: 'Un dossier porte déjà ce nom à cet endroit' });
      return;
    }
    const userId = req.user?.id ?? -1;
    const oldName = folder.name;
    const oldParent = folder.parent_id;
    db.updateFolder(id, { name, parentId });
    if (name !== undefined && name !== oldName) {
      logDocEvent(userId, { folderId: id, action: 'folder_renamed', detail: `« ${oldName} » renommé en « ${name} »` });
    }
    if (parentId !== undefined && parentId !== oldParent) {
      const target = parentId === null ? 'la racine' : `le dossier « ${db.getFolderById(parentId)?.name ?? `#${parentId}`} »`;
      logDocEvent(userId, { folderId: id, action: 'folder_moved', detail: `déplacé vers ${target}` });
    }
    docsChanged();
    res.json({ folder: toPublicFolder(db.getFolderById(id) as FolderRow) });
  });

  app.delete('/api/folders/:id', (req, res) => {
    const id = Number(req.params.id);
    const folder = db.getFolderById(id);
    if (!folder) {
      res.status(404).json({ error: 'Dossier introuvable' });
      return;
    }
    const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
    const tree = db.listFolderTree([id]);
    const subfolders = tree.length - 1;
    const filesToDelete = db.listFilesInFolders(tree.map((row) => row.id));
    const direct = db.folderCounts(id);
    if (!recursive && (subfolders > 0 || filesToDelete.length > 0)) {
      res.status(409).json({
        error: `Dossier non vide : ${subfolders} sous-dossier(s), ${filesToDelete.length} fichier(s) au total (dont ${direct.files} directement) — passer recursive=1 pour tout supprimer`,
        counts: { folders: subfolders, files: filesToDelete.length, directFolders: direct.folders, directFiles: direct.files },
      });
      return;
    }
    db.transaction(() => deleteDocumentRows(req.user?.id ?? -1, filesToDelete, tree));
    removeDeletedBytes(filesToDelete);
    docsChanged();
    res.json({ ok: true, deletedFolders: tree.length, deletedFiles: filesToDelete.length });
  });

  // ---------- explorateur de documents : fichiers ----------
  app.get('/api/files/:id', (req, res) => {
    const file = db.getFileById(Number(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'Fichier introuvable' });
      return;
    }
    const folderPath: PublicFolder[] = [];
    let cur: number | null = file.folder_id ?? null;
    const seen = new Set<number>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const f = db.getFolderById(cur);
      if (!f) break;
      folderPath.push(toPublicFolder(f));
      cur = f.parent_id;
    }
    res.json({
      file: {
        ...toPublicFile(file),
        messageId: file.message_id,
        user: toPublicUser(db.getUserById(file.user_id)!),
      },
      folderPath: folderPath.reverse(),
      history: db.listFileEvents({ fileId: file.id, limit: 200 }).map(toPublicEvent),
    });
  });

  app.patch('/api/files/:id', (req, res) => {
    const id = Number(req.params.id);
    const file = db.getFileById(id);
    if (!file) {
      res.status(404).json({ error: 'Fichier introuvable' });
      return;
    }
    const parsed = z
      .object({ name: z.string().trim().min(1).max(255).optional(), folderId: z.number().int().nullable().optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success || (parsed.data.name === undefined && parsed.data.folderId === undefined)) {
      res.status(400).json({ error: 'name et/ou folderId requis (folderId: null = racine)' });
      return;
    }
    const { name, folderId } = parsed.data;
    const newFolder = folderId === undefined ? (file.folder_id ?? null) : folderId;
    if (newFolder !== null && !db.getFolderById(newFolder)) {
      res.status(404).json({ error: 'Dossier cible introuvable' });
      return;
    }
    const newName = name ?? file.name;
    if (db.fileNameExistsInFolder(newFolder, newName, id)) {
      res.status(409).json({ error: 'Un fichier porte déjà ce nom dans ce dossier' });
      return;
    }
    const userId = req.user?.id ?? -1;
    const oldName = file.name;
    const oldFolder = file.folder_id ?? null;
    if (name !== undefined && name !== oldName) {
      db.renameFile(id, name);
      logDocEvent(userId, { fileId: id, folderId: newFolder, action: 'file_renamed', detail: `« ${oldName} » renommé en « ${name} »` });
    }
    if (folderId !== undefined && folderId !== oldFolder) {
      db.moveFile(id, folderId);
      const target = folderId === null ? 'la racine' : `le dossier « ${db.getFolderById(folderId)?.name ?? `#${folderId}`} »`;
      logDocEvent(userId, { fileId: id, folderId, action: 'file_moved', detail: `déplacé vers ${target}` });
    }
    docsChanged();
    res.json({
      file: {
        ...toPublicFile(db.getFileById(id) as FileRow),
        messageId: file.message_id,
        user: toPublicUser(db.getUserById(file.user_id)!),
      },
    });
  });

  app.delete('/api/files/:id', (req, res) => {
    const id = Number(req.params.id);
    const file = db.getFileById(id);
    if (!file) {
      res.status(404).json({ error: 'Fichier introuvable' });
      return;
    }
    db.transaction(() => deleteDocumentRows(req.user?.id ?? -1, [file], []));
    removeDeletedBytes([file]);
    docsChanged();
    res.json({ ok: true });
  });

  app.get('/api/events', (req, res) => {
    const fileIdRaw = req.query.fileId;
    const folderIdRaw = req.query.folderId;
    const limitRaw = Number(req.query.limit ?? 100);
    const fileId = fileIdRaw !== undefined ? Number(fileIdRaw) : undefined;
    const folderId = folderIdRaw !== undefined ? Number(folderIdRaw) : undefined;
    if ((fileIdRaw !== undefined && !Number.isInteger(fileId)) || (folderIdRaw !== undefined && !Number.isInteger(folderId))) {
      res.status(400).json({ error: 'fileId/folderId doivent être des entiers' });
      return;
    }
    const events = db.listFileEvents({
      fileId: fileId !== undefined && Number.isInteger(fileId) ? fileId : undefined,
      folderId: folderId !== undefined && Number.isInteger(folderId) ? folderId : undefined,
      limit: Math.min(Math.max(limitRaw || 100, 1), 500),
    });
    res.json({ events: events.map(toPublicEvent) });
  });

  app.get('/api/files/:id/download', (req, res) => {
    const file = db.getFileById(Number(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'Fichier introuvable' });
      return;
    }
    res.download(path.join(uploadsDir, file.path), file.name);
  });

  const recordUpload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
      },
    }),
    limits: { fileSize: config.RECORDING_MAX_MB * 1024 * 1024 },
  });

  app.post('/api/calls/:id/recording/start', (req, res) => {
    if (!activeCall || activeCall.row.id !== Number(req.params.id)) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    if (!canUseCall(activeCall.row, req)) { res.status(403).json({ error: 'Cet appel est réservé aux participants invités.' }); return; }
    if (activeCall.recording) {
      res.status(409).json({ error: 'Enregistrement déjà en cours', call: serializeCall() });
      return;
    }
    activeCall.recording = { id: randomUUID(), startedBy: req.user?.id ?? -1, startedAt: Date.now() };
    db.insertRecording({ id: activeCall.recording.id, callId: activeCall.row.id, userId: activeCall.recording.startedBy, fileId: null });
    broadcastCall();
    res.json({ call: serializeCall(), recordingId: activeCall.recording.id });
  });

  app.post('/api/calls/:id/recording/stop', (req, res) => {
    if (!activeCall || activeCall.row.id !== Number(req.params.id)) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    if (!canUseCall(activeCall.row, req)) { res.status(403).json({ error: 'Cet appel est réservé aux participants invités.' }); return; }
    const body = z.object({ recordingId: z.string().optional() }).safeParse(req.body ?? {});
    if (body.success && body.data.recordingId && activeCall.recording && body.data.recordingId !== activeCall.recording.id) {
      res.status(409).json({ error: 'recordingId ne correspond pas à la prise en cours', call: serializeCall() });
      return;
    }
    activeCall.recording = null;
    broadcastCall();
    res.json({ call: serializeCall() });
  });

  app.post('/api/calls/:id/recording', recordUpload.single('file'), (req, res) => {
    const call = db.getCallById(Number(req.params.id));
    if (!call) {
      discardUploadedFile(req.file);
      res.status(404).json({ error: 'Appel introuvable' });
      return;
    }
    const userId = req.user?.id ?? -1;
    const recordingId = typeof req.body.recordingId === 'string' && req.body.recordingId ? req.body.recordingId : null;
    const recording = recordingId ? db.getRecording(recordingId) : undefined;
    const ownsTake = recording?.call_id === call.id && recording.user_id === userId;
    if (!canUseCall(call, req) && !ownsTake) {
      discardUploadedFile(req.file);
      res.status(403).json({ error: 'Cet appel est réservé aux participants invités.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Champ "file" requis' });
      return;
    }
    if (recordingId) {
      if (!recording || recording.call_id !== call.id) {
        discardUploadedFile(req.file);
        res.status(400).json({ error: 'recordingId inconnu' });
        return;
      }
      if (!ownsTake) {
        discardUploadedFile(req.file);
        res.status(403).json({ error: "Seul l'auteur de la prise peut déposer son fichier" });
        return;
      }
      if (recording.file_id) {
        discardUploadedFile(req.file);
        const file = db.getFileById(recording.file_id);
        const messageRow = file?.message_id ? db.getMessageById(file.message_id) : undefined;
        res.status(200).json({
          file: file ? toPublicFile(file) : null,
          message: messageRow ? serializeMessage(db, messageRow) : null,
          duplicate: true,
          transcriptPending: false,
        });
        return;
      }
    }
    const uploaded = req.file;
    const displayName = Buffer.from(uploaded.originalname, 'latin1').toString('utf8');
    const label = call.title ? ` « ${call.title} »` : '';
    const messageRow = db.insertMessage(req.user?.id ?? -1, `🎙️ Enregistrement de l'appel${label}`);
    const fileRow = db.insertFile(
      req.user?.id ?? -1,
      messageRow.id,
      displayName,
      uploaded.mimetype || 'audio/webm',
      uploaded.size,
      uploaded.filename,
      call.id,
      null,
      'recording',
    );
    if (recordingId) db.setRecordingFile(recordingId, fileRow.id);
    logDocEvent(req.user?.id ?? -1, { fileId: fileRow.id, folderId: fileRow.folder_id ?? null, action: 'file_created', detail: `enregistrement d'appel « ${displayName} » déposé` });
    docsChanged();
    const message = serializeMessage(db, messageRow);
    broadcast({ type: 'message', message });

    void transcribeAndStore(fileRow, displayName, uploaded.mimetype, req.user?.id ?? -1);

    res.status(201).json({ file: toPublicFile(fileRow), message, transcriptPending: sttConfigured(config), recordingId });
  });

  const deriveSchema = z.object({ kind: z.enum(['resume', 'cr']) });

  app.post('/api/files/:id/derive', async (req, res) => {
    const file = db.getFileById(Number(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'Fichier introuvable' });
      return;
    }
    const parsed = deriveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'kind requis : "resume" ou "cr"' });
      return;
    }
    try {
      const kind: DeriveKind = parsed.data.kind;
      const row = await deriveDocument({ db, config, userId: req.user?.id ?? -1, uploadsDir }, file, kind);
      logDocEvent(req.user?.id ?? -1, { fileId: row.id, folderId: row.folder_id ?? null, action: 'file_derived', detail: `${kind === 'cr' ? 'compte-rendu' : 'résumé'} généré depuis « ${file.name} »` });
      docsChanged();
      res.status(201).json({ file: { ...toPublicFile(row), messageId: row.message_id, user: toPublicUser(db.getUserById(row.user_id)!) } });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erreur dérivation' });
    }
  });

  app.post('/api/files/:id/transcribe', async (req, res) => {
    const file = db.getFileById(Number(req.params.id));
    if (!file) {
      res.status(404).json({ error: 'Fichier introuvable' });
      return;
    }
    if (!isAudioMime(file.mime, file.name)) {
      res.status(400).json({ error: "Ce fichier n'est pas un fichier audio" });
      return;
    }
    if (!sttConfigured(config)) {
      res.status(503).json({ error: 'STT non configuré : définir STT_BASE_URL et/ou STT_API_KEY dans le .env' });
      return;
    }
    const row = await transcribeAndStore(file, file.name, file.mime, req.user?.id ?? -1);
    if (!row) {
      res.status(502).json({ error: 'Transcription vide ou en erreur (voir llm_usage)' });
      return;
    }
    res.status(201).json({
      file: {
        ...toPublicFile(row),
        messageId: row.message_id,
        user: toPublicUser(db.getUserById(row.user_id)!),
      },
    });
  });

  app.get('/api/admin/stats', adminOnly, (req, res) => {
    const overview = db.statsOverview();
    const model = config.LLM_MODEL ?? '';
    res.json({
      users: { total: directory.listMembers(roomId).length, online: onlineUserIds().length },
      messages: overview.messages,
      files: { count: overview.files, bytes: overview.fileBytes },
      calls: { total: overview.calls, active: activeCall ? activeCall.participants.size : 0 },
      llm: {
        calls: overview.llmCalls,
        errors: overview.llmErrors,
        promptTokens: overview.promptTokens,
        completionTokens: overview.completionTokens,
        totalTokens: overview.totalTokens,
        costUsd: overview.costUsd,
        priceKnown: pricesFor(model, config).known,
        byCommand: db.usageByCommand(),
        byModel: db.usageByModel(),
        byDay: db.usageByDay(),
      },
    });
  });

  function connect(ws: WebSocket, user: UserRow, authorized: () => boolean): void {
    clients.add(ws);
    let sockets = online.get(user.id);
    if (!sockets) {
      sockets = new Set();
      online.set(user.id, sockets);
    }
    sockets.add(ws);
    const person = toPublicUser(user);
    ws.send(JSON.stringify({ type: 'hello', user: person }));
    ws.send(JSON.stringify(conversationActivity()));
    broadcastPresence();

    const inboundSchema = z.object({
      type: z.string(),
      content: z.string().optional(),
      before: z.number().optional(),
      limit: z.number().optional(),
      to: z.number().optional(),
      data: z.unknown().optional(),
      callId: z.number().optional(),
      active: z.boolean().optional(),
    });

    ws.on('message', (data) => {
      if (!authorized()) {
        ws.close(4003, 'Accès au salon révoqué');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = inboundSchema.safeParse(parsed);
      if (!msg.success) return;
      if (msg.data.type === 'message' && typeof msg.data.content === 'string') {
        const content = msg.data.content.trim();
        if (!content || content.length > 4000) return;
        stopTyping(ws);
        postMessage(user.id, content);
      } else if (msg.data.type === 'typing' && msg.data.active !== undefined) {
        setTyping(ws, person, msg.data.active);
      } else if (msg.data.type === 'history') {
        const limit = Math.min(Math.max(Math.trunc(msg.data.limit ?? 50), 1), 200);
        const rows = db.listMessages(limit, typeof msg.data.before === 'number' ? msg.data.before : undefined);
        ws.send(JSON.stringify({ type: 'history', messages: rows.reverse().map((r) => serializeMessage(db, r)) }));
      } else if (msg.data.type === 'signal' && typeof msg.data.to === 'number') {
        if (
          (msg.data.callId !== undefined || activeCall?.row.meeting_id != null) &&
          (!activeCall ||
            activeCall.row.id !== msg.data.callId ||
            !activeCall.participants.has(user.id) ||
            !activeCall.participants.has(msg.data.to))
        ) {
          return;
        }
        const target = online.get(msg.data.to);
        if (target) {
          const payload = JSON.stringify({ type: 'signal', from: user.id, callId: msg.data.callId ?? null, data: msg.data.data });
          for (const c of target) {
            if (c.readyState === WebSocket.OPEN) c.send(payload);
          }
        }
      }
    });
    const onClose = () => {
      clients.delete(ws);
      stopTyping(ws);
      const set = online.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          online.delete(user.id);
          broadcastPresence();
          if (activeCall?.recording && activeCall.recording.startedBy === user.id) {
            activeCall.recording = null;
            broadcastCall();
          }
        }
      }
    };
    ws.on('close', onClose);
    ws.on('error', onClose);
  }

  function disconnect(ws: WebSocket, reason: string): void {
    clients.delete(ws);
    stopTyping(ws);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(4003, reason);
    }
  }

  function removeMember(accountId: number): void {
    guard.cancelUser(accountId);
    const sockets = online.get(accountId);
    online.delete(accountId);
    if (sockets) {
      for (const ws of sockets) disconnect(ws, 'Accès au salon révoqué');
      broadcastPresence();
    }
    db.agenda.removeContact(accountId);
    dropCallParticipant(accountId);
    broadcast({ type: 'membersChanged' });
    broadcast({ type: 'agendaChanged' });
  }

  function archive(): void {
    guard.cancelAll();
    if (activeCall) {
      db.endCall(activeCall.row.id);
      activeCall = null;
    }
    online.clear();
    for (const ws of clients) disconnect(ws, 'Ce salon est archivé');
  }

  const pendingContacts = db.agenda.linkedInvitationIds();
  for (const { id, accountId } of directory.acceptedInvitations(roomId, pendingContacts)) {
    const account = directory.getAccount(accountId);
    if (account) activateContact(id, account);
  }
  return { app, db, broadcast, connect, onlineUserIds, activateContact, removeMember, archive, guard };
}

export function createServer(config: Config, dataDir: string, analyzer?: AnalyzerFactory): ServerContext {
  const db = new DB(dataDir);
  const directory = new RoomDirectory(dataDir, db, config.ADMIN_NAMES, config.SUPERADMIN_NAMES);
  directory.bootstrapSuperadmin(hashPassword, config.SUPERADMIN_PASSWORD ?? '');
  const runtimes = new Map<number, ReturnType<typeof createRoomRuntime>>();

  // Le salon historique conserve ses chemins et ses identifiants.
  function runtimeFor(roomId: number) {
    const existing = runtimes.get(roomId);
    if (existing) return existing;
    const roomDir = roomId === LEGACY_ROOM_ID ? dataDir : path.join(dataDir, 'rooms', String(roomId));
    const roomDb = roomId === LEGACY_ROOM_ID ? db : new DB(roomDir, -1);
    const runtime = createRoomRuntime(config, roomDir, roomDb, roomId, directory, analyzer);
    runtimes.set(roomId, runtime);
    return runtime;
  }

  const app = express();
  app.post('/api/documents/batch', express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '64kb' }));
  const { auth, resolveAccount } = mountRoomAdmin(app, config, directory, {
    memberChanged(roomId, account, invitationId) {
      const runtime = runtimes.get(roomId);
      if (!runtime) return;
      if (invitationId === undefined) runtime.db.ensureActor(account);
      else runtime.activateContact(invitationId, account);
      runtime.broadcast({ type: 'membersChanged' });
    },
    invitationsChanged(roomId) {
      runtimes.get(roomId)?.broadcast({ type: 'agendaChanged' });
    },
    memberRemoved(roomId, accountId) {
      runtimeFor(roomId).removeMember(accountId);
    },
    roomArchived(roomId) {
      runtimes.get(roomId)?.archive();
    },
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }
    auth(req, res, () => {
      const account = res.locals.account as Account;
      const selector = req.get('X-Chat-Room');
      const room = directory.accessRoom(account, selector === undefined ? undefined : parseRoomId(selector));
      if (!room) {
        res.status(403).json({ error: 'Accès au salon indisponible' });
        return;
      }
      const runtime = runtimeFor(room.id);
      runtime.db.ensureActor(account);
      runtime.app(req, res, next);
    });
  });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/ws') {
        next();
        return;
      }
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    const account = resolveAccount(token);
    if (!account) {
      ws.close(4001, 'Session invalide ou révoquée');
      return;
    }
    const selector = url.searchParams.get('room');
    const room = directory.accessRoom(account, selector === null ? undefined : parseRoomId(selector));
    if (!room) {
      ws.close(4003, 'Accès au salon indisponible');
      return;
    }
    const runtime = runtimeFor(room.id);
    runtime.connect(ws, runtime.db.ensureActor(account), () => {
      const current = resolveAccount(token);
      return Boolean(current && directory.accessRoom(current, room.id));
    });
  });

  runtimeFor(LEGACY_ROOM_ID);
  return {
    config,
    db,
    broadcast: (payload) => runtimeFor(LEGACY_ROOM_ID).broadcast(payload),
    server,
    onlineUserIds: () => runtimes.get(LEGACY_ROOM_ID)?.onlineUserIds() ?? [],
    close: async () => {
      await Promise.all([...runtimes.values()].map((runtime) => runtime.guard.close()));
      await new Promise<void>((resolve) => setImmediate(resolve));
      return new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => {
          for (const runtime of runtimes.values()) {
            if (runtime.db !== db) runtime.db.close();
          }
          db.close();
          directory.close();
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
