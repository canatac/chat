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
    `);
    const bot = this.db.prepare('SELECT id FROM users WHERE is_bot = 1').get() as { id: number } | undefined;
    if (!bot) {
      this.db
        .prepare("INSERT INTO users (name, pass_hash, is_bot, created_at) VALUES ('assistant', NULL, 1, ?)")
        .run(Date.now());
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

  close(): void {
    this.db.close();
  }
}
