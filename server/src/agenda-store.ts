import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type Rsvp = 'pending' | 'accepted' | 'tentative' | 'declined';
export type MeetingArtifactKind = 'recording' | 'transcript' | 'report' | 'summary';

export interface MeetingInput {
  title: string;
  agenda: string;
  startsAt: number;
  durationMinutes: number;
  timeZone: string;
  participantIds: number[];
}

export interface MeetingRow {
  id: number;
  uid: string;
  organizer_id: number;
  title: string;
  agenda: string;
  starts_at: number;
  duration_minutes: number;
  time_zone: string;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
  latest_call_id: number | null;
}

export interface MeetingFilter {
  from?: number;
  until?: number;
  overlap?: boolean;
  upcoming?: boolean;
  held?: boolean;
  participantIds?: number[];
  title?: string;
  excludeCancelled?: boolean;
}

interface AttendeeRow {
  id: number;
  name: string;
  response: Rsvp;
}

interface ArtifactRow {
  id: number;
  name: string;
  mime: string;
  size: number;
  kind: MeetingArtifactKind;
}

const meetingSelect = `SELECT e.*, (SELECT MAX(c.id) FROM calls c WHERE c.meeting_id = e.id) AS latest_call_id FROM agenda_events e`;
const withoutEndedCall = 'NOT EXISTS (SELECT 1 FROM calls c WHERE c.meeting_id = e.id AND c.ended_at IS NOT NULL)';
const withOpenCall = 'EXISTS (SELECT 1 FROM calls c WHERE c.meeting_id = e.id AND c.ended_at IS NULL)';
const pendingInvite = `e.cancelled_at IS NULL AND ((e.starts_at + e.duration_minutes * 60000 > ? AND ${withoutEndedCall}) OR ${withOpenCall})
  AND EXISTS (SELECT 1 FROM agenda_attendees a WHERE a.event_id = e.id AND a.user_id = ? AND a.response = 'pending' AND a.removed_at IS NULL)`;

export class AgendaStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agenda_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL UNIQUE,
        organizer_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        agenda TEXT NOT NULL,
        starts_at INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,
        time_zone TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cancelled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agenda_starts ON agenda_events(starts_at);
      CREATE TABLE IF NOT EXISTS agenda_attendees (
        event_id INTEGER NOT NULL REFERENCES agenda_events(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        response TEXT NOT NULL CHECK (response IN ('pending', 'accepted', 'tentative', 'declined')),
        removed_at INTEGER,
        PRIMARY KEY (event_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agenda_attendee_user ON agenda_attendees(user_id, event_id);
      CREATE TABLE IF NOT EXISTS agenda_contact_invites (
        event_id INTEGER NOT NULL REFERENCES agenda_events(id),
        invitation_id INTEGER NOT NULL,
        PRIMARY KEY (event_id, invitation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agenda_contact_invite ON agenda_contact_invites(invitation_id);
      CREATE TABLE IF NOT EXISTS call_attendance (
        call_id INTEGER NOT NULL REFERENCES calls(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        PRIMARY KEY (call_id, user_id)
      );
    `);
    const attendeeColumns = db.prepare('PRAGMA table_info(agenda_attendees)').all();
    if (!attendeeColumns.some(({ name }) => name === 'removed_at')) db.exec('ALTER TABLE agenda_attendees ADD COLUMN removed_at INTEGER');
    const callColumns = db.prepare('PRAGMA table_info(calls)').all();
    if (!callColumns.some(({ name }) => name === 'meeting_id')) db.exec('ALTER TABLE calls ADD COLUMN meeting_id INTEGER REFERENCES agenda_events(id)');
    const fileColumns = db.prepare('PRAGMA table_info(files)').all();
    if (!fileColumns.some(({ name }) => name === 'meeting_artifact')) db.exec('ALTER TABLE files ADD COLUMN meeting_artifact TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_calls_meeting ON calls(meeting_id); CREATE INDEX IF NOT EXISTS idx_files_call ON files(call_id)');
  }

  get(id: number): MeetingRow | undefined {
    return this.db.prepare(meetingSelect + ' WHERE e.id = ?').get(id) as MeetingRow | undefined;
  }

  list(filter: MeetingFilter = {}): MeetingRow[] {
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (filter.excludeCancelled) clauses.push('e.cancelled_at IS NULL');
    if (!filter.held && filter.from !== undefined) {
      clauses.push(filter.overlap ? 'e.starts_at + e.duration_minutes * 60000 > ?' : 'e.starts_at >= ?');
      parameters.push(filter.from);
    }
    if (!filter.held && filter.until !== undefined) { clauses.push('e.starts_at < ?'); parameters.push(filter.until); }
    if (filter.upcoming) { clauses.push('e.starts_at >= ?', withoutEndedCall); parameters.push(Date.now()); }
    if (filter.title) {
      clauses.push('instr(file_name_key(e.title), file_name_key(?)) > 0');
      parameters.push(filter.title);
    }
    const members = filter.participantIds ?? [];
    if (filter.held) {
      const call = ['c.meeting_id = e.id', 'c.ended_at IS NOT NULL'];
      if (filter.from !== undefined) { call.push('c.started_at >= ?'); parameters.push(filter.from); }
      if (filter.until !== undefined) { call.push('c.started_at < ?'); parameters.push(filter.until); }
      for (const _ of members) call.push('EXISTS (SELECT 1 FROM call_attendance a WHERE a.call_id = c.id AND a.user_id = ?)');
      parameters.push(...members);
      clauses.push(`EXISTS (SELECT 1 FROM calls c WHERE ${call.join(' AND ')})`);
    } else {
      for (const id of members) {
        clauses.push('EXISTS (SELECT 1 FROM agenda_attendees a WHERE a.event_id = e.id AND a.user_id = ? AND a.removed_at IS NULL)');
        parameters.push(id);
      }
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return this.db.prepare(meetingSelect + where + ' ORDER BY e.starts_at, e.id').all(...parameters) as unknown as MeetingRow[];
  }

  create(organizer: number, input: MeetingInput): MeetingRow {
    const now = Date.now();
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO agenda_events
      (uid, organizer_id, title, agenda, starts_at, duration_minutes, time_zone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), organizer, input.title, input.agenda, input.startsAt, input.durationMinutes, input.timeZone, now, now);
    const id = Number(lastInsertRowid);
    this.setAttendees(id, organizer, input.participantIds, false);
    return this.get(id)!;
  }

  update(current: MeetingRow, input: MeetingInput): MeetingRow {
    this.db.prepare('UPDATE agenda_events SET title = ?, agenda = ?, starts_at = ?, duration_minutes = ?, time_zone = ?, updated_at = ? WHERE id = ?')
      .run(input.title, input.agenda, input.startsAt, input.durationMinutes, input.timeZone, Date.now(), current.id);
    const rescheduled = input.startsAt !== current.starts_at || input.durationMinutes !== current.duration_minutes;
    this.setAttendees(current.id, current.organizer_id, input.participantIds, rescheduled);
    return this.get(current.id)!;
  }

  private setAttendees(id: number, organizer: number, participants: number[], clearResponses: boolean): void {
    const members = [...new Set([organizer, ...participants])];
    this.db.prepare(`UPDATE agenda_attendees SET removed_at = ? WHERE event_id = ? AND removed_at IS NULL
      AND user_id NOT IN (SELECT value FROM json_each(?))`).run(Date.now(), id, JSON.stringify(members));
    if (clearResponses) this.db.prepare(`UPDATE agenda_attendees SET response = 'pending'
      WHERE event_id = ? AND user_id != ? AND removed_at IS NULL`).run(id, organizer);
    for (const member of members) this.addAttendee(id, member, member === organizer ? 'accepted' : 'pending');
  }

  cancel(id: number): void {
    const now = Date.now();
    this.db.prepare('UPDATE agenda_events SET cancelled_at = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL').run(now, now, id);
  }

  attendees(id: number): AttendeeRow[] {
    return this.db.prepare(`SELECT u.id, COALESCE(u.display_name, u.name) AS name, a.response
      FROM agenda_attendees a JOIN users u ON u.id = a.user_id
      WHERE a.event_id = ? AND a.removed_at IS NULL ORDER BY name COLLATE NOCASE, u.id`)
      .all(id) as unknown as AttendeeRow[];
  }

  invited(id: number, user: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM agenda_attendees WHERE event_id = ? AND user_id = ? AND removed_at IS NULL').get(id, user);
  }

  excluded(id: number, user: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM agenda_attendees WHERE event_id = ? AND user_id = ? AND removed_at IS NOT NULL').get(id, user);
  }

  addAttendee(id: number, user: number, response: Rsvp = 'pending'): boolean {
    return Boolean(this.db.prepare(`INSERT INTO agenda_attendees (event_id, user_id, response) VALUES (?, ?, ?)
      ON CONFLICT(event_id, user_id) DO UPDATE SET response = excluded.response, removed_at = NULL
      WHERE agenda_attendees.removed_at IS NOT NULL`).run(id, user, response).changes);
  }

  removeAttendee(id: number, user: number): void {
    this.db.prepare(`INSERT INTO agenda_attendees (event_id, user_id, response, removed_at) VALUES (?, ?, 'pending', ?)
      ON CONFLICT(event_id, user_id) DO UPDATE SET removed_at = excluded.removed_at`).run(id, user, Date.now());
  }

  removeContact(user: number): void {
    this.db.prepare(`UPDATE agenda_attendees SET removed_at = ? WHERE user_id = ? AND removed_at IS NULL
      AND event_id IN (SELECT e.id FROM agenda_events e WHERE e.organizer_id != ? AND e.cancelled_at IS NULL
        AND (${withoutEndedCall} OR ${withOpenCall}))`).run(Date.now(), user, user);
  }

  respond(id: number, user: number, response: Exclude<Rsvp, 'pending'>): boolean {
    return this.db.prepare('UPDATE agenda_attendees SET response = ? WHERE event_id = ? AND user_id = ? AND removed_at IS NULL')
      .run(response, id, user).changes > 0;
  }

  pendingContactIds(eventId: number): number[] {
    return (this.db.prepare('SELECT invitation_id FROM agenda_contact_invites WHERE event_id = ? ORDER BY invitation_id')
      .all(eventId) as { invitation_id: number }[]).map(({ invitation_id }) => invitation_id);
  }

  linkedInvitationIds(): number[] {
    return (this.db.prepare('SELECT DISTINCT invitation_id FROM agenda_contact_invites').all() as { invitation_id: number }[])
      .map(({ invitation_id }) => invitation_id);
  }

  linkContact(eventId: number, invitationId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO agenda_contact_invites (event_id, invitation_id) VALUES (?, ?)').run(eventId, invitationId);
  }

  unlinkContact(eventId: number, invitationId: number): void {
    this.db.prepare('DELETE FROM agenda_contact_invites WHERE event_id = ? AND invitation_id = ?').run(eventId, invitationId);
  }

  discardContactInvitation(invitationId: number): void {
    this.db.prepare('DELETE FROM agenda_contact_invites WHERE invitation_id = ?').run(invitationId);
  }

  acceptContact(invitationId: number, userId: number, activeMeetingId: number | null): MeetingRow[] {
    const meetings = this.db.prepare(meetingSelect + ` WHERE e.cancelled_at IS NULL AND (e.id = ? OR ${withoutEndedCall})
      AND e.id IN (SELECT event_id FROM agenda_contact_invites WHERE invitation_id = ?)`)
      .all(activeMeetingId, invitationId) as unknown as MeetingRow[];
    const added = meetings.filter(({ id }) => this.addAttendee(id, userId));
    this.discardContactInvitation(invitationId);
    return added;
  }

  pendingInvitations(user: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM agenda_events e WHERE ' + pendingInvite)
      .get(Date.now(), user) as { count: number }).count;
  }

  pendingMeetings(user: number): MeetingRow[] {
    return this.db.prepare(meetingSelect + ' WHERE ' + pendingInvite + ' ORDER BY e.starts_at, e.id')
      .all(Date.now(), user) as unknown as MeetingRow[];
  }

  attend(callId: number, userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO call_attendance (call_id, user_id) VALUES (?, ?)').run(callId, userId);
  }

  endInterruptedCalls(): void {
    this.db.prepare('UPDATE calls SET ended_at = ? WHERE meeting_id IS NOT NULL AND ended_at IS NULL').run(Date.now());
  }

  artifacts(id: number): ArtifactRow[] {
    return this.db.prepare(`SELECT f.id, f.name, f.mime, f.size, f.meeting_artifact AS kind
      FROM files f JOIN calls c ON c.id = f.call_id WHERE c.meeting_id = ? AND f.meeting_artifact IS NOT NULL
      ORDER BY f.created_at DESC, f.id DESC`).all(id) as unknown as ArtifactRow[];
  }

  meetingsWithReports(ids: number[]): Set<number> {
    if (!ids.length) return new Set();
    const reports = this.db.prepare(`SELECT DISTINCT c.meeting_id AS id FROM calls c JOIN files f ON f.call_id = c.id
      WHERE f.meeting_artifact = 'report' AND c.meeting_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as { id: number }[];
    return new Set(reports.map(({ id }) => id));
  }
}
