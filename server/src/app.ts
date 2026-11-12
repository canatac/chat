import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import { isAdminUser, type Config } from './config.js';
import { DB, type FileListRow, type FileRow, type MessageRow, type UserRow } from './db.js';
import { handleCommand } from './llm/run.js';
import { chunkText, extractText } from './llm/rag.js';
import { pricesFor } from './llm/pricing.js';

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
  return { id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: new Date(f.created_at).toISOString() };
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
        messageId = db.insertMessage(req.user?.id ?? -1, text || `📎 ${displayName}`).id;
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

  app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
    const overview = db.statsOverview();
    const model = config.LLM_MODEL ?? '';
    res.json({
      users: { total: overview.users, online: onlineUserIds().length },
      messages: overview.messages,
      files: { count: overview.files, bytes: overview.fileBytes },
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
