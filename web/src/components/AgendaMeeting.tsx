import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PhoneOutlinedIcon from '@mui/icons-material/PhoneOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Link, Stack, Typography,
} from '@mui/material';
import { useState } from 'react';
import { agendaTimeZone, fullDate, timeOfDay } from '../agenda-time';
import { api, saveBlob, saveFile } from '../api';
import { chatColors } from '../theme';
import type { Meeting, MeetingArtifact, User } from '../types';
import MeetingParticipantsDialog, { rsvpLabel } from './MeetingParticipantsDialog';

export const meetingStatus: Record<Meeting['status'], string> = {
  scheduled: 'Planifiée', live: 'En cours', held: 'Terminée', past: 'Créneau passé', cancelled: 'Annulée',
};

const responses = [
  { value: 'accepted', label: 'Accepter' },
  { value: 'tentative', label: 'Peut-être' },
  { value: 'declined', label: 'Refuser' },
] as const;
const artifactLabel: Record<MeetingArtifact['kind'], string> = {
  recording: 'Télécharger l’enregistrement', transcript: 'Lire la transcription', report: 'Lire le compte rendu', summary: 'Lire le résumé',
};

interface Props {
  meeting: Meeting;
  ownId: number;
  users: User[];
  canInviteContacts: boolean;
  onEdit: () => void;
  onCall: () => void;
  onRead: (file: MeetingArtifact) => void;
  onChanged: (meeting?: Meeting) => void;
}

export default function AgendaMeeting({ meeting, ownId, users, canInviteContacts, onEdit, onCall, onRead, onChanged }: Props) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [editParticipants, setEditParticipants] = useState(false);
  const response = meeting.participants.find(({ id }) => id === ownId)?.response;
  const canRespond = response && meeting.organizerId !== ownId && ['scheduled', 'live'].includes(meeting.status);
  const openCall = meeting.canEnter;
  const transcript = meeting.artifacts.find(({ kind }) => kind === 'transcript');
  const report = meeting.artifacts.find(({ kind }) => kind === 'report');
  const end = meeting.startsAt + meeting.durationMinutes * 60_000;
  const zone = agendaTimeZone();

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible de terminer l’action.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <Box>
        <Typography component="h3" variant="h5" sx={{ fontWeight: 720, mb: 0.6, color: chatColors.ink, overflowWrap: 'anywhere' }}>
          {meeting.title}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
          <Chip size="small" label={meetingStatus[meeting.status]} color={meeting.status === 'live' ? 'success' : 'default'} />
          <Typography sx={{ color: chatColors.muted, fontVariantNumeric: 'tabular-nums' }}>
            {fullDate.format(meeting.startsAt)}, {timeOfDay.format(meeting.startsAt)} – {timeOfDay.format(end)}
            {' · '}{meeting.durationMinutes} min
          </Typography>
        </Stack>
        <Typography variant="caption" sx={{ color: chatColors.muted }}>
          {zone}{meeting.timeZone !== zone ? ` (réunion créée en ${meeting.timeZone})` : ''}
        </Typography>
      </Box>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        {openCall && <Button variant="contained" startIcon={<PhoneOutlinedIcon />} onClick={onCall}>
          {meeting.status === 'held' ? 'Rouvrir l’appel' : 'Ouvrir l’appel'}
        </Button>}
        {meeting.canEdit && <Button startIcon={<EditOutlinedIcon />} onClick={onEdit} disabled={busy}>Modifier</Button>}
        <Button startIcon={<CalendarMonthOutlinedIcon />} disabled={busy}
          onClick={() => void run(async () => saveBlob(await api.agenda.calendar(meeting.id), `appel-${meeting.id}.ics`))}>
          Exporter en .ics
        </Button>
      </Stack>
      {canRespond && (
        <Box>
          <Typography component="h4" sx={{ fontWeight: 700, mb: 0.75 }}>Ma réponse</Typography>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {responses.map(({ value, label }) => (
              <Button key={value} size="small" variant={value === response ? 'contained' : 'outlined'} aria-pressed={value === response}
                disabled={busy} onClick={() => void run(async () => {
                  onChanged((await api.agenda.respond(meeting.id, value)).meeting);
                })}>
                {label}
              </Button>
            ))}
          </Stack>
        </Box>
      )}
      <Divider />
      <Box>
        <Typography component="h4" sx={{ fontWeight: 700, mb: 0.75 }}>Ordre du jour</Typography>
        <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{meeting.agenda || 'Aucun point ajouté.'}</Typography>
      </Box>
      <Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} useFlexGap flexWrap="wrap" sx={{ mb: 0.75 }}>
          <Typography component="h4" sx={{ fontWeight: 700 }}>Participants</Typography>
          {meeting.canManageParticipants && (
            <Button startIcon={<GroupOutlinedIcon />} onClick={() => setEditParticipants(true)} sx={{ minHeight: 44 }}>
              Gérer les participants
            </Button>
          )}
        </Stack>
        <Stack component="ul" spacing={0.75} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {meeting.participants.map((person) => (
            <Box component="li" key={person.id} sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{person.name}{person.id === ownId ? ' (moi)' : ''}</Typography>
              <Chip size="small" label={person.id === meeting.organizerId ? 'Organisateur' : rsvpLabel[person.response]}
                color={person.id !== meeting.organizerId && person.response === 'accepted' ? 'success' : 'default'} />
            </Box>
          ))}
          {meeting.pendingContacts.map((contact) => (
            <Box component="li" key={`contact-${contact.id}`} sx={{ display: 'flex', gap: 1, alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{contact.email ?? 'Nouveau contact'}</Typography>
              <Chip size="small" label={contact.expiresAt > Date.now() ? 'Invitation au salon' : 'Lien expiré'} />
            </Box>
          ))}
        </Stack>
      </Box>
      <Divider />
      <Box>
        <Typography component="h4" sx={{ fontWeight: 700, mb: 0.75 }}>Documents de l’appel</Typography>
        {!report && <Typography variant="body2" sx={{ mb: 1, color: chatColors.muted }}>Aucun compte rendu disponible.</Typography>}
        <Stack component="ul" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {meeting.artifacts.map((file) => (
            <Box component="li" key={file.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
              {file.kind === 'recording' ? <DownloadOutlinedIcon fontSize="small" color="action" /> : <DescriptionOutlinedIcon fontSize="small" color="action" />}
              <Box sx={{ minWidth: 0 }}>
                <Link component="button" type="button" onClick={() => {
                  if (file.kind === 'recording') void run(() => saveFile(file));
                  else onRead(file);
                }} disabled={busy} sx={{ textAlign: 'left' }}>
                  {artifactLabel[file.kind]}
                </Link>
                <Typography variant="caption" component="div" sx={{ color: chatColors.muted, overflowWrap: 'anywhere' }}>{file.name}</Typography>
              </Box>
            </Box>
          ))}
        </Stack>
        {!report && transcript && (
          <Button sx={{ mt: 1 }} size="small" variant="outlined" disabled={busy}
            onClick={() => void run(async () => { await api.derive(transcript.id, 'cr'); onChanged(); })}>
            Générer le compte rendu
          </Button>
        )}
      </Box>
      {meeting.canEdit && (
        <Box><Button color="error" disabled={busy} onClick={() => setCancel(true)}>Annuler la réunion</Button></Box>
      )}
      {editParticipants && (
        <MeetingParticipantsDialog meeting={meeting} users={users} canInviteContacts={canInviteContacts}
          onChanged={onChanged} onClose={() => setEditParticipants(false)} />
      )}
      <Dialog open={cancel} onClose={() => setCancel(false)} aria-labelledby="agenda-cancel-title" fullWidth maxWidth="xs">
        <DialogTitle id="agenda-cancel-title">Annuler la réunion</DialogTitle>
        <DialogContent>Les invités verront « {meeting.title} » comme annulée dans l’agenda.</DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap' }}>
          <Button onClick={() => setCancel(false)}>Revenir</Button>
          <Button color="error" onClick={() => {
            setCancel(false);
            void run(async () => onChanged((await api.agenda.cancel(meeting.id)).meeting));
          }}>
            Confirmer l’annulation
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
