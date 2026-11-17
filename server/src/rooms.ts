import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DB } from './db.js';

export const LEGACY_ROOM_ID = 1;
const INVITATION_LIFETIME = 7 * 24 * 60 * 60 * 1000;

export type RoomRole = 'admin' | 'member';
export type Role = 'superadmin' | RoomRole;

export interface RoomRow {
  id: number;
  name: string;
  created_at: number;
  archived_at: number | null;
}

export interface Account {
  id: number;
  login: string;
  alias: string;
  email: string | null;
  avatar: string | null;
  password_hash: string;
  room_id: number;
  role: RoomRole;
  session_version: number;
  removed_at: number | null;
}

export interface InvitationRow {
  id: number;
  room_id: number;
  email: string;
  role: RoomRole;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  accepted_account_id: number | null;
}

const invitationColumns = 'id, room_id, email, role, expires_at, used_at, revoked_at, accepted_account_id';

function invitationDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function activeInvite(invite: InvitationRow | undefined): invite is InvitationRow {
  return Boolean(invite && !invite.used_at && !invite.revoked_at && invite.expires_at > Date.now());
}

export class RoomDirectory {
  private readonly db: DatabaseSync;
  private readonly superadminNames: Set<string>;

  constructor(dataDir: string, legacy: DB, legacyAdmins: string, superadminNames: string) {
    this.superadminNames = new Set(superadminNames.split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => name.includes('@') ? name.toLowerCase() : name));
    this.db = new DatabaseSync(path.join(dataDir, 'directory.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT NOT NULL UNIQUE,
        alias TEXT NOT NULL,
        email TEXT UNIQUE COLLATE NOCASE,
        avatar TEXT,
        password_hash TEXT NOT NULL,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        session_version INTEGER NOT NULL DEFAULT 0,
        removed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_room ON accounts(room_id, removed_at);
      CREATE TABLE IF NOT EXISTS invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        email TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER,
        accepted_account_id INTEGER REFERENCES accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_room ON invitations(room_id, expires_at);
    `);
    const columns = this.db.prepare('PRAGMA table_info(invitations)').all();
    if (!columns.some(({ name }) => name === 'accepted_account_id')) {
      this.db.exec('ALTER TABLE invitations ADD COLUMN accepted_account_id INTEGER REFERENCES accounts(id)');
    }

    this.transaction(() => {
      if (this.getRoom(LEGACY_ROOM_ID)) return;
      this.db.prepare('INSERT INTO rooms(id, name, created_at) VALUES (?, ?, ?)').run(LEGACY_ROOM_ID, "Chat d'équipe", Date.now());
      const admins = new Set(legacyAdmins.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
      const insert = this.db.prepare(
        'INSERT INTO accounts(id, login, alias, password_hash, room_id, role) VALUES (?, ?, ?, ?, ?, ?)',
      );
      let highestLegacyId = legacy.getBot().id;
      for (const member of legacy.listUsers()) {
        highestLegacyId = Math.max(highestLegacyId, member.id);
        if (!member.pass_hash) continue;
        insert.run(member.id, member.name, member.name, member.pass_hash, LEGACY_ROOM_ID, admins.has(member.name.toLowerCase()) ? 'admin' : 'member');
      }
      const updated = this.db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'accounts'").run(highestLegacyId);
      if (!updated.changes) this.db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('accounts', ?)").run(highestLegacyId);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  role(account: Account): Role {
    return this.superadminNames.has(account.login) ? 'superadmin' : account.role;
  }

  bootstrapSuperadmin(hash: (password: string) => string, password: string): void {
    const login = this.superadminNames.values().next().value;
    if (!login || !password) return;
    this.transaction(() => {
      if (this.accountByLogin(login) || this.accountByEmail(login)) return;
      this.insertAccount(login, login, login.includes('@') ? login : null, hash(password), LEGACY_ROOM_ID, 'admin');
    });
  }

  getRoom(id: number): RoomRow | undefined {
    return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as unknown as RoomRow | undefined;
  }

  listRooms(account: Account): RoomRow[] {
    if (this.role(account) === 'superadmin') {
      return this.db.prepare('SELECT * FROM rooms ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, id').all() as unknown as RoomRow[];
    }
    const room = this.getRoom(account.room_id);
    return room ? [room] : [];
  }

  createRoom(name: string): RoomRow {
    const result = this.db.prepare('INSERT INTO rooms(name, created_at) VALUES (?, ?)').run(name, Date.now());
    return this.getRoom(Number(result.lastInsertRowid))!;
  }

  renameRoom(id: number, name: string): RoomRow {
    this.db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name, id);
    return this.getRoom(id)!;
  }

  setRoomArchived(id: number, archived: boolean): RoomRow {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare('UPDATE rooms SET archived_at = ? WHERE id = ?').run(archived ? now : null, id);
      if (archived) {
        this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE room_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now, id);
      }
      return this.getRoom(id)!;
    });
  }

  accessRoom(account: Account, requested?: number): RoomRow | undefined {
    if (account.removed_at !== null) return undefined;
    const superadmin = this.role(account) === 'superadmin';
    const id = requested ?? account.room_id;
    if (!superadmin && id !== account.room_id) return undefined;
    const room = this.getRoom(id);
    if (room && room.archived_at === null) return room;
    if (!requested && superadmin) return this.listRooms(account).find((item) => item.archived_at === null);
    return undefined;
  }

  getAccount(id: number): Account | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as Account | undefined;
  }

  private accountByLogin(login: string): Account | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE login = ?').get(login) as unknown as Account | undefined;
  }

  private accountByEmail(email: string): Account | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as unknown as Account | undefined;
  }

  findAccount(identifier: string): Account | undefined {
    if (!identifier.includes('@')) return this.accountByLogin(identifier);
    return this.accountByEmail(identifier) ?? this.db.prepare(
      'SELECT * FROM accounts WHERE login = ? AND email IS NULL',
    ).get(identifier) as unknown as Account | undefined;
  }

  private insertAccount(login: string, alias: string, email: string | null, hash: string, roomId: number, role: RoomRole): Account {
    const result = this.db.prepare(
      'INSERT INTO accounts(login, alias, email, password_hash, room_id, role) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(login, alias, email, hash, roomId, role);
    return this.getAccount(Number(result.lastInsertRowid))!;
  }

  private reservedEmail(email: string): boolean {
    return this.superadminNames.has(email) || Boolean(this.accountByLogin(email));
  }

  createRoomWithAdmin(alias: string, email: string, hash: string, roomName: string): Account | undefined {
    return this.transaction(() => {
      if (this.accountByEmail(email) || this.reservedEmail(email)) return undefined;
      return this.insertAccount(email, alias, email, hash, this.createRoom(roomName).id, 'admin');
    });
  }

  listMembers(roomId: number): Account[] {
    return this.db.prepare(
      'SELECT * FROM accounts WHERE room_id = ? AND removed_at IS NULL ORDER BY alias COLLATE NOCASE, id',
    ).all(roomId) as unknown as Account[];
  }

  updateMember(account: Account, updates: { alias?: string; email?: string; avatar?: string | null }): Account | undefined {
    return this.transaction(() => {
      if (updates.email !== undefined && updates.email !== account.email) {
        const existing = this.accountByEmail(updates.email);
        const loginOwner = this.accountByLogin(updates.email);
        if ((existing && existing.id !== account.id) || (loginOwner && loginOwner.id !== account.id) || this.superadminNames.has(updates.email)) return undefined;
      }
      this.db.prepare('UPDATE accounts SET alias = ?, email = ?, avatar = ? WHERE id = ? AND removed_at IS NULL').run(
        updates.alias ?? account.alias,
        updates.email ?? account.email,
        updates.avatar === undefined ? account.avatar : updates.avatar,
        account.id,
      );
      return this.getAccount(account.id);
    });
  }

  removeMember(id: number): void {
    this.db.prepare('UPDATE accounts SET removed_at = ?, session_version = session_version + 1 WHERE id = ? AND removed_at IS NULL').run(Date.now(), id);
  }

  listInvitations(roomId: number): InvitationRow[] {
    return this.db.prepare(
      'SELECT ' + invitationColumns + ' FROM invitations WHERE room_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY id DESC',
    ).all(roomId, Date.now()) as unknown as InvitationRow[];
  }

  getInvitation(roomId: number, id: number): InvitationRow | undefined {
    return this.db.prepare(
      'SELECT ' + invitationColumns + ' FROM invitations WHERE room_id = ? AND id = ?',
    ).get(roomId, id) as unknown as InvitationRow | undefined;
  }

  private latestUnclaimedInvitation(roomId: number, email: string): InvitationRow | undefined {
    return this.db.prepare(
      'SELECT ' + invitationColumns + ' FROM invitations WHERE room_id = ? AND email = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1',
    ).get(roomId, email) as unknown as InvitationRow | undefined;
  }

  pendingInvitation(roomId: number, email: string): InvitationRow | undefined {
    const invitation = this.latestUnclaimedInvitation(roomId, email);
    return activeInvite(invitation) ? invitation : undefined;
  }

  acceptedInvitations(roomId: number, ids: number[]): { id: number; accountId: number }[] {
    return this.db.prepare(`SELECT id, accepted_account_id AS accountId FROM invitations
      WHERE room_id = ? AND accepted_account_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))`)
      .all(roomId, JSON.stringify(ids)) as unknown as { id: number; accountId: number }[];
  }

  createInvitation(roomId: number, email: string, role: RoomRole): { invitation: InvitationRow; token: string } | undefined {
    return this.transaction(() => {
      const existing = this.accountByEmail(email);
      if (existing) {
        if (existing.room_id !== roomId || existing.removed_at === null || this.role(existing) === 'superadmin') return undefined;
      } else if (this.reservedEmail(email)) return undefined;
      const token = randomBytes(32).toString('base64url');
      const digest = invitationDigest(token);
      const expiresAt = Date.now() + INVITATION_LIFETIME;
      const pending = this.latestUnclaimedInvitation(roomId, email);
      if (pending) {
        this.db.prepare('UPDATE invitations SET token_hash = ?, expires_at = ?, role = ? WHERE id = ?')
          .run(digest, expiresAt, role, pending.id);
        return { invitation: { ...pending, expires_at: expiresAt, role }, token };
      }
      const result = this.db.prepare(
        'INSERT INTO invitations(room_id, email, role, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(roomId, email, role, digest, expiresAt);
      return { invitation: this.getInvitation(roomId, Number(result.lastInsertRowid))!, token };
    });
  }

  revokeInvitation(roomId: number, id: number): boolean {
    return Boolean(this.db.prepare(
      'UPDATE invitations SET revoked_at = ? WHERE room_id = ? AND id = ? AND used_at IS NULL AND revoked_at IS NULL',
    ).run(Date.now(), roomId, id).changes);
  }

  invitationFor(token: string): { invitation: InvitationRow; room: RoomRow } | undefined {
    const invitation = this.db.prepare(
      'SELECT ' + invitationColumns + ' FROM invitations WHERE token_hash = ?',
    ).get(invitationDigest(token)) as unknown as InvitationRow | undefined;
    if (!activeInvite(invitation)) return undefined;
    const room = this.getRoom(invitation.room_id);
    return room?.archived_at === null ? { invitation, room } : undefined;
  }

  acceptInvitation(token: string, alias: string, hash: string): Account | undefined {
    return this.transaction(() => {
      const match = this.invitationFor(token);
      if (!match) return undefined;
      const { invitation } = match;
      const { room_id: roomId, email, role } = invitation;
      const existing = this.accountByEmail(email);
      if (existing) {
        if (existing.room_id !== roomId || existing.removed_at === null || this.role(existing) === 'superadmin') return undefined;
      } else if (this.reservedEmail(email)) return undefined;
      let account: Account;
      if (existing) {
        this.db.prepare(
          'UPDATE accounts SET alias = ?, password_hash = ?, role = ?, removed_at = NULL, session_version = session_version + 1 WHERE id = ?',
        ).run(alias, hash, role, existing.id);
        account = this.getAccount(existing.id)!;
      } else {
        account = this.insertAccount(email, alias, email, hash, roomId, role);
      }
      this.db.prepare('UPDATE invitations SET used_at = ?, accepted_account_id = ? WHERE id = ?')
        .run(Date.now(), account.id, invitation.id);
      return account;
    });
  }

  close(): void {
    this.db.close();
  }
}
