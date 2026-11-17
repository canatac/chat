export const agendaTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function readLocalDateTime(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && localDateTime(timestamp) === value ? timestamp : undefined;
}

export function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function startOfWeek(timestamp = Date.now()): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return addDays(date.getTime(), -(date.getDay() + 6) % 7);
}

export const shortDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
export const fullDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full' });
export const dateAndTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
export const timeOfDay = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' });
