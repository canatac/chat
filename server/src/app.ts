import express from 'express';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import { isAdminUser, type Config } from './config.js';
import { DB, type CallRow, type FileListRow, type FileRow, type MessageRow, type UserRow } from './db.js';
import { deriveDocument, HttpError, type DeriveKind } from './llm/derive.js';
import { handleCommand } from './llm/run.js';
import { chunkText, extractText } from './llm/rag.js';
import { pricesFor } from './llm/pricing.js';
import { isAudioMime, sttConfigured, transcribeFile } from './llm/stt.js';

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
  callId: number | null;
}

export interface SerializedMessage {
  id: number;
  content: string;
  createdAt: string;
  user: PublicUser;
  files: PublicFile[];
}

export function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, name: u.name, isBot: u.is_bot === 1 };
}

export function toPublicFile(f: FileRow): PublicFile {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    createdAt: new Date(f.created_at).toISOString(),
    callId: f.call_id,
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

export function createServer(config: Config, dataDir: string): ServerContext {
  const db = new DB(dataDir);
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const online = new Map<number, Set<WebSocket>>();
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

  function broadcastPresence(): void {
    broadcast({ type: 'presence', online: onlineUserIds() });
  }

  function postMessage(userId: number, content: string): SerializedMessage {
    const row = db.insertMessage(userId, content);
    const msg = serializeMessage(db, row);
    broadcast({ type: 'message', message: msg });
    if (content.trimStart().startsWith('/')) {
      void handleCommand(
        {
          db,
          config,
          userId,
          postBot: (text) => {
            const botRow = db.insertMessage(db.getBot().id, text);
            broadcast({ type: 'message', message: serializeMessage(db, botRow) });
          },
        },
        { id: row.id, content: row.content },
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
      const result = await transcribeFile(config, path.join(uploadsDir, fileRow.path), displayName, mime);
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
      return null;
    }
  }

  const auth: express.RequestHandler = (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      res.status(401).json({ error: 'Non authentifié' });
      return;
    }
    try {
      const payload = verifyToken(token, config.JWT_SECRET);
      req.user = { id: payload.sub, name: payload.name };
      next();
    } catch {
      res.status(401).json({ error: 'Token invalide' });
    }
  };

  const adminOnly: express.RequestHandler = (req, res, next) => {
    if (!req.user || !isAdminUser(config, req.user.name)) {
      res.status(403).json({ error: 'Réservé aux administrateurs (ADMIN_NAMES dans le .env)' });
      return;
    }
    next();
  };

  const credentialsSchema = z.object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(30)
      .regex(/^[\p{L}\p{N} _.-]+$/u, 'Nom invalide'),
    password: z.string().min(6).max(100),
  });

  app.post('/api/auth/register', (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Nom (2-30 caractères) et mot de passe (6 caractères minimum) requis' });
      return;
    }
    const { name, password } = parsed.data;
    if (db.getUserByName(name)) {
      res.status(409).json({ error: 'Ce nom est déjà pris' });
      return;
    }
    const user = db.createUser(name, hashPassword(password));
    res.status(201).json({ token: signToken(user, config.JWT_SECRET), user: toPublicUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Identifiants invalides' });
      return;
    }
    const user = db.getUserByName(parsed.data.name);
    if (!user || !user.pass_hash || !verifyPassword(parsed.data.password, user.pass_hash)) {
      res.status(401).json({ error: 'Nom ou mot de passe incorrect' });
      return;
    }
    res.json({ token: signToken(user, config.JWT_SECRET), user: toPublicUser(user) });
  });

  app.get('/api/me', auth, (req, res) => {
    const user = db.getUserById(req.user?.id ?? -1);
    if (!user) {
      res.status(404).json({ error: 'Utilisateur introuvable' });
      return;
    }
    res.json({ user: { ...toPublicUser(user), isAdmin: isAdminUser(config, user.name) } });
  });

  app.get('/api/users', auth, (req, res) => {
    const onlineIds = new Set(onlineUserIds());
    res.json({
      users: db.listUsers().map((u) => ({ ...toPublicUser(u), online: onlineIds.has(u.id) })),
    });
  });

  app.get('/api/calls/active', auth, (req, res) => {
    res.json({ call: serializeCall() });
  });

  app.get('/api/rtc-config', auth, (req, res) => {
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

  const callTitleSchema = z.object({ title: z.string().trim().max(120).optional() });

  app.post('/api/calls/start', auth, (req, res) => {
    if (activeCall) {
      res.status(409).json({ error: 'Un appel est déjà en cours', call: serializeCall() });
      return;
    }
    const parsed = callTitleSchema.safeParse(req.body ?? {});
    const title = parsed.success ? parsed.data.title ?? '' : '';
    const row = db.startCall(req.user?.id ?? -1, title);
    activeCall = { row, participants: new Set([req.user?.id ?? -1]), recording: null };
    broadcastCall();
    res.status(201).json({ call: serializeCall() });
  });

  app.post('/api/calls/join', auth, (req, res) => {
    if (!activeCall) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    activeCall.participants.add(req.user?.id ?? -1);
    broadcastCall();
    res.json({ call: serializeCall() });
  });

  app.post('/api/calls/leave', auth, (req, res) => {
    if (!activeCall) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    activeCall.participants.delete(req.user?.id ?? -1);
    if (activeCall.participants.size === 0) {
      db.endCall(activeCall.row.id);
      activeCall = null;
    }
    broadcastCall();
    res.json({ call: serializeCall() });
  });

  app.post('/api/calls/end', auth, (req, res) => {
    if (!activeCall) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    db.endCall(activeCall.row.id);
    activeCall = null;
    broadcastCall();
    res.json({ ok: true });
  });

  const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().optional(),
  });

  app.get('/api/messages', auth, (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Paramètres invalides' });
      return;
    }
    const rows = db.listMessages(parsed.data.limit, parsed.data.before);
    res.json({ messages: rows.reverse().map((r) => serializeMessage(db, r)) });
  });

  const postSchema = z.object({
    content: z.string().trim().min(1).max(4000),
  });

  app.post('/api/messages', auth, (req, res) => {
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'content requis (1-4000 caractères)' });
      return;
    }
    res.status(201).json({ message: postMessage(req.user?.id ?? -1, parsed.data.content) });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
      },
    }),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  });

  app.post('/api/files', auth, upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Champ "file" requis' });
      return;
    }
    const uploaded = req.file;
    try {
      const displayName = Buffer.from(uploaded.originalname, 'latin1').toString('utf8');
      const post = req.body.post !== 'false';
      const text = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 4000) : '';
      let messageId: number | null = null;
      if (post) {
        messageId = db.insertMessage(req.user?.id ?? -1, text || `📌 ${displayName}`).id;
      }
      const fileRow = db.insertFile(
        req.user?.id ?? -1,
        messageId,
        displayName,
        uploaded.mimetype || 'application/octet-stream',
        uploaded.size,
        uploaded.filename,
      );
      void (async () => {
        try {
          if (isAudioMime(uploaded.mimetype, displayName)) {
            await transcribeAndStore(fileRow, displayName, uploaded.mimetype, req.user?.id ?? -1);
            return;
          }
          const textContent = await extractText(path.join(uploadsDir, uploaded.filename), uploaded.mimetype, displayName);
          if (textContent.trim()) {
            chunkText(textContent, config.RAG_CHUNK_SIZE).forEach((c, i) => db.insertChunk(fileRow.id, i, c));
          }
        } catch {
          // extraction non supportée : le fichier reste disponible au téléchargement
        }
      })();
      let message: SerializedMessage | null = null;
      if (messageId !== null) {
        message = serializeMessage(db, db.getMessageById(messageId) as MessageRow);
        broadcast({ type: 'message', message });
      }
      res.status(201).json({ file: toPublicFile(fileRow), message });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erreur upload' });
    }
  });

  const filesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().optional(),
    query: z.string().max(100).optional(),
  });

  app.get('/api/files', auth, (req, res) => {
    const parsed = filesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Paramètres invalides' });
      return;
    }
    const rows: FileListRow[] = db.listFiles(parsed.data.limit, parsed.data.before, parsed.data.query || undefined);
    res.json({
      files: rows.map((f) => ({
        ...toPublicFile(f),
        messageId: f.message_id,
        user: { id: f.user_id, name: f.user_name },
      })),
    });
  });

  app.get('/api/files/:id/download', auth, (req, res) => {
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

  app.post('/api/calls/:id/recording/start', auth, (req, res) => {
    if (!activeCall || activeCall.row.id !== Number(req.params.id)) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    if (activeCall.recording) {
      res.status(409).json({ error: 'Enregistrement déjà en cours', call: serializeCall() });
      return;
    }
    activeCall.recording = { id: randomUUID(), startedBy: req.user?.id ?? -1, startedAt: Date.now() };
    db.insertRecording({ id: activeCall.recording.id, callId: activeCall.row.id, userId: activeCall.recording.startedBy, fileId: null });
    broadcastCall();
    res.json({ call: serializeCall(), recordingId: activeCall.recording.id });
  });

  app.post('/api/calls/:id/recording/stop', auth, (req, res) => {
    if (!activeCall || activeCall.row.id !== Number(req.params.id)) {
      res.status(404).json({ error: 'Aucun appel en cours' });
      return;
    }
    const body = z.object({ recordingId: z.string().optional() }).safeParse(req.body ?? {});
    if (body.success && body.data.recordingId && activeCall.recording && body.data.recordingId !== activeCall.recording.id) {
      res.status(409).json({ error: 'recordingId ne correspond pas à la prise en cours', call: serializeCall() });
      return;
    }
    activeCall.recording = null;
    broadcastCall();
    res.json({ call: serializeCall() });
  });

  app.post('/api/calls/:id/recording', auth, recordUpload.single('file'), (req, res) => {
    const call = db.getCallById(Number(req.params.id));
    if (!call) {
      res.status(404).json({ error: 'Appel introuvable' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Champ "file" requis' });
      return;
    }
    const recordingId = typeof req.body.recordingId === 'string' && req.body.recordingId ? req.body.recordingId : null;
    if (recordingId) {
      const existing = db.getRecording(recordingId);
      if (!existing) {
        res.status(400).json({ error: 'recordingId inconnu' });
        return;
      }
      if (existing.user_id !== (req.user?.id ?? -1)) {
        res.status(403).json({ error: "Seul l'auteur de la prise peut déposer son fichier" });
        return;
      }
      if (existing.file_id) {
        const file = db.getFileById(existing.file_id);
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
    );
    if (recordingId) db.setRecordingFile(recordingId, fileRow.id);
    const message = serializeMessage(db, messageRow);
    broadcast({ type: 'message', message });

    void transcribeAndStore(fileRow, displayName, uploaded.mimetype, req.user?.id ?? -1);

    res.status(201).json({ file: toPublicFile(fileRow), message, transcriptPending: sttConfigured(config), recordingId });
  });

  const deriveSchema = z.object({ kind: z.enum(['resume', 'cr']) });

  app.post('/api/files/:id/derive', auth, async (req, res) => {
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
      res.status(201).json({ file: { ...toPublicFile(row), messageId: row.message_id, user: { id: row.user_id, name: db.getUserById(row.user_id)?.name ?? '' } } });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erreur dérivation' });
    }
  });

  app.post('/api/files/:id/transcribe', auth, async (req, res) => {
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
        user: { id: row.user_id, name: db.getUserById(row.user_id)?.name ?? '' },
      },
    });
  });

  app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
    const overview = db.statsOverview();
    const model = config.LLM_MODEL ?? '';
    res.json({
      users: { total: overview.users, online: onlineUserIds().length },
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
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    const fail = (reason: string) => {
      ws.send(JSON.stringify({ type: 'error', error: reason }));
      ws.close(4001);
    };
    if (!token) {
      fail('Token manquant');
      return;
    }
    let payload;
    try {
      payload = verifyToken(token, config.JWT_SECRET);
    } catch {
      fail('Token invalide');
      return;
    }
    const user = db.getUserById(payload.sub);
    if (!user) {
      fail('Utilisateur introuvable');
      return;
    }
    clients.add(ws);
    let sockets = online.get(user.id);
    if (!sockets) {
      sockets = new Set();
      online.set(user.id, sockets);
    }
    sockets.add(ws);
    ws.send(JSON.stringify({ type: 'hello', user: toPublicUser(user) }));
    broadcastPresence();

    const inboundSchema = z.object({
      type: z.string(),
      content: z.string().optional(),
      before: z.number().optional(),
      limit: z.number().optional(),
      to: z.number().optional(),
      data: z.unknown().optional(),
      callId: z.number().optional(),
    });

    ws.on('message', (data) => {
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
        postMessage(user.id, content);
      } else if (msg.data.type === 'history') {
        const limit = Math.min(Math.max(Math.trunc(msg.data.limit ?? 50), 1), 200);
        const rows = db.listMessages(limit, typeof msg.data.before === 'number' ? msg.data.before : undefined);
        ws.send(JSON.stringify({ type: 'history', messages: rows.reverse().map((r) => serializeMessage(db, r)) }));
      } else if (msg.data.type === 'signal' && typeof msg.data.to === 'number') {
        if (
          msg.data.callId !== undefined &&
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
  });

  return {
    config,
    db,
    broadcast,
    server,
    onlineUserIds,
    close: () =>
      new Promise((resolve) => {
        for (const client of clients) client.terminate();
        wss.close();
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
