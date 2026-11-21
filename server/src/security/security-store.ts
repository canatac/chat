import type { DatabaseSync } from 'node:sqlite';
import type { DetectionMetadata, ModelErrorPolicy } from './linguard-client.js';

export interface SecurityPolicy {
  detection: 'block' | 'anonymize' | 'ask';
  modelErrors: ModelErrorPolicy;
  version: number;
}

export class SecurityStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS security_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        detection TEXT NOT NULL,
        model_errors TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO security_policy VALUES (1, 'block', 'fail-closed', 1);
      CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY,
        created_at INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        types TEXT NOT NULL,
        count INTEGER NOT NULL,
        max_score INTEGER
      );
    `);
  }

  policy(): SecurityPolicy {
    return this.db.prepare('SELECT detection, model_errors AS modelErrors, version FROM security_policy WHERE singleton = 1')
      .get() as unknown as SecurityPolicy;
  }

  update(policy: SecurityPolicy): boolean {
    return Boolean(this.db.prepare('UPDATE security_policy SET detection = ?, model_errors = ?, version = version + 1 WHERE singleton = 1 AND version = ?')
      .run(policy.detection, policy.modelErrors, policy.version).changes);
  }

  audit(userId: number, action: string, metadata: DetectionMetadata): void {
    this.db.prepare('INSERT INTO security_events (created_at, user_id, action, types, count, max_score) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), userId, action, JSON.stringify(metadata.types), metadata.count, metadata.maxScore);
  }
}
