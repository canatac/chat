import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import type { Config } from './config.js';
import { DB, type MessageRow, type UserRow } from './db.js';
import { handleCommand } from './llm/run.js';

export interface PublicUser {
  id: number;
  name: string;
  isBot: boolean;
}

export interface SerializedMessage {
  id: number;
  content: string;
  createdAt: string;
  user: PublicUser;
}

export function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, name: u.name, isBot: u.is_bot === 1 };
}

export function serializeMessage(db: DB, row: MessageRow): SerializedMessage {
  const user = db.getUserById(row.user_id) as UserRow;
  return {
    id: row.id,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    user: toPublicUser(user),
  };
}

export interface ServerContext {
  config: Config;
  db: DB;
  broadcast: (payload: unknown) => void;
  server: http.Server;
  close: () => Promise<void>;
}

export function createServer(config: Config, dataDir: string): ServerContext {
  const db = new DB(dataDir);
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  function broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
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
    res.json({ user: toPublicUser(user) });
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
    ws.send(JSON.stringify({ type: 'hello', user: toPublicUser(user) }));

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
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return {
    config,
    db,
    broadcast,
    server,
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
