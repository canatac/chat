import type { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import type { DetectionMetadata, Entity, ModelErrorPolicy } from './linguard-client.js';

export interface MaskRule {
  fingerprint: string;
  type: string;
}

export interface SecurityPolicy {
  detection: 'block' | 'anonymize' | 'ask';
  modelErrors: ModelErrorPolicy;
  version: number;
}

export class SecurityStore {
  private readonly fingerprintKey: string;

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
      CREATE TABLE IF NOT EXISTS security_mask_key (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_mask_rules (
        user_id INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, fingerprint)
      );
    `);
    db.prepare('INSERT OR IGNORE INTO security_mask_key VALUES (1, ?)').run(randomBytes(32).toString('hex'));
    this.fingerprintKey = (db.prepare('SELECT value FROM security_mask_key WHERE singleton = 1').get() as { value: string }).value;
  }

  policy(): SecurityPolicy {
    return this.db.prepare('SELECT detection, model_errors AS modelErrors, version FROM security_policy WHERE singleton = 1')
      .get() as unknown as SecurityPolicy;
  }

  update(policy: SecurityPolicy): boolean {
    return this.transaction(() => {
      const updated = Boolean(this.db.prepare('UPDATE security_policy SET detection = ?, model_errors = ?, version = version + 1 WHERE singleton = 1 AND version = ?')
        .run(policy.detection, policy.modelErrors, policy.version).changes);
      if (updated) this.db.exec('DELETE FROM security_mask_rules');
      return updated;
    });
  }

  maskRule(entity: Pick<Entity, 'type' | 'text'>): MaskRule {
    // La mémorisation n’ajoute aucune copie des valeurs personnelles au stockage.
    const fingerprint = createHmac('sha256', this.fingerprintKey).update(JSON.stringify([entity.type, entity.text])).digest('hex');
    return { fingerprint, type: entity.type };
  }

  remembered(userId: number): Set<string> {
    const rows = this.db.prepare('SELECT fingerprint FROM security_mask_rules WHERE user_id = ?').all(userId) as { fingerprint: string }[];
    return new Set(rows.map((row) => row.fingerprint));
  }

  remember(userId: number, rules: MaskRule[]): void {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO security_mask_rules VALUES (?, ?, ?, ?)');
      for (const rule of rules) insert.run(userId, rule.fingerprint, rule.type, Date.now());
    });
  }

  forget(userId: number): void {
    this.db.prepare('DELETE FROM security_mask_rules WHERE user_id = ?').run(userId);
    this.audit(userId, 'forgot-masking', { types: [], count: 0, maxScore: null });
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('SAVEPOINT security_masking');
    try {
      const result = run();
      this.db.exec('RELEASE security_masking');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO security_masking; RELEASE security_masking');
      throw error;
    }
  }

  audit(userId: number, action: string, metadata: DetectionMetadata): void {
    this.db.prepare('INSERT INTO security_events (created_at, user_id, action, types, count, max_score) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), userId, action, JSON.stringify(metadata.types), metadata.count, metadata.maxScore);
  }
}
