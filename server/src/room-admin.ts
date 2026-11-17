import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.js';
import type { Config } from './config.js';
import type { Account, InvitationRow, RoomDirectory, RoomRow } from './rooms.js';

const aliasSchema = z.string().trim().min(2).max(40);
export const emailSchema = z.string().trim().max(254).email().toLowerCase();
const roomNameSchema = z.string().trim().min(2).max(80);
const newPassword = z.string().min(8).refine((password) => Buffer.byteLength(password) <= 72);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const avatarSchema = z.string().max(16_384).refine((avatar) => {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar);
  if (!match) return false;
  const image = Buffer.from(match[1], 'base64');
  return image.length > 8 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
    && image[image.length - 2] === 0xff && image[image.length - 1] === 0xd9;
});

export function parseRoomId(value: string): number {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : -1;
}

function publicRoom(room: RoomRow) {
  return { id: room.id, name: room.name, archivedAt: room.archived_at };
}

export function publicAccount(directory: RoomDirectory, account: Account) {
  const role = directory.role(account);
  return { id: account.id, name: account.alias, isBot: false, isAdmin: role !== 'member', role, avatar: account.avatar };
}

function roomMember(directory: RoomDirectory, account: Account) {
  return { ...publicAccount(directory, account), email: account.email, alias: account.alias };
}

function publicInvitation(invitation: InvitationRow) {
  return { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expires_at };
}

interface RoomChanges {
  memberChanged: (roomId: number, account: Account, invitationId?: number) => void;
  invitationsChanged: (roomId: number) => void;
  memberRemoved: (roomId: number, accountId: number) => void;
  roomArchived: (roomId: number) => void;
}

export function mountRoomAdmin(app: Express, config: Config, directory: RoomDirectory, changes: RoomChanges) {
  const resolveAccount = (token: string | null): Account | undefined => {
    if (!token) return undefined;
    try {
      const claims = verifyToken(token, config.JWT_SECRET);
      if (!Number.isSafeInteger(claims.sub) || claims.sub <= 0) return undefined;
      const account = directory.getAccount(claims.sub);
      if (account && account.removed_at === null && account.session_version === (claims.version ?? 0)) return account;
    } catch {
      // Session absente, expirée ou invalide.
    }
    return undefined;
  };

  const auth: RequestHandler = (req, res, next) => {
    const header = req.headers.authorization;
    const account = resolveAccount(header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (!account) {
      res.status(401).json({ error: header ? 'Session invalide ou révoquée' : 'Non authentifié' });
      return;
    }
    res.locals.account = account;
    res.set('Cache-Control', 'private, no-store');
    req.user = { id: account.id, name: account.alias, role: directory.role(account) };
    next();
  };

  const superadminOnly: RequestHandler = (req, res, next) => {
    if (req.user?.role !== 'superadmin') {
      res.status(403).json({ error: 'Réservé au superadmin' });
      return;
    }
    next();
  };

  const manageRoom: RequestHandler = (req, res, next) => {
    const account = res.locals.account as Account;
    const roomId = parseRoomId(req.params.roomId);
    const isSuperadmin = directory.role(account) === 'superadmin';
    if (!isSuperadmin && (account.role !== 'admin' || account.room_id !== roomId)) {
      res.status(403).json({ error: 'Administration réservée à ce salon' });
      return;
    }
    const room = directory.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: 'Salon introuvable' });
      return;
    }
    if (room.archived_at !== null && !isSuperadmin) {
      res.status(403).json({ error: 'Ce salon est archivé' });
      return;
    }
    res.locals.room = room;
    next();
  };

  const editableMember: RequestHandler = (req, res, next) => {
    const room = res.locals.room as RoomRow;
    const member = directory.getAccount(parseRoomId(req.params.memberId));
    if (!member || member.room_id !== room.id || member.removed_at !== null) {
      res.status(404).json({ error: 'Membre introuvable dans ce salon' });
      return;
    }
    const role = directory.role(member);
    if ((role === 'superadmin' && member.id !== req.user?.id)
      || (role === 'admin' && req.user?.role !== 'superadmin' && member.id !== req.user?.id)) {
      res.status(403).json({ error: 'Modification réservée au titulaire ou au superadmin' });
      return;
    }
    res.locals.member = member;
    next();
  };

  function session(account: Account) {
    return {
      user: publicAccount(directory, account),
      roomId: directory.accessRoom(account)?.id ?? null,
      rooms: directory.listRooms(account).map(publicRoom),
    };
  }

  function authenticated(account: Account) {
    return {
      ...session(account),
      token: signToken({ id: account.id, name: account.login, version: account.session_version }, config.JWT_SECRET),
    };
  }

  app.use('/api/auth', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.post('/api/auth/register', (req, res) => {
    const parsed = z.object({ name: aliasSchema, email: emailSchema, password: newPassword, roomName: roomNameSchema.optional() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Alias, e-mail et mot de passe de 8 caractères minimum requis. Vérifiez aussi le nom du salon.' });
      return;
    }
    const { name, email, password, roomName } = parsed.data;
    const account = directory.createRoomWithAdmin(name, email, hashPassword(password), roomName ?? name);
    if (!account) {
      res.status(409).json({ error: 'Cette adresse ne peut pas être utilisée. Connectez-vous si vous avez déjà un compte.' });
      return;
    }
    res.status(201).json(authenticated(account));
  });

  app.post('/api/auth/login', (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(254), password: z.string().min(6).max(100) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Identifiants invalides' });
      return;
    }
    const account = directory.findAccount(parsed.data.name);
    if (!account || account.removed_at !== null || !verifyPassword(parsed.data.password, account.password_hash)) {
      res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
      return;
    }
    res.json(authenticated(account));
  });

  app.post('/api/auth/invitations/preview', (req, res) => {
    const parsed = tokenSchema.safeParse(req.body?.token);
    const result = parsed.success ? directory.invitationFor(parsed.data) : undefined;
    if (!result) {
      res.status(410).json({ error: 'Ce lien d’invitation est invalide, expiré ou déjà utilisé' });
      return;
    }
    res.json({ room: publicRoom(result.room), email: result.invitation.email, expiresAt: result.invitation.expires_at });
  });

  app.post('/api/auth/invitations/accept', (req, res) => {
    const parsed = z.object({ token: tokenSchema, alias: aliasSchema, password: newPassword }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Vérifiez le lien, l’alias et le mot de passe de 8 caractères minimum' });
      return;
    }
    const { token, alias, password } = parsed.data;
    const match = directory.invitationFor(token);
    if (!match) {
      res.status(410).json({ error: 'Ce lien d’invitation est invalide, expiré ou déjà utilisé' });
      return;
    }
    const account = directory.acceptInvitation(token, alias, hashPassword(password));
    if (!account) {
      res.status(409).json({ error: 'Cette invitation n’est plus disponible pour cette adresse' });
      return;
    }
    changes.memberChanged(account.room_id, account, match.invitation.id);
    res.status(201).json(authenticated(account));
  });

  app.get('/api/me', auth, (_req, res) => res.json(session(res.locals.account as Account)));

  app.get('/api/rooms', auth, (_req, res) => {
    res.json({ rooms: directory.listRooms(res.locals.account as Account).map(publicRoom) });
  });

  app.post('/api/rooms', auth, superadminOnly, (req, res) => {
    const parsed = roomNameSchema.safeParse(req.body?.name);
    if (!parsed.success) {
      res.status(400).json({ error: 'Le nom du salon doit contenir de 2 à 80 caractères' });
      return;
    }
    res.status(201).json({ room: publicRoom(directory.createRoom(parsed.data)) });
  });

  app.patch('/api/rooms/:roomId', auth, manageRoom, (req, res) => {
    const room = res.locals.room as RoomRow;
    const parsed = roomNameSchema.safeParse(req.body?.name);
    if (!parsed.success) {
      res.status(400).json({ error: 'Le nom du salon doit contenir de 2 à 80 caractères' });
      return;
    }
    res.json({ room: publicRoom(directory.renameRoom(room.id, parsed.data)) });
  });

  app.put('/api/rooms/:roomId/archive', auth, superadminOnly, manageRoom, (req, res) => {
    const room = res.locals.room as RoomRow;
    const parsed = z.boolean().safeParse(req.body?.archived);
    if (!parsed.success) {
      res.status(400).json({ error: 'État d’archivage invalide' });
      return;
    }
    const updated = directory.setRoomArchived(room.id, parsed.data);
    if (parsed.data) changes.roomArchived(room.id);
    res.json({ room: publicRoom(updated) });
  });

  app.get('/api/rooms/:roomId/members', auth, manageRoom, (_req, res) => {
    const room = res.locals.room as RoomRow;
    res.json({ members: directory.listMembers(room.id).map((account) => roomMember(directory, account)) });
  });

  app.patch('/api/rooms/:roomId/members/:memberId', auth, manageRoom, editableMember, (req, res) => {
    const member = res.locals.member as Account;
    const parsed = z.object({ alias: aliasSchema.optional(), email: emailSchema.optional(), avatar: avatarSchema.nullable().optional() }).strict().safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: 'Alias, e-mail ou avatar invalide' });
      return;
    }
    const saved = directory.updateMember(member, parsed.data);
    if (!saved) {
      res.status(409).json({ error: 'Cette adresse ne peut pas être utilisée' });
      return;
    }
    changes.memberChanged(saved.room_id, saved);
    res.json({ member: roomMember(directory, saved) });
  });

  app.delete('/api/rooms/:roomId/members/:memberId', auth, manageRoom, editableMember, (req, res) => {
    const member = res.locals.member as Account;
    if (member.id === req.user?.id || directory.role(member) === 'superadmin') {
      res.status(403).json({ error: 'Ce compte ne peut pas être retiré par cette action' });
      return;
    }
    directory.removeMember(member.id);
    changes.memberRemoved(member.room_id, member.id);
    res.status(204).end();
  });

  app.get('/api/rooms/:roomId/invitations', auth, manageRoom, (_req, res) => {
    const room = res.locals.room as RoomRow;
    res.json({ invitations: directory.listInvitations(room.id).map(publicInvitation) });
  });

  app.post('/api/rooms/:roomId/invitations', auth, manageRoom, (req, res) => {
    const room = res.locals.room as RoomRow;
    const parsed = z.object({ email: emailSchema, role: z.enum(['member', 'admin']).default('member') }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Vérifiez l’adresse et le rôle à inviter' });
      return;
    }
    if (room.archived_at !== null) {
      res.status(409).json({ error: 'Réactivez le salon pour inviter un membre' });
      return;
    }
    if (parsed.data.role === 'admin' && req.user?.role !== 'superadmin') {
      res.status(403).json({ error: 'Seul le superadmin peut inviter un administrateur' });
      return;
    }
    const result = directory.createInvitation(room.id, parsed.data.email, parsed.data.role);
    if (!result) {
      res.status(409).json({ error: 'Invitation indisponible pour cette adresse' });
      return;
    }
    changes.invitationsChanged(room.id);
    res.status(201).json({ invitation: publicInvitation(result.invitation), token: result.token });
  });

  app.delete('/api/rooms/:roomId/invitations/:invitationId', auth, manageRoom, (req, res) => {
    const room = res.locals.room as RoomRow;
    if (!directory.revokeInvitation(room.id, parseRoomId(req.params.invitationId))) {
      res.status(404).json({ error: 'Invitation introuvable' });
      return;
    }
    changes.invitationsChanged(room.id);
    res.status(204).end();
  });

  return { auth, resolveAccount };
}
