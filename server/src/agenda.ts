import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { askAgenda } from './agenda-assistant.js';
import type { MeetingInput, MeetingRow } from './agenda-store.js';
import { calendarFile, validTimeZone } from './agenda-time.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { HttpError } from './llm/derive.js';
import { positiveId } from './mentions.js';
import type { RoomDirectory } from './rooms.js';

interface Dependencies {
  db: DB;
  config: Config;
  roomId: number;
  directory: RoomDirectory;
  activeMeeting: () => number | null;
  changed: () => void;
}

const time = z.number().int().min(Date.UTC(1900, 0, 1)).max(Date.UTC(9999, 11, 30));
const zone = z.string().trim().min(1).max(100).refine(validTimeZone, 'Fuseau horaire invalide');
const meetingInput = z.object({
  title: z.string().trim().min(1).max(120), agenda: z.string().trim().max(8000).default(''),
  startsAt: time, durationMinutes: z.number().int().min(1).max(1440), timeZone: zone, participantIds: z.array(positiveId).default([]),
});
const listInput = z.object({ from: z.coerce.number().pipe(time).optional(), until: z.coerce.number().pipe(time).optional() })
  .refine(({ from, until }) => from === undefined || until === undefined || until > from);

const moderator = (role?: string) => role === 'admin' || role === 'superadmin';

export function canEnterMeeting(db: DB, id: number, userId: number, role?: string): boolean {
  return moderator(role) || db.agenda.invited(id, userId);
}

function serialize(deps: Dependencies, row: MeetingRow, userId: number, role?: string) {
  const isLive = deps.activeMeeting() === row.id;
  const latest = row.latest_call_id === null ? undefined : deps.db.getCallById(row.latest_call_id);
  const status = row.cancelled_at !== null ? 'cancelled' : isLive ? 'live' : latest?.ended_at != null ? 'held'
    : row.starts_at + row.duration_minutes * 60_000 <= Date.now() ? 'past' : 'scheduled';
  return {
    id: row.id, title: row.title, agenda: row.agenda, startsAt: row.starts_at, durationMinutes: row.duration_minutes, timeZone: row.time_zone,
    organizerId: row.organizer_id, participants: deps.db.agenda.attendees(row.id), artifacts: deps.db.agenda.artifacts(row.id), status,
    canEdit: (status === 'scheduled' || status === 'past') && (row.organizer_id === userId || moderator(role)),
    canEnter: row.cancelled_at === null && canEnterMeeting(deps.db, row.id, userId, role),
  };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof HttpError) res.status(error.statusCode).json({ error: error.message });
  else res.status(500).json({ error: 'Impossible de traiter la demande d’agenda.' });
}

export function mountAgenda(router: Router, deps: Dependencies): void {
  const { db, directory, roomId } = deps;
  const viewer = (req: Request) => req.user?.id ?? -1;
  const publicMeeting = (req: Request, row: MeetingRow) => serialize(deps, row, viewer(req), req.user?.role);
  const getMeeting = (req: Request) => {
    const id = positiveId.safeParse(Number(req.params.id));
    const row = id.success ? db.agenda.get(id.data) : undefined;
    if (!row) throw new HttpError(404, 'Réunion introuvable');
    return row;
  };
  const editMeeting = (req: Request) => {
    const row = getMeeting(req);
    if (row.organizer_id !== viewer(req) && !moderator(req.user?.role)) throw new HttpError(403, 'Modification réservée à l’organisateur ou à l’administration du salon.');
    if (row.cancelled_at !== null) throw new HttpError(409, 'Cette réunion a été annulée.');
    if (row.id === deps.activeMeeting() || row.latest_call_id !== null) throw new HttpError(409, 'Un appel a déjà démarré pour cette réunion.');
    return row;
  };
  const readInput = (req: Request): MeetingInput => {
    const parsed = meetingInput.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Renseigne un titre, une date valide et une durée comprise entre 1 et 1 440 minutes.');
    const members = new Map(directory.listMembers(roomId).map((member) => [member.id, member]));
    for (const id of new Set(parsed.data.participantIds)) {
      if (id === viewer(req)) continue;
      const member = members.get(id);
      if (!member) throw new HttpError(400, 'Les participants doivent faire partie de ce salon.');
      db.ensureActor(member);
    }
    return parsed.data;
  };

  router.get('/api/agenda', (req, res) => {
    const parsed = listInput.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'Période invalide' }); return; }
    res.json({ meetings: db.agenda.list({ ...parsed.data, overlap: true }).map((row) => publicMeeting(req, row)) });
  });

  router.get('/api/agenda/invitations', (req, res) => {
    if (req.query.details === '1') {
      const meetings = db.agenda.pendingMeetings(viewer(req)).map((row) => publicMeeting(req, row));
      res.json({ pending: meetings.length, meetings });
    } else res.json({ pending: db.agenda.pendingInvitations(viewer(req)) });
  });

  router.post('/api/agenda', (req, res) => {
    try {
      const row = db.transaction(() => db.agenda.create(viewer(req), readInput(req)));
      deps.changed();
      res.status(201).json({ meeting: publicMeeting(req, row) });
    } catch (error) { sendError(res, error); }
  });

  router.post('/api/agenda/assistant', async (req, res) => {
    const input = z.object({ prompt: z.string().trim().min(1).max(4000), timeZone: zone }).safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Une demande d’agenda et un fuseau horaire sont nécessaires.' }); return; }
    const userId = viewer(req);
    const stillAuthorized = () => {
      const current = directory.getAccount(userId);
      return !!current && !!directory.accessRoom(current, roomId);
    };
    try {
      const result = await askAgenda({ db, config: deps.config, userId, members: directory.listMembers(roomId) }, input.data.prompt, input.data.timeZone, stillAuthorized);
      if (result.kind === 'results') {
        res.json({ kind: result.kind, answer: result.answer, total: result.total, meetings: result.rows.map((row) => publicMeeting(req, row)) });
      } else res.json(result);
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/agenda/:id', (req, res) => {
    try { res.json({ meeting: publicMeeting(req, getMeeting(req)) }); } catch (error) { sendError(res, error); }
  });

  router.patch('/api/agenda/:id', (req, res) => {
    try {
      const row = db.transaction(() => db.agenda.update(editMeeting(req), readInput(req)));
      deps.changed();
      res.json({ meeting: publicMeeting(req, row) });
    } catch (error) { sendError(res, error); }
  });

  router.delete('/api/agenda/:id', (req, res) => {
    try {
      const { id } = editMeeting(req);
      db.agenda.cancel(id);
      deps.changed();
      res.json({ meeting: publicMeeting(req, db.agenda.get(id)!) });
    } catch (error) { sendError(res, error); }
  });

  router.patch('/api/agenda/:id/response', (req, res) => {
    try {
      const row = getMeeting(req);
      if (row.cancelled_at !== null) throw new HttpError(409, 'Cette réunion a été annulée.');
      if (!['scheduled', 'live'].includes(publicMeeting(req, row).status)) throw new HttpError(409, 'La réunion est passée.');
      const parsed = z.object({ response: z.enum(['accepted', 'tentative', 'declined']) }).safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Réponse invalide.');
      if (row.organizer_id === viewer(req) || !db.agenda.respond(row.id, viewer(req), parsed.data.response)) {
        throw new HttpError(403, 'Réponse réservée aux participants invités.');
      }
      deps.changed();
      res.json({ meeting: publicMeeting(req, row) });
    } catch (error) { sendError(res, error); }
  });

  router.get('/api/agenda/:id/ics', (req, res) => {
    try {
      const row = getMeeting(req);
      res.type('text/calendar').attachment(`appel-${row.id}.ics`).send(calendarFile(row));
    } catch (error) { sendError(res, error); }
  });
}
