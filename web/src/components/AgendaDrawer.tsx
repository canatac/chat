import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import {
  Alert, Box, Button, Chip, Drawer, IconButton, LinearProgress, List, ListItem, ListItemButton, Stack, TextField, Typography,
} from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { addDays, agendaTimeZone, dateAndTime, shortDate, startOfWeek, timeOfDay } from '../agenda-time';
import { api } from '../api';
import { chatColors } from '../theme';
import type { AgendaAssistantResponse, Meeting, MeetingArtifact, User } from '../types';
import AgendaEditor from './AgendaEditor';
import AgendaMeeting, { meetingStatus } from './AgendaMeeting';
import MarkdownContent from './MarkdownContent';

interface Props {
  open: boolean;
  onClose: () => void;
  onCall: (meeting: Meeting) => void;
  onRead: (file: MeetingArtifact) => void;
  users: User[];
  ownId: number;
  canInviteContacts: boolean;
  pending: number;
  revision: number;
  assistantResult: AgendaAssistantResponse | undefined;
}

type AgendaView = 'agenda' | 'invites' | 'assistant';
type Editor = { meeting?: Meeting; fromAssistant?: Extract<AgendaAssistantResponse, { kind: 'draft' }> };

function MeetingList({ meetings, ownId, onSelect }: { meetings: Meeting[]; ownId: number; onSelect: (meeting: Meeting) => void }) {
  return (
    <List disablePadding sx={{ display: 'grid', gap: 1 }}>
      {meetings.map((item) => {
        const invite = item.status === 'scheduled' && item.participants.some((person) => person.id === ownId && person.response === 'pending');
        const status = invite ? 'À confirmer' : meetingStatus[item.status];
        return (
          <ListItem key={item.id} disablePadding>
            <ListItemButton onClick={() => onSelect(item)}
              sx={{
                gap: 1.25, alignItems: 'flex-start', borderRadius: 2, border: '1px solid ' + chatColors.border,
                bgcolor: chatColors.surface, px: { xs: 1.2, sm: 1.6 }, py: 1.15, minWidth: 0,
              }}>
              <Box aria-hidden="true" sx={{ display: { xs: 'none', sm: 'grid' }, placeItems: 'center', width: 38, height: 38, flexShrink: 0,
                color: chatColors.accent, bgcolor: chatColors.accentSoft, borderRadius: 2 }}>
                <CalendarMonthOutlinedIcon fontSize="small" />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" useFlexGap flexWrap="wrap" sx={{ gap: 0.55, justifyContent: 'space-between' }}>
                  <Typography component="span" sx={{ color: chatColors.ink, fontWeight: 700, overflowWrap: 'anywhere' }}>{item.title}</Typography>
                  <Chip label={status} size="small" color={invite ? 'warning' : item.status === 'live' ? 'success' : 'default'} />
                </Stack>
                <Typography variant="body2" sx={{ color: chatColors.muted, mt: 0.3, fontVariantNumeric: 'tabular-nums' }}>
                  {dateAndTime.format(item.startsAt)} – {timeOfDay.format(item.startsAt + item.durationMinutes * 60_000)}
                  {' · '}{item.durationMinutes} min
                </Typography>
                {item.artifacts.some(({ kind }) => kind === 'report') && (
                  <Typography variant="caption" sx={{ color: chatColors.accent }}>Compte rendu disponible</Typography>
                )}
              </Box>
            </ListItemButton>
          </ListItem>
        );
      })}
    </List>
  );
}

export default function AgendaDrawer({ open, onClose, onCall, onRead, users, ownId, canInviteContacts, pending, revision, assistantResult }: Props) {
  const [view, setView] = useState<AgendaView>('agenda');
  const [week, setWeek] = useState(startOfWeek);
  const [onlyMine, setOnlyMine] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [detail, setDetail] = useState<Meeting>();
  const [editor, setEditor] = useState<Editor>();
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<AgendaAssistantResponse>();
  const [asking, setAsking] = useState(false);
  const [assistantError, setAssistantError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const activeId = detail?.id;

  function select(meeting: Meeting) {
    setError('');
    setDetail(meeting);
  }

  function changeView(next: AgendaView) {
    setDetail(undefined);
    setError('');
    setMeetings([]);
    setView(next);
    setRefresh((value) => value + 1);
  }

  function selectWeek(next: number) {
    if (week === next) return;
    setMeetings([]);
    setWeek(next);
  }

  function onSaved(meeting: Meeting) {
    setEditor(undefined);
    select(meeting);
    setWeek(startOfWeek(meeting.startsAt));
    setView('agenda');
    setRefresh((value) => value + 1);
  }

  useEffect(() => {
    if (!assistantResult) return;
    setDetail(undefined);
    setError('');
    setAssistantError('');
    setView('assistant');
    setResult(assistantResult);
    if (assistantResult.kind === 'draft') setEditor({ fromAssistant: assistantResult });
  }, [assistantResult]);

  useEffect(() => {
    if (!open || view === 'assistant' || activeId !== undefined) return;
    const request = new AbortController();
    setLoading(true);
    setError('');
    const load = view === 'invites' ? api.agenda.pending(request.signal) : api.agenda.list(week, addDays(week, 7), request.signal);
    void load.then((data) => {
      if (!request.signal.aborted) setMeetings(data.meetings);
    }).catch(() => {
      if (!request.signal.aborted) setError('Impossible de charger l’agenda.');
    }).finally(() => {
      if (!request.signal.aborted) setLoading(false);
    });
    return () => request.abort();
  }, [open, view, week, activeId, revision, refresh]);

  useEffect(() => {
    if (!open || activeId === undefined) return;
    const request = new AbortController();
    void api.agenda.get(activeId, request.signal).then(({ meeting }) => {
      if (!request.signal.aborted) setDetail(meeting);
    }).catch(() => {
      if (!request.signal.aborted) setError('Impossible d’actualiser cette réunion.');
    });
    return () => request.abort();
  }, [open, activeId, revision, refresh]);

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || asking) return;
    setAssistantError('');
    setAsking(true);
    try {
      const answer = await api.agenda.assistant(prompt, agendaTimeZone());
      setResult(answer);
      if (answer.kind === 'draft') setEditor({ fromAssistant: answer });
    } catch (failure) {
      setAssistantError(failure instanceof Error ? failure.message : 'Impossible d’interroger l’agenda.');
    } finally {
      setAsking(false);
    }
  }

  const visibleMeetings = onlyMine && view === 'agenda'
    ? meetings.filter((meeting) => meeting.participants.some(({ id }) => id === ownId)) : meetings;
  const firstMorning = new Date(week);
  firstMorning.setHours(9);
  const defaultStart = Math.max(Math.ceil((Date.now() + 60_000) / 1_800_000) * 1_800_000, firstMorning.getTime());
  const bounds = shortDate.format(week) + ' – ' + shortDate.format(addDays(week, 6));

  return (
    <>
      <Drawer anchor="right" open={open} onClose={onClose} slotProps={{
        paper: { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'agenda-title', sx: { width: 'min(100%, 690px)', bgcolor: chatColors.background } },
      }}>
        <Box sx={{ bgcolor: chatColors.surface, borderBottom: '1px solid ' + chatColors.border, px: { xs: 1.5, sm: 3 },
          pt: 'max(12px, env(safe-area-inset-top))', pb: 1.4 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Box sx={{ color: chatColors.accent, bgcolor: chatColors.accentSoft, width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 2 }}>
              <CalendarMonthOutlinedIcon />
            </Box>
            <Typography id="agenda-title" component="h2" variant="h6" sx={{ flex: 1, fontWeight: 730, color: chatColors.ink }}>
              Agenda des appels
            </Typography>
            <IconButton onClick={onClose} aria-label="Fermer l’agenda"><CloseRoundedIcon /></IconButton>
          </Stack>
          <Stack direction="row" spacing={0.6} useFlexGap flexWrap="wrap" alignItems="center">
            <Button size="small" variant={view === 'agenda' ? 'contained' : 'text'} onClick={() => changeView('agenda')}>Semaine</Button>
            <Button size="small" variant={view === 'invites' ? 'contained' : 'text'} onClick={() => changeView('invites')}>
              Invitations{pending ? ` (${pending})` : ''}
            </Button>
            <Button size="small" startIcon={<AutoAwesomeOutlinedIcon />} variant={view === 'assistant' ? 'contained' : 'text'}
              onClick={() => changeView('assistant')}>Assistant</Button>
            <Button size="small" startIcon={<AddRoundedIcon />} onClick={() => setEditor({})} sx={{ ml: { sm: 'auto' } }}>Planifier</Button>
          </Stack>
        </Box>
        <Box sx={{ overflowY: 'auto', overscrollBehavior: 'contain', p: { xs: 1.5, sm: 3 }, flex: 1, pb: 'max(24px, env(safe-area-inset-bottom))' }}>
          {error && <Alert severity="error" sx={{ mb: 1.5 }}
            action={<Button color="inherit" size="small" onClick={() => setRefresh((value) => value + 1)}>Réessayer</Button>}>{error}</Alert>}
          {detail ? (
            <>
              <Button startIcon={<ArrowBackRoundedIcon />} size="small" sx={{ mb: 1 }} onClick={() => { setDetail(undefined); setError(''); }}>
                Retour
              </Button>
              <AgendaMeeting key={detail.id} meeting={detail} ownId={ownId} users={users} canInviteContacts={canInviteContacts}
                onEdit={() => setEditor({ meeting: detail })}
                onCall={() => onCall(detail)} onRead={onRead} onChanged={(changed) => {
                  if (changed) setDetail((current) => current?.id === changed.id ? changed : current);
                  setRefresh((value) => value + 1);
                }} />
            </>
          ) : view === 'assistant' ? (
            <Stack spacing={2}>
              <Stack component="form" spacing={1} onSubmit={ask}>
                <TextField label="Demande à l’assistant" value={prompt} onChange={(event) => setPrompt(event.target.value)} fullWidth multiline
                  minRows={2} placeholder="Combien de réunions ai-je eues avec Camille ce mois-ci ?"
                  slotProps={{ htmlInput: { maxLength: 4000 } }} />
                <Box><Button type="submit" variant="contained" disabled={asking || !prompt.trim()}>Envoyer</Button></Box>
              </Stack>
              {asking && <LinearProgress aria-label="Interprétation de la demande" />}
              {assistantError && <Alert severity="error">{assistantError}</Alert>}
              {result?.kind === 'draft' && (
                <Box><Button onClick={() => setEditor({ fromAssistant: result })}>Revoir le brouillon</Button></Box>
              )}
              {result && result.kind !== 'draft' && (
                <Alert severity="info" role="status" sx={{ '& .MuiAlert-message': { minWidth: 0, width: '100%' } }}>
                  <MarkdownContent content={result.answer} />
                </Alert>
              )}
              {result?.kind === 'results' && (
                <>
                  {result.total > result.meetings.length && (
                    <Typography variant="body2">{result.meetings.length} réunions affichées sur {result.total}. Précise la période pour affiner.</Typography>
                  )}
                  <MeetingList meetings={result.meetings} ownId={ownId} onSelect={select} />
                </>
              )}
            </Stack>
          ) : (
            <>
              {view === 'agenda' && (
                <Stack spacing={1} sx={{ mb: 1.5 }}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <IconButton aria-label="Semaine précédente" onClick={() => selectWeek(addDays(week, -7))}><ChevronLeftRoundedIcon /></IconButton>
                    <IconButton aria-label="Semaine suivante" onClick={() => selectWeek(addDays(week, 7))}><ChevronRightRoundedIcon /></IconButton>
                    <Typography component="h3" variant="body2" sx={{ flex: 1, fontWeight: 700, color: chatColors.ink }}>{bounds}</Typography>
                  </Stack>
                  <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                    <Button size="small" onClick={() => selectWeek(startOfWeek())}>Aujourd’hui</Button>
                    <Button size="small" variant={onlyMine ? 'outlined' : 'text'} aria-pressed={onlyMine} onClick={() => setOnlyMine((value) => !value)}>
                      Mes réunions
                    </Button>
                  </Stack>
                </Stack>
              )}
              {loading && <LinearProgress aria-label="Chargement de l’agenda" sx={{ mb: 1 }} />}
              <MeetingList meetings={visibleMeetings} ownId={ownId} onSelect={select} />
              {!loading && !error && !visibleMeetings.length && (
                <Typography sx={{ color: chatColors.muted, py: 3, textAlign: 'center' }}>
                  {view === 'invites' ? 'Aucune invitation en attente.' : 'Aucun appel prévu cette semaine.'}
                </Typography>
              )}
            </>
          )}
        </Box>
      </Drawer>
      {open && editor && (
        <AgendaEditor meeting={editor.meeting} draft={editor.fromAssistant?.draft} unresolved={editor.fromAssistant?.unresolved}
          suggestedStart={defaultStart} users={users} ownId={ownId} onClose={() => setEditor(undefined)} onSaved={onSaved} />
      )}
    </>
  );
}
