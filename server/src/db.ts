import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface UserRow {
  id: number;
  name: string;
  pass_hash: string | null;
  is_bot: number;
  created_at: number;
}

export interface MessageRow {
  id: number;
  user_id: number;
  content: string;
  created_at: number;
}

export interface ContextRow extends MessageRow {
  name: string;
}

export interface FileRow {
  id: number;
  user_id: number;
  message_id: number | null;
  name: string;
  mime: string;
  size: number;
  path: string;
  call_id: number | null;
  created_at: number;
}

export interface RecordingRow {
  id: string;
  call_id: number;
  user_id: number;
  file_id: number | null;
  created_at: number;
}

export interface CallRow {
  id: number;
  title: string;
  started_by: number;
  started_at: number;
  ended_at: number | null;
}

export interface FileListRow extends FileRow {
  user_name: string;
}

export interface ChunkRow {
  id: number;
  file_id: number;
  idx: number;
  content: string;
  name: string;
}

export interface UsageRow {
  id: number;
  user_id: number;
  message_id: number | null;
  command: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  error: string | null;
  created_at: number;
}

export class DB {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'chat.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        pass_hash TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        message_id INTEGER REFERENCES messages(id),
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        call_id INTEGER REFERENCES calls(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_id ON files(id);
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '',
        started_by INTEGER NOT NULL REFERENCES users(id),
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        call_id INTEGER NOT NULL REFERENCES calls(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        file_id INTEGER REFERENCES files(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS doc_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id),
        idx INTEGER NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS llm_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        message_id INTEGER REFERENCES messages(id),
        command TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    const bot = this.db.prepare('SELECT id FROM users WHERE is_bot = 1').get() as { id: number } | undefined;
    if (!bot) {
      this.db
        .prepare("INSERT INTO users (name, pass_hash, is_bot, created_at) VALUES ('assistant', NULL, 1, ?)")
        .run(Date.now());
    }
    const fileCols = this.db.prepare('PRAGMA table_info(files)').all() as unknown as { name: string }[];
    if (!fileCols.some((c) => c.name === 'call_id')) {
      this.db.exec('ALTER TABLE files ADD COLUMN call_id INTEGER REFERENCES calls(id)');
    }
  }

  createUser(name: string, passHash: string): UserRow {
    const info = this.db
      .prepare('INSERT INTO users (name, pass_hash, is_bot, created_at) VALUES (?, ?, 0, ?)')
      .run(name, passHash, Date.now());
    return this.getUserById(Number(info.lastInsertRowid)) as UserRow;
  }

  getUserByName(name: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE name = ?').get(name) as unknown as UserRow | undefined;
  }

  getUserById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users WHERE is_bot = 0 ORDER BY name').all() as unknown as UserRow[];
  }

  getBot(): UserRow {
    return this.db.prepare('SELECT * FROM users WHERE is_bot = 1').get() as unknown as UserRow;
  }

  insertMessage(userId: number, content: string): MessageRow {
    const info = this.db
      .prepare('INSERT INTO messages (user_id, content, created_at) VALUES (?, ?, ?)')
      .run(userId, content, Date.now());
    return this.getMessageById(Number(info.lastInsertRowid)) as MessageRow;
  }

  getMessageById(id: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow | undefined;
  }

  listMessages(limit: number, before?: number): MessageRow[] {
    const rows =
      before !== undefined
        ? this.db.prepare('SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
        : this.db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit);
    return rows as unknown as MessageRow[];
  }

  listMessagesJoined(limit: number, before?: number): ContextRow[] {
    const sql =
      before !== undefined
        ? 'SELECT m.id, m.user_id, m.content, m.created_at, u.name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id < ? ORDER BY m.id DESC LIMIT ?'
        : 'SELECT m.id, m.user_id, m.content, m.created_at, u.name FROM messages m JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT ?';
    const rows = before !== undefined ? this.db.prepare(sql).all(before, limit) : this.db.prepare(sql).all(limit);
    return rows as unknown as ContextRow[];
  }

  insertFile(
    userId: number,
    messageId: number | null,
    name: string,
    mime: string,
    size: number,
    relPath: string,
    callId: number | null = null,
  ): FileRow {
    const info = this.db
      .prepare('INSERT INTO files (user_id, message_id, name, mime, size, path, call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, messageId, name, mime, size, relPath, callId, Date.now());
    return this.getFileById(Number(info.lastInsertRowid)) as FileRow;
  }

  getFileById(id: number): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow | undefined;
  }

  listFiles(limit: number, before?: number, query?: string): FileListRow[] {
    let sql = 'SELECT f.*, u.name AS user_name FROM files f JOIN users u ON u.id = f.user_id';
    const params: (string | number)[] = [];
    const conds: string[] = [];
    if (before !== undefined) {
      conds.push('f.id < ?');
      params.push(before);
    }
    if (query) {
      conds.push('f.name LIKE ?');
      params.push(`%${query}%`);
    }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY f.id DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params) as unknown as FileListRow[];
  }

  listFilesByMessage(messageId: number): FileRow[] {
    return this.db
      .prepare('SELECT * FROM files WHERE message_id = ? ORDER BY id')
      .all(messageId) as unknown as FileRow[];
  }

  startCall(userId: number, title: string): CallRow {
    const info = this.db
      .prepare('INSERT INTO calls (title, started_by, started_at, ended_at) VALUES (?, ?, ?, NULL)')
      .run(title, userId, Date.now());
    return this.db.prepare('SELECT * FROM calls WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as CallRow;
  }

  endCall(id: number): void {
    this.db.prepare('UPDATE calls SET ended_at = ? WHERE id = ?').run(Date.now(), id);
  }

  getCallById(id: number): CallRow | undefined {
    return this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as unknown as CallRow | undefined;
  }

  getRecording(id: string): RecordingRow | undefined {
    return this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as unknown as RecordingRow | undefined;
  }

  insertRecording(r: { id: string; callId: number; userId: number; fileId: number | null }): void {
    this.db
      .prepare('INSERT INTO recordings (id, call_id, user_id, file_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(r.id, r.callId, r.userId, r.fileId, Date.now());
  }

  setRecordingFile(id: string, fileId: number): void {
    this.db.prepare('UPDATE recordings SET file_id = ? WHERE id = ?').run(fileId, id);
  }

  getActiveCall(): CallRow | undefined {
    return this.db.prepare('SELECT * FROM calls WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as unknown as CallRow | undefined;
  }

  insertChunk(fileId: number, idx: number, content: string): void {
    this.db.prepare('INSERT INTO doc_chunks (file_id, idx, content) VALUES (?, ?, ?)').run(fileId, idx, content);
  }

  listChunks(): ChunkRow[] {
    return this.db
      .prepare('SELECT c.id, c.file_id, c.idx, c.content, f.name FROM doc_chunks c JOIN files f ON f.id = c.file_id LIMIT 50000')
      .all() as unknown as ChunkRow[];
  }

  insertUsage(u: {
    userId: number;
    messageId: number | null;
    command: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    error: string | null;
  }): void {
    this.db
      .prepare(
        'INSERT INTO llm_usage (user_id, message_id, command, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(u.userId, u.messageId, u.command, u.provider, u.model, u.promptTokens, u.completionTokens, u.totalTokens, u.costUsd, u.error, Date.now());
  }

  statsOverview(): Record<string, number> {
    return this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users WHERE is_bot = 0) AS users,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM files) AS files,
          (SELECT COALESCE(SUM(size), 0) FROM files) AS fileBytes,
          (SELECT COUNT(*) FROM llm_usage) AS llmCalls,
          (SELECT COUNT(*) FROM llm_usage WHERE error IS NOT NULL) AS llmErrors,
          (SELECT COALESCE(SUM(prompt_tokens), 0) FROM llm_usage) AS promptTokens,
          (SELECT COALESCE(SUM(completion_tokens), 0) FROM llm_usage) AS completionTokens,
          (SELECT COALESCE(SUM(total_tokens), 0) FROM llm_usage) AS totalTokens,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage) AS costUsd,
          (SELECT COUNT(*) FROM calls) AS calls`,
      )
      .get() as unknown as Record<string, number>;
  }

  usageByCommand(): { command: string; calls: number; tokens: number; costUsd: number }[] {
    return this.db
      .prepare(
        'SELECT command, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS costUsd FROM llm_usage GROUP BY command ORDER BY calls DESC',
      )
      .all() as unknown as { command: string; calls: number; tokens: number; costUsd: number }[];
  }

  usageByModel(): { model: string; calls: number; tokens: number; costUsd: number }[] {
    return this.db
      .prepare(
        'SELECT model, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS costUsd FROM llm_usage GROUP BY model ORDER BY calls DESC',
      )
      .all() as unknown as { model: string; calls: number; tokens: number; costUsd: number }[];
  }

  usageByDay(): { day: string; calls: number; tokens: number; costUsd: number }[] {
    return this.db
      .prepare(
        "SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS costUsd FROM llm_usage GROUP BY day ORDER BY day DESC LIMIT 30",
      )
      .all() as unknown as { day: string; calls: number; tokens: number; costUsd: number }[];
  }

  close(): void {
    this.db.close();
  }
}
