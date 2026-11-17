import type { DatabaseSync } from 'node:sqlite';

export interface ReceiptInput {
  id: number;
  read: boolean;
}

export interface MessageReceipt {
  messageId: number;
  authorId: number;
  received: number;
  read: number;
}

export class MessageReceipts {
  private readonly startAfter: number;

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_receipt_baseline (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_message_id INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO message_receipt_baseline
        SELECT 1, COALESCE(MAX(id), 0) FROM messages;
      CREATE TABLE IF NOT EXISTS message_receipts (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        seen INTEGER NOT NULL CHECK (seen IN (0, 1)),
        PRIMARY KEY (message_id, user_id)
      );
    `);
    const baseline = db.prepare('SELECT last_message_id FROM message_receipt_baseline WHERE singleton = 1')
      .get() as { last_message_id: number };
    this.startAfter = baseline.last_message_id;
  }

  unread(userId: number): { count: number; firstId: number | null } {
    return this.db.prepare(`
      SELECT COUNT(*) AS count, MIN(m.id) AS firstId
      FROM messages m
      LEFT JOIN message_receipts r ON r.message_id = m.id AND r.user_id = ? AND r.seen = 1
      WHERE m.id > ? AND m.user_id <> ? AND r.message_id IS NULL
    `).get(userId, this.startAfter, userId) as { count: number; firstId: number | null };
  }

  acknowledge(userId: number, receipts: ReceiptInput[]): { changedIds: number[]; readChanged: boolean } {
    const write = this.db.prepare(`
      INSERT INTO message_receipts (message_id, user_id, seen)
      SELECT id, ?, ? FROM messages WHERE id = ? AND id > ? AND user_id <> ?
      ON CONFLICT (message_id, user_id) DO UPDATE SET seen = excluded.seen
      WHERE excluded.seen > message_receipts.seen
    `);
    const changed = new Set<number>();
    let readChanged = false;
    for (const { id, read } of receipts) {
      if (write.run(userId, Number(read), id, this.startAfter, userId).changes) {
        changed.add(id);
        if (read) readChanged = true;
      }
    }
    return { changedIds: [...changed], readChanged };
  }

  summaries(ids: number[], authorId?: number): MessageReceipt[] {
    if (!ids.length) return [];
    return this.db.prepare(`
      SELECT m.id AS messageId, m.user_id AS authorId, COUNT(*) AS received, SUM(r.seen) AS read
      FROM messages m JOIN message_receipts r ON r.message_id = m.id
      WHERE m.id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR m.user_id = ?)
      GROUP BY m.id
    `).all(JSON.stringify(ids), authorId ?? null, authorId ?? null) as unknown as MessageReceipt[];
  }
}
