import PersonAddOutlinedIcon from '@mui/icons-material/PersonAddOutlined';
import {
  Alert, Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField,
  Typography, useMediaQuery, useTheme,
} from '@mui/material';
import { useState } from 'react';
import { api, invitationUrl } from '../api';
import { chatColors } from '../theme';
import type { Meeting, MeetingResponse, User } from '../types';
import InvitationLink from './InvitationLink';

interface Props {
  meeting: Meeting;
  users: User[];
  canInviteContacts: boolean;
  onChanged: (meeting: Meeting) => void;
  onClose: () => void;
}

export const rsvpLabel: Record<MeetingResponse, string> = {
  pending: 'En attente', accepted: 'Accepté', tentative: 'Peut-être', declined: 'Refusé',
};
const touchAction = { minHeight: 44, flexShrink: 0 };

export default function MeetingParticipantsDialog({ meeting, users, canInviteContacts, onChanged, onClose }: Props) {
  const compact = useMediaQuery(useTheme().breakpoints.down('sm'));
  const [selected, setSelected] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<{ id: number; expiresAt: number; href: string }>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ id: number; name: string } | null>(null);
  const invitedIds = new Set(meeting.participants.map(({ id }) => id));
  const present = new Set(meeting.present.map(({ id }) => id));
  const roster = [...meeting.participants, ...meeting.present.filter(({ id }) => !invitedIds.has(id))
    .map((person) => ({ ...person, response: null }))];
  const unavailable = new Set([...invitedIds, ...present]);
  const options = users.filter((user) => !user.isBot && user.mentionable !== false && !unavailable.has(user.id));
  const disabled = busy || !meeting.canManageParticipants;
  const visibleLink = link && meeting.pendingContacts.some(({ id, expiresAt }) => id === link.id && expiresAt === link.expiresAt && expiresAt > Date.now());

  async function perform(
    action: () => Promise<{ meeting: Meeting; token?: string }>,
    completed: (result: { meeting: Meeting; token?: string }) => string,
  ) {
    if (disabled) return;
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const result = await action();
      onChanged(result.meeting);
      setFeedback(completed(result));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible de modifier les participants.');
    } finally {
      setBusy(false);
    }
  }

  function remove(person: { id: number; name: string }) {
    setConfirm(null);
    void perform(() => api.agenda.removeParticipant(meeting.id, person.id), () => `${person.name} a été retiré de l’appel.`);
  }

  return (
    <>
      <Dialog open onClose={busy ? undefined : onClose} fullScreen={compact} fullWidth maxWidth="sm"
        aria-labelledby="meeting-participants-title">
        <DialogTitle id="meeting-participants-title">Gérer les participants</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            {feedback && <Alert severity="success" role="status">{feedback}</Alert>}
            {!meeting.canManageParticipants && <Alert severity="info">Les participants de cet appel sont désormais en lecture seule.</Alert>}
            <Stack component="form" gap={1} direction={{ xs: 'column', sm: 'row' }} onSubmit={(event) => {
              event.preventDefault();
              if (selected) void perform(() => api.agenda.addParticipant(meeting.id, { userId: selected.id }), () => {
                setSelected(null);
                return `Invitation ajoutée pour ${selected.name}.`;
              });
            }}>
              <Autocomplete options={options} getOptionLabel={(user) => user.name} getOptionKey={(user) => user.id}
                isOptionEqualToValue={(a, b) => a.id === b.id} value={selected} onChange={(_, next) => setSelected(next)}
                fullWidth disabled={disabled} noOptionsText="Aucun contact disponible"
                renderInput={(params) => <TextField {...params} label="Chercher un contact" size="small" />} />
              <Button variant="contained" type="submit" startIcon={<PersonAddOutlinedIcon />} sx={touchAction}
                disabled={disabled || !selected || unavailable.has(selected.id)}>Ajouter à l’appel</Button>
            </Stack>
            {canInviteContacts && (
              <Stack gap={1} sx={{ p: 1.5, bgcolor: chatColors.accentSoft, borderRadius: 2 }}>
                <Typography component="h3" fontWeight={700}>Inviter un nouveau contact</Typography>
                <Typography variant="body2">En acceptant le lien, cette personne rejoindra le salon et sera invitée à l’appel.</Typography>
                <Stack component="form" gap={1} direction={{ xs: 'column', sm: 'row' }} onSubmit={(event) => {
                  event.preventDefault();
                  const address = email.trim().toLowerCase();
                  void perform(() => api.agenda.addParticipant(meeting.id, { email: address }), ({ meeting, token }) => {
                    const contact = meeting.pendingContacts.find(({ email }) => email === address);
                    if (contact && token) setLink({ ...contact, href: invitationUrl(token) });
                    setEmail('');
                    return contact && !token
                      ? 'Invitation rattachée. Pour renouveler son lien, ouvre Membres → Gérer les contacts.'
                      : 'Invitation rattachée à l’appel.';
                  });
                }}>
                  <TextField required size="small" label="Adresse e-mail du contact" type="email" fullWidth
                    disabled={disabled} value={email} onChange={(event) => setEmail(event.target.value)}
                    slotProps={{ htmlInput: { maxLength: 254 } }} />
                  <Button variant="outlined" type="submit" sx={touchAction} disabled={disabled || !email.trim()}>Inviter</Button>
                </Stack>
                {link && visibleLink && <InvitationLink key={link.href} href={link.href} />}
              </Stack>
            )}
            <Divider />
            <Stack component="ul" gap={0.75} sx={{ listStyle: 'none', p: 0, m: 0 }}>
              {roster.map((person) => (
                <Stack component="li" key={person.id} direction="row" alignItems="center" justifyContent="space-between" gap={1}>
                  <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    <Typography>{person.name}</Typography>
                    <Stack direction="row" gap={0.5} useFlexGap flexWrap="wrap">
                      {person.id === meeting.organizerId
                        ? <Chip size="small" label="Organisateur" />
                        : person.response && <Chip size="small" label={rsvpLabel[person.response]} />}
                      {present.has(person.id) && <Chip size="small" color="success" label="Dans l’appel" />}
                    </Stack>
                  </Box>
                  {person.id !== meeting.organizerId && (
                    <Button color="error" aria-label={`Retirer ${person.name} de l’appel`} sx={touchAction} disabled={disabled}
                      onClick={() => present.has(person.id) ? setConfirm(person) : remove(person)}>Retirer</Button>
                  )}
                </Stack>
              ))}
              {meeting.pendingContacts.map((contact) => {
                const label = contact.email ?? 'Nouveau contact';
                return (
                  <Stack component="li" key={`invitation-${contact.id}`} direction="row" alignItems="center"
                    justifyContent="space-between" gap={1}>
                    <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <Typography>{label}</Typography>
                      <Typography variant="caption">{contact.expiresAt > Date.now() ? 'Invitation au salon en attente' : 'Invitation au salon expirée'}</Typography>
                    </Box>
                    <Button sx={touchAction} disabled={disabled} color="error" aria-label={`Retirer l’invitation pour ${label} de l’appel`}
                      onClick={() => void perform(() => api.agenda.removeContactInvitation(meeting.id, contact.id),
                        () => 'Invitation retirée de l’appel.')}>Retirer</Button>
                  </Stack>
                );
              })}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ pb: 'max(8px, env(safe-area-inset-bottom))' }}>
          <Button onClick={onClose} sx={touchAction} disabled={busy}>Fermer</Button>
        </DialogActions>
      </Dialog>
      {confirm && (
        <Dialog open onClose={() => setConfirm(null)} fullWidth maxWidth="xs" aria-labelledby="remove-call-participant-title">
          <DialogTitle id="remove-call-participant-title">Retirer {confirm.name} de l’appel ?</DialogTitle>
          <DialogContent sx={{ overflowWrap: 'anywhere' }}>La personne sera déconnectée de l’appel. Elle reste dans les contacts du salon.</DialogContent>
          <DialogActions sx={{ flexWrap: 'wrap' }}>
            <Button onClick={() => setConfirm(null)} sx={touchAction}>Annuler</Button>
            <Button color="error" onClick={() => remove(confirm)} sx={touchAction}>Confirmer le retrait</Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
