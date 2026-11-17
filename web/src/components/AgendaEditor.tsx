import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import {
  Alert, Autocomplete, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import { useState, type FormEvent } from 'react';
import { addDays, agendaTimeZone, dateAndTime, localDateTime, readLocalDateTime } from '../agenda-time';
import { api } from '../api';
import type { Meeting, MeetingDraft, User } from '../types';

interface Props {
  meeting?: Meeting;
  draft?: MeetingDraft;
  unresolved?: string[];
  suggestedStart: number;
  users: User[];
  ownId: number;
  onClose: () => void;
  onSaved: (meeting: Meeting) => void;
}

const minute = 60_000;
const durationIsValid = (duration: number) => Number.isInteger(duration) && duration >= 1 && duration <= 1440;

export default function AgendaEditor({ meeting, draft, unresolved, suggestedStart, users, ownId, onClose, onSaved }: Props) {
  const initialStart = meeting ? localDateTime(meeting.startsAt) : localDateTime(suggestedStart);
  const organizerId = meeting?.organizerId ?? ownId;
  const [title, setTitle] = useState(meeting?.title ?? draft?.title ?? '');
  const [agenda, setAgenda] = useState(meeting?.agenda ?? draft?.agenda ?? '');
  const [start, setStart] = useState(draft ? draft.localStart ?? '' : initialStart);
  const [duration, setDuration] = useState(String(meeting?.durationMinutes ?? draft?.durationMinutes ?? 30));
  const [participantIds, setParticipantIds] = useState((meeting?.participants.map(({ id }) => id) ?? draft?.participantIds ?? [])
    .filter((id) => id !== organizerId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [slots, setSlots] = useState<number[] | null>(null);
  const [conflict, setConflict] = useState(false);
  const options = users.filter((user) => user.id !== organizerId && user.mentionable !== false && !user.isBot);
  const zone = agendaTimeZone();

  function resetSlots() {
    setSlots(null);
    setConflict(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const sameStart = meeting && start === initialStart;
    const startsAt = sameStart ? meeting.startsAt : readLocalDateTime(start);
    const durationMinutes = Number(duration);
    if (startsAt === undefined || !durationIsValid(durationMinutes)) {
      setError('Renseigne un début valide et une durée entre 1 et 1 440 minutes.');
      return;
    }
    setBusy(true);
    try {
      const input = { title, agenda, startsAt, durationMinutes, timeZone: sameStart ? meeting.timeZone : zone, participantIds };
      const result = meeting ? await api.agenda.edit(meeting.id, input) : await api.agenda.create(input);
      onSaved(result.meeting);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible d’enregistrer la réunion.');
    } finally {
      setBusy(false);
    }
  }

  async function suggestSlots() {
    const durationMinutes = Number(duration);
    if (!durationIsValid(durationMinutes)) { setError('Renseigne d’abord la durée prévue.'); return; }
    setError('');
    resetSlots();
    setChecking(true);
    const requestedStart = readLocalDateTime(start);
    const step = 15 * minute;
    const from = Math.max(requestedStart ?? suggestedStart, Date.now());
    const until = addDays(from, 7);
    const people = new Set([organizerId, ...participantIds]);
    try {
      const { meetings } = await api.agenda.list(Math.min(from, requestedStart ?? from), until + durationMinutes * minute);
      const busyPeriods = meetings.filter((item) => item.id !== meeting?.id && ['scheduled', 'live'].includes(item.status)
        && item.participants.some((person) => people.has(person.id) && person.response !== 'declined'));
      const overlaps = (candidate: number) => busyPeriods.some((item) =>
        candidate < item.startsAt + item.durationMinutes * minute && candidate + durationMinutes * minute > item.startsAt);
      const found: number[] = [];
      for (let candidate = Math.ceil(from / step) * step; candidate < until && found.length < 3; candidate += step) {
        const dayStart = new Date(candidate);
        const dayEnd = new Date(candidate + durationMinutes * minute);
        if (dayStart.getHours() < 8 || dayStart.getDate() !== dayEnd.getDate()
          || dayEnd.getHours() * 60 + dayEnd.getMinutes() > 19 * 60 || overlaps(candidate)) continue;
        found.push(candidate);
        candidate += Math.ceil(durationMinutes / 15) * step - step;
      }
      setConflict(requestedStart !== undefined && overlaps(requestedStart));
      setSlots(found);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible de vérifier les disponibilités.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="agenda-editor-title"
      slotProps={{ paper: { component: 'form', onSubmit: save, sx: { m: { xs: 1, sm: 3 }, width: { xs: 'calc(100% - 16px)', sm: '100%' } } } }}>
      <DialogTitle id="agenda-editor-title">{meeting ? 'Modifier la réunion' : 'Planifier un appel'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {draft && <Alert severity="info">Vérifie le brouillon avant de créer la réunion.</Alert>}
          {!!unresolved?.length && (
            <Alert severity="warning">Participants à retrouver dans le salon&nbsp;: {unresolved.join(', ')}.</Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Titre" required fullWidth value={title} onChange={(event) => setTitle(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 120 } }} />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 2fr) minmax(0, 1fr)' }, gap: 1.5 }}>
            <TextField label="Début" type="datetime-local" fullWidth required value={start} disabled={checking}
              helperText={zone} onChange={(event) => { setStart(event.target.value); resetSlots(); }}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: '1900-01-01T00:00', max: '9999-12-29T23:59' } }} />
            <TextField label="Durée (minutes)" type="number" fullWidth required value={duration} disabled={checking}
              onChange={(event) => { setDuration(event.target.value); resetSlots(); }}
              slotProps={{ htmlInput: { min: 1, max: 1440 } }} />
          </Box>
          <Autocomplete multiple limitTags={3} options={options} getOptionLabel={(user) => user.name} filterSelectedOptions
            getOptionKey={(user) => user.id} isOptionEqualToValue={(option, value) => option.id === value.id}
            value={options.filter(({ id }) => participantIds.includes(id))} disabled={checking}
            onChange={(_event, next) => { setParticipantIds(next.map(({ id }) => id)); resetSlots(); }}
            renderInput={(params) => <TextField {...params} label="Participants invités" />} />
          <Box>
            <Button size="small" startIcon={<AutoAwesomeOutlinedIcon />} disabled={checking || busy} onClick={() => void suggestSlots()}>
              {checking ? 'Recherche en cours…' : 'Suggérer des créneaux'}
            </Button>
            {conflict && <Alert severity="warning" sx={{ mt: 0.75 }}>Un participant est déjà invité à une réunion sur ce créneau.</Alert>}
            {slots && (
              <Stack spacing={0.75} sx={{ mt: 1 }}>
                <Typography variant="caption">
                  {slots.length ? 'Créneaux libres d’après l’agenda du salon.' : 'Aucun créneau libre entre 8 h et 19 h dans les sept prochains jours.'}
                </Typography>
                <Stack direction="row" useFlexGap flexWrap="wrap" spacing={0.75}>
                  {slots.map((slot) => <Button key={slot} variant="outlined" size="small" onClick={() => { setStart(localDateTime(slot)); resetSlots(); }}>
                    {dateAndTime.format(slot)}
                  </Button>)}
                </Stack>
              </Stack>
            )}
          </Box>
          <TextField label="Ordre du jour" multiline minRows={3} fullWidth value={agenda}
            onChange={(event) => setAgenda(event.target.value)} slotProps={{ htmlInput: { maxLength: 8000 } }} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button onClick={onClose} disabled={busy}>Fermer</Button>
        <Button type="submit" variant="contained" disabled={busy || checking}>{meeting ? 'Enregistrer' : 'Créer la réunion'}</Button>
      </DialogActions>
    </Dialog>
  );
}
