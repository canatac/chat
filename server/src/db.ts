import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Mention, MentionKind } from './mentions.js';

export interface UserRow {
  id: number;
  name: string;
  pass_hash: string | null;
  display_name: string | null;
  is_bot: number;
  created_at: number;
}

export interface MessageRow {
  id: number;
  user_id: number;
  content: string;
  created_at: number;
  mentions: string;
}

export interface ContextRow extends Omit<MessageRow, 'mentions'> {
  name: string;
}

export interface MentionNotificationRow {
  id: number;
  message_id: number;
  kind: MentionKind;
  read_at: number | null;
  content: string;
  created_at: number;
  sender_name: string;
}

const mentionNotificationSelect = `
  SELECT n.id, n.message_id, n.kind, n.read_at, m.content, m.created_at, COALESCE(u.display_name, u.name) AS sender_name
  FROM mention_notifications n JOIN messages m ON m.id = n.message_id JOIN users u ON u.id = m.user_id
`;

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
  folder_id: number | null;
  updated_at: number | null;
}

export interface FolderRow {
  id: number;
  name: string;
  parent_id: number | null;
  created_by: number;
  created_at: number;
  updated_at: number | null;
}

export interface FolderListRow extends FolderRow {
  user_name: string;
}

export interface FileEventRow {
  id: number;
  file_id: number | null;
  folder_id: number | null;
  action: string;
  detail: string;
  user_id: number;
  created_at: number;
}

export interface FileEventListRow extends FileEventRow {
  user_name: string;
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

const FILE_SORT_COLUMNS = {
  name: 'file_name_key(f.name)',
  date: 'COALESCE(f.updated_at, f.created_at)',
  size: 'f.size',
};

interface FileListOptions {
  sort?: keyof typeof FILE_SORT_COLUMNS;
  direction?: 'asc' | 'desc';
  name?: string;
  activityFrom?: number;
  activityBefore?: number;
  minBytes?: number;
  maxBytes?: number;
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

  constructor(dataDir: string, newBotId: number | null = null) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'chat.db'));
    this.db.function('file_name_key', { deterministic: true }, (name) =>
      String(name).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
    );
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
        created_at INTEGER NOT NULL,
        mentions TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
      CREATE TABLE IF NOT EXISTS mention_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('member', 'room')),
        read_at INTEGER,
        UNIQUE (recipient_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mentions_recipient ON mention_notifications(recipient_id, id);
      CREATE INDEX IF NOT EXISTS idx_mentions_unread ON mention_notifications(recipient_id) WHERE read_at IS NULL;
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        message_id INTEGER REFERENCES messages(id),
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        call_id INTEGER REFERENCES calls(id),
        folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_files_id ON files(id);
      -- journal d'audit : PAS de clé étrangère sur file_id/folder_id (le journal doit survivre
      -- à la suppression du fichier/dossier ; foreign_keys est ON dans node:sqlite)
      CREATE TABLE IF NOT EXISTS file_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER,
        folder_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_file_events_file ON file_events(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_events_folder ON file_events(folder_id);
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
        .prepare("INSERT INTO users (id, name, pass_hash, is_bot, created_at) VALUES (?, 'assistant', NULL, 1, ?)")
        .run(newBotId, Date.now());
    }
    const fileCols = this.db.prepare('PRAGMA table_info(files)').all() as unknown as { name: string }[];
    if (!fileCols.some((c) => c.name === 'call_id')) {
      this.db.exec('ALTER TABLE files ADD COLUMN call_id INTEGER REFERENCES calls(id)');
    }
    // migrations idempotentes (bases existantes) : dossiers + updated_at sur files
    for (const [col, def] of [
      ['folder_id', 'INTEGER REFERENCES folders(id) ON DELETE SET NULL'],
      ['updated_at', 'INTEGER'],
    ] as const) {
      if (!fileCols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE files ADD COLUMN ${col} ${def}`);
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)');
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all() as unknown as { name: string }[];
    if (!userColumns.some((column) => column.name === 'display_name')) {
      this.db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
    }
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    if (!messageColumns.some((column) => column.name === 'mentions')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'");
    }
  }

  createUser(name: string, passHash: string): UserRow {
    const info = this.db
      .prepare('INSERT INTO users (name, pass_hash, is_bot, created_at) VALUES (?, ?, 0, ?)')
      .run(name, passHash, Date.now());
    return this.getUserById(Number(info.lastInsertRowid)) as UserRow;
  }

  ensureActor(account: { id: number; alias: string }): UserRow {
    const current = this.getUserById(account.id);
    if (!current) {
      this.db.prepare('INSERT INTO users(id, name, is_bot, created_at, display_name) VALUES (?, ?, 0, ?, ?)')
        .run(account.id, 'account:' + account.id, Date.now(), account.alias);
    } else if ((current.display_name ?? current.name) !== account.alias) {
      this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(account.alias, account.id);
    } else {
      return current;
    }
    return this.getUserById(account.id)!;
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

  insertMessage(userId: number, content: string, mentions: Mention[] = []): MessageRow {
    const info = this.db
      .prepare('INSERT INTO messages (user_id, content, created_at, mentions) VALUES (?, ?, ?, ?)')
      .run(userId, content, Date.now(), JSON.stringify(mentions));
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

  listMessagesAfter(limit: number, after: number): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(after, limit) as unknown as MessageRow[];
  }

  createMentionNotifications(messageId: number, recipients: ReadonlyMap<number, MentionKind>) {
    if (!recipients.size) return [];
    const insert = this.db.prepare('INSERT INTO mention_notifications (recipient_id, message_id, kind) VALUES (?, ?, ?)');
    return [...recipients].map(([recipientId, kind]) => ({ recipientId, kind, id: Number(insert.run(recipientId, messageId, kind).lastInsertRowid) }));
  }

  listMentionNotifications(recipientId: number, limit: number, before?: number): MentionNotificationRow[] {
    const where = ' WHERE n.recipient_id = ?' + (before === undefined ? '' : ' AND n.id < ?');
    const query = this.db.prepare(mentionNotificationSelect + where + ' ORDER BY n.id DESC LIMIT ?');
    return (before === undefined ? query.all(recipientId, limit) : query.all(recipientId, before, limit)) as unknown as MentionNotificationRow[];
  }

  getMentionNotification(recipientId: number, id: number): MentionNotificationRow | undefined {
    return this.db.prepare(mentionNotificationSelect + ' WHERE n.recipient_id = ? AND n.id = ?')
      .get(recipientId, id) as unknown as MentionNotificationRow | undefined;
  }

  unreadMentions(recipientId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM mention_notifications WHERE recipient_id = ? AND read_at IS NULL')
      .get(recipientId) as { count: number };
    return row.count;
  }

  markMentionsRead(recipientId: number, selection: { id: number } | { through: number }): void {
    const clause = 'id' in selection ? 'id = ?' : 'id <= ?';
    const id = 'id' in selection ? selection.id : selection.through;
    this.db.prepare('UPDATE mention_notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL AND ' + clause)
      .run(Date.now(), recipientId, id);
  }

  listMessagesJoined(limit: number, before?: number): ContextRow[] {
    const sql =
      before !== undefined
        ? 'SELECT m.id, m.user_id, m.content, m.created_at, COALESCE(u.display_name, u.name) AS name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id < ? ORDER BY m.id DESC LIMIT ?'
        : 'SELECT m.id, m.user_id, m.content, m.created_at, COALESCE(u.display_name, u.name) AS name FROM messages m JOIN users u ON u.id = m.user_id ORDER BY m.id DESC LIMIT ?';
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
    folderId: number | null = null,
  ): FileRow {
    const info = this.db
      .prepare('INSERT INTO files (user_id, message_id, name, mime, size, path, call_id, folder_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, messageId, name, mime, size, relPath, callId, folderId, Date.now());
    return this.getFileById(Number(info.lastInsertRowid)) as FileRow;
  }

  getFileById(id: number): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow | undefined;
  }

  transaction<T>(write: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = write();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listFiles(limit: number, before?: number, query?: string, folderId?: number | null, options: FileListOptions = {}): FileListRow[] {
    let sql = 'SELECT f.*, COALESCE(u.display_name, u.name) AS user_name FROM files f JOIN users u ON u.id = f.user_id';
    const { conds, params } = this.matchingFiles(query, folderId, options);
    const sortColumn = options.sort ? FILE_SORT_COLUMNS[options.sort] : undefined;
    const direction = options.direction === 'desc' ? 'DESC' : 'ASC';
    if (before !== undefined) {
      if (sortColumn) {
        // La pagination reprend après la valeur de tri et l’identifiant du dernier fichier.
        const comparator = direction === 'DESC' ? '<' : '>';
        conds.push(`(${sortColumn}, f.id) ${comparator} (SELECT ${sortColumn}, f.id FROM files f WHERE f.id = ?)`);
      } else {
        conds.push('f.id < ?');
      }
      params.push(before);
    }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    const orderBy = sortColumn ? `${sortColumn} ${direction}, f.id ${direction}` : 'f.name COLLATE NOCASE, f.id DESC';
    sql += ` ORDER BY ${orderBy} LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as unknown as FileListRow[];
  }

  listFileIds(query: string | undefined, folderId: number | null | undefined, options: FileListOptions): number[] {
    const { conds, params } = this.matchingFiles(query, folderId, options);
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
    const rows = this.db.prepare('SELECT f.id FROM files f JOIN users u ON u.id = f.user_id' + where).all(...params) as { id: number }[];
    return rows.map(({ id }) => id);
  }

  private matchingFiles(query: string | undefined, folderId: number | null | undefined, options: FileListOptions) {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (query) {
      conds.push('f.name LIKE ?');
      params.push(`%${query}%`);
    }
    if (folderId !== undefined) {
      if (folderId === null) conds.push('f.folder_id IS NULL');
      else {
        conds.push('f.folder_id = ?');
        params.push(folderId);
      }
    }
    if (options.name) {
      conds.push('instr(file_name_key(f.name), file_name_key(?)) > 0');
      params.push(options.name);
    }
    for (const [value, condition] of [
      [options.activityFrom, `${FILE_SORT_COLUMNS.date} >= ?`],
      [options.activityBefore, `${FILE_SORT_COLUMNS.date} < ?`],
      [options.minBytes, 'f.size >= ?'],
      [options.maxBytes, 'f.size <= ?'],
    ] as const) {
      if (value === undefined) continue;
      conds.push(condition);
      params.push(value);
    }
    return { conds, params };
  }

  getFilesByIds(fileIds: number[]): FileRow[] {
    if (!fileIds.length) return [];
    return this.db.prepare('SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(fileIds)) as unknown as FileRow[];
  }

  listFilesInFolders(folderIds: number[]): FileRow[] {
    if (!folderIds.length) return [];
    return this.db.prepare('SELECT * FROM files WHERE folder_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(folderIds)) as unknown as FileRow[];
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

  // ---------- dossiers ----------
  createFolder(userId: number, name: string, parentId: number | null): FolderRow {
    const info = this.db
      .prepare('INSERT INTO folders (name, parent_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL)')
      .run(name, parentId, userId, Date.now());
    return this.getFolderById(Number(info.lastInsertRowid)) as FolderRow;
  }

  getFolderById(id: number): FolderRow | undefined {
    return this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as unknown as FolderRow | undefined;
  }

  listFolders(): FolderListRow[] {
    return this.db
      .prepare('SELECT f.*, COALESCE(u.display_name, u.name) AS user_name FROM folders f JOIN users u ON u.id = f.created_by ORDER BY f.name COLLATE NOCASE, f.id')
      .all() as unknown as FolderListRow[];
  }

  listFolderIds(parentId: number | null): number[] {
    const rows = this.db.prepare('SELECT f.id FROM folders f JOIN users u ON u.id = f.created_by WHERE f.parent_id IS ?')
      .all(parentId) as { id: number }[];
    return rows.map(({ id }) => id);
  }

  folderExistsWithSiblingName(parentId: number | null, name: string, excludeId?: number): boolean {
    const row =
      excludeId !== undefined
        ? (this.db
            .prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id IS ? AND lower(name) = lower(?) AND id != ?')
            .get(parentId, name, excludeId) as { n: number })
        : (this.db
            .prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id IS ? AND lower(name) = lower(?)')
            .get(parentId, name) as { n: number });
    return row.n > 0;
  }

  updateFolder(id: number, patch: { name?: string; parentId?: number | null }): void {
    if (patch.name !== undefined && patch.parentId !== undefined) {
      this.db.prepare('UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(patch.name, patch.parentId, Date.now(), id);
    } else if (patch.name !== undefined) {
      this.db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(patch.name, Date.now(), id);
    } else if (patch.parentId !== undefined) {
      this.db.prepare('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?').run(patch.parentId, Date.now(), id);
    }
  }

  isFolderDescendant(folderId: number, ancestorId: number): boolean {
    let cur: number | null = folderId;
    const seen = new Set<number>();
    while (cur !== null && !seen.has(cur)) {
      if (cur === ancestorId) return true;
      seen.add(cur);
      const row = this.db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur) as { parent_id: number | null } | undefined;
      cur = row?.parent_id ?? null;
    }
    return false;
  }

  listFolderTree(folderIds: number[]): FolderRow[] {
    if (!folderIds.length) return [];
    const rows = this.db.prepare(`
      WITH RECURSIVE tree(id) AS (
        SELECT value FROM json_each(?)
        UNION
        SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
      )
      SELECT f.* FROM folders f JOIN tree t ON f.id = t.id
    `).all(JSON.stringify(folderIds)) as unknown as FolderRow[];
    const withinTree = new Set(rows.map(({ id }) => id));
    const children = new Map<number, FolderRow[]>();
    const pending: FolderRow[] = [];
    for (const folder of rows) {
      const parent = folder.parent_id;
      if (parent === null || !withinTree.has(parent)) pending.push(folder);
      else {
        const siblings = children.get(parent) ?? [];
        siblings.push(folder);
        children.set(parent, siblings);
      }
    }
    // Les appelants peuvent supprimer les dossiers des feuilles vers la racine.
    const ordered: FolderRow[] = [];
    while (pending.length) {
      const folder = pending.pop()!;
      ordered.push(folder);
      for (const child of children.get(folder.id) ?? []) pending.push(child);
    }
    return ordered;
  }

  listMoveNames(kind: 'file' | 'folder', destination: number | null): Pick<FileRow, 'id' | 'name' | 'created_at' | 'updated_at'>[] {
    const table = kind === 'file' ? 'files' : 'folders';
    const parent = kind === 'file' ? 'folder_id' : 'parent_id';
    return this.db.prepare(`SELECT id, name, created_at, updated_at FROM ${table} WHERE ${parent} IS ? ORDER BY id`)
      .all(destination) as Pick<FileRow, 'id' | 'name' | 'created_at' | 'updated_at'>[];
  }

  folderCounts(folderId: number): { folders: number; files: number } {
    const folders = this.db.prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id = ?').get(folderId) as { n: number };
    const files = this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id = ?').get(folderId) as { n: number };
    return { folders: folders.n, files: files.n };
  }

  deleteFolder(id: number): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  }

  // ---------- fichiers : renommer / déplacer / supprimer ----------
  renameFile(id: number, name: string): void {
    this.db.prepare('UPDATE files SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  }

  moveFile(id: number, folderId: number | null): void {
    this.db.prepare('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ?').run(folderId, Date.now(), id);
  }

  fileNameExistsInFolder(folderId: number | null, name: string, excludeId?: number): boolean {
    const row =
      excludeId !== undefined
        ? (this.db
            .prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id IS ? AND lower(name) = lower(?) AND id != ?')
            .get(folderId, name, excludeId) as { n: number })
        : (this.db
            .prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id IS ? AND lower(name) = lower(?)')
            .get(folderId, name) as { n: number });
    return row.n > 0;
  }

  deleteFile(id: number): void {
    this.db.prepare('DELETE FROM doc_chunks WHERE file_id = ?').run(id);
    this.db.prepare('UPDATE recordings SET file_id = NULL WHERE file_id = ?').run(id);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }

  // ---------- journal de modifications ----------
  insertFileEvent(e: { fileId: number | null; folderId: number | null; action: string; detail?: string; userId: number }): FileEventRow {
    const info = this.db
      .prepare('INSERT INTO file_events (file_id, folder_id, action, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.fileId, e.folderId, e.action, e.detail ?? '', e.userId, Date.now());
    return this.db.prepare('SELECT * FROM file_events WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as FileEventRow;
  }

  listFileEvents(opts: { fileId?: number; folderId?: number; limit?: number }): FileEventListRow[] {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (opts.fileId !== undefined) {
      conds.push('e.file_id = ?');
      params.push(opts.fileId);
    }
    if (opts.folderId !== undefined) {
      conds.push('e.folder_id = ?');
      params.push(opts.folderId);
    }
    let sql = 'SELECT e.*, COALESCE(u.display_name, u.name) AS user_name FROM file_events e JOIN users u ON u.id = e.user_id';
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY e.id DESC LIMIT ?';
    params.push(opts.limit ?? 100);
    return this.db.prepare(sql).all(...params) as unknown as FileEventListRow[];
  }

  close(): void {
    this.db.close();
  }
}
