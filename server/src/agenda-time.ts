import type { MeetingRow } from './agenda-store.js';

const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: value }); return true; }
  catch { return false; }
}

export function meetingLocalTime(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(time);
  const get = (name: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function meetingInstant(local: string, timeZone: string): number | undefined {
  if (!localPattern.test(local)) return undefined;
  const wall = Date.parse(local + ':00Z');
  if (!Number.isFinite(wall) || meetingLocalTime(wall, 'UTC') !== local) return undefined;
  const offsets = [-129_600_000, 0, 129_600_000].map((distance) => {
    const probe = wall + distance;
    return Date.parse(meetingLocalTime(probe, timeZone) + ':00Z') - probe;
  });
  const matches = offsets.map((offset) => wall - offset).filter((timestamp) => meetingLocalTime(timestamp, timeZone) === local);
  return matches.length ? Math.min(...matches) : undefined;
}

function calendarDate(time: number): string {
  return new Date(time).toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z');
}

function calendarText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

function foldCalendarLine(line: string): string {
  const lines: string[] = [];
  let part = '';
  let length = 0;
  for (const character of line) {
    const bytes = Buffer.byteLength(character);
    if (length + bytes > 75) { lines.push(part); part = ' '; length = 1; }
    part += character;
    length += bytes;
  }
  return [...lines, part].join('\r\n');
}

export function calendarFile(meeting: MeetingRow): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Maelgard//Agenda des appels//FR', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', 'UID:' + meeting.uid + '@maelgard', 'DTSTAMP:' + calendarDate(meeting.updated_at),
    'DTSTART:' + calendarDate(meeting.starts_at), 'DTEND:' + calendarDate(meeting.starts_at + meeting.duration_minutes * 60_000),
    'SUMMARY:' + calendarText(meeting.title), 'DESCRIPTION:' + calendarText(meeting.agenda),
    'STATUS:' + (meeting.cancelled_at === null ? 'CONFIRMED' : 'CANCELLED'), 'END:VEVENT', 'END:VCALENDAR', '',
  ].map(foldCalendarLine).join('\r\n');
}
