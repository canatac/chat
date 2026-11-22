import AlternateEmailRoundedIcon from '@mui/icons-material/AlternateEmailRounded';
import AttachFileOutlinedIcon from '@mui/icons-material/AttachFileOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CloseIcon from '@mui/icons-material/Close';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import {
  Alert, Avatar, Box, Button, CircularProgress, IconButton, ListItemButton, ListItemText, Menu, MenuItem, Paper, TextField, Tooltip, Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type SyntheticEvent } from 'react';
import { agendaTimeZone } from '../agenda-time';
import { api } from '../api';
import { formatFileSize } from '../formatFileSize';
import { insertMentionTrigger, mentionAt, mentionsAfterEdit } from '../mentions';
import { chatColors } from '../theme';
import type { AgendaAssistantResponse, Mention, Message, MessageFile, User } from '../types';
import ConversationIndicators from './ConversationIndicators';
import DocumentAnalysis from './DocumentAnalysis';

const MAX_MESSAGE_LENGTH = 4000;

const commands = [
  { name: '/ask', description: 'Interroger les échanges et documents' },
  { name: '/resume', description: 'Résumer les derniers échanges' },
  { name: '/solve', description: 'Proposer des pistes pour un problème' },
  { name: '/lien', description: 'Importer un lien audio' },
  { name: '/agenda', description: 'Planifier un appel ou interroger l’agenda' },
  { name: '/aide', description: 'Afficher les commandes disponibles' },
];
const documentCommands = new Set(['/ask', '/resume', '/solve']);

const toolStyle = {
  width: 39,
  height: 39,
  borderRadius: '9px',
  color: chatColors.muted,
  '&:hover': { color: chatColors.accent, bgcolor: chatColors.accentSoft },
};

function commandIn(text: string) {
  const [firstWord] = text.trimStart().split(/\s+/, 1);
  return commands.find((command) => command.name === firstWord.toLowerCase());
}

interface Props {
  onPublished: (message: Message) => void;
  onAgenda: (result?: AgendaAssistantResponse) => void;
  onTyping: (active: boolean) => void;
  typing: string[];
  assistantResponding: boolean;
  members: User[];
  ownId: number;
  documentRequest?: { nonce: number; file: MessageFile; command: 'ask' | 'resume' };
}

type MentionOption = { userId: number | null; name: string; avatar?: string | null; detail?: string };
const mentionList = 'chat-mention-options';
const optionId = (option: MentionOption) => 'chat-mention-option-' + (option.userId ?? 'room');
const searchKey = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');

export default function ChatComposer({ onPublished, onAgenda, onTyping, typing, assistantResponding, members, ownId, documentRequest }: Props) {
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState<MessageFile | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandAnchor, setCommandAnchor] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const submitPending = useRef(false);
  const typingSentAt = useRef(0);

  const content = draft.trim();
  const attachment = file ?? reference;
  const tooLong = content.length > MAX_MESSAGE_LENGTH;
  const canSubmit = Boolean(content || attachment) && !tooLong && !sending;
  const command = commandIn(draft);
  const agendaCommand = command?.name === '/agenda';
  const agendaPrompt = agendaCommand ? content.slice('/agenda'.length).trim() : '';

  useEffect(() => {
    if (!documentRequest) return;
    setFile(null);
    setReference(documentRequest.file);
    setDraft((previous) => {
      const command = commandIn(previous);
      const text = command ? previous.trimStart().slice(command.name.length).trimStart() : previous;
      return '/' + documentRequest.command + ' ' + text;
    });
    setMentions([]);
    setError(null);
    setCaret(null);
    textInput.current?.focus();
  }, [documentRequest]);

  useEffect(() => {
    if (!reference || !['pending', 'processing'].includes(reference.analysis?.status ?? '')) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.fileDetail(reference.id).then(({ file: loaded }) => {
        if (!cancelled) setReference(loaded);
      }).catch(() => {});
    }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [reference?.id, reference?.analysis?.status]);
  const options = useMemo(() => {
    const people = members.filter((member) => member.mentionable !== false && !member.isBot);
    const counts = new Map<string, number>();
    for (const { name } of people) counts.set(searchKey(name), (counts.get(searchKey(name)) ?? 0) + 1);
    const list: MentionOption[] = people.filter(({ id }) => id !== ownId).map(({ id, name, avatar }) => ({
      userId: id, name, avatar, detail: (counts.get(searchKey(name)) ?? 0) > 1 || searchKey(name) === 'room' ? `Membre ${id}` : undefined,
    }));
    list.unshift({ userId: null, name: 'room', detail: 'Tout le salon' });
    return list;
  }, [members, ownId]);
  const activeMention = !sending && !commandAnchor && !dismissed ? mentionAt(draft, caret, mentions) : null;
  const suggestions = activeMention ? options.filter(({ name }) => searchKey(name).includes(searchKey(activeMention.query))).slice(0, 9) : [];
  const highlighted = suggestions[highlight];
  const highlightedId = highlighted ? optionId(highlighted) : undefined;

  useEffect(() => {
    if (highlightedId) document.getElementById(highlightedId)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedId]);

  const stopTyping = useCallback(() => {
    if (typingSentAt.current === 0) return;
    typingSentAt.current = 0;
    onTyping(false);
  }, [onTyping]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) stopTyping(); };
    window.addEventListener('blur', stopTyping);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', stopTyping);
      document.removeEventListener('visibilitychange', onVisibility);
      stopTyping();
    };
  }, [stopTyping]);

  function reportTyping(next: string) {
    if (!next.trim()) {
      stopTyping();
    } else if (Date.now() - typingSentAt.current >= 1500) {
      typingSentAt.current = Date.now();
      onTyping(true);
    }
  }

  function changeDraft(next: string, position: number | null) {
    reportTyping(next);
    setMentions(mentionsAfterEdit(draft, next, mentions));
    setDraft(next);
    setCaret(position);
    setHighlight(-1);
    setDismissed(false);
  }

  function focusAt(position: number) {
    textInput.current?.focus();
    requestAnimationFrame(() => {
      textInput.current?.focus();
      textInput.current?.setSelectionRange(position, position);
    });
  }

  function chooseMention(option: MentionOption) {
    if (!activeMention) return;
    const { start, end } = activeMention;
    const label = '@' + option.name;
    const existing = draft.slice(start, start + label.length);
    const extra = searchKey(existing) === searchKey(label)
      ? Math.max(0, start + label.length - end)
      : (draft.slice(end).match(/^[\p{L}\p{M}\p{N}_-]+/u)?.[0].length ?? 0);
    const suffix = draft.slice(end + extra);
    const separator = !suffix || /^[\p{L}\p{M}\p{N}_@]/u.test(suffix) ? ' ' : '';
    const next = draft.slice(0, start) + label + separator + suffix;
    reportTyping(next);
    const nextCaret = start + label.length + (suffix.startsWith(' ') ? 1 : separator.length);
    setMentions([...mentionsAfterEdit(draft, next, mentions).filter((item) => item.end <= start || item.start >= start + label.length),
      { start, end: start + label.length, userId: option.userId }]);
    setDraft(next);
    setCaret(nextCaret);
    setHighlight(-1);
    setDismissed(false);
    focusAt(nextCaret);
  }

  function insertAt() {
    const input = textInput.current;
    const next = insertMentionTrigger(draft, input?.selectionStart ?? draft.length, input?.selectionEnd ?? draft.length);
    changeDraft(next.text, next.caret);
    focusAt(next.caret);
  }

  const submit = async () => {
    if (!canSubmit || submitPending.current) return;
    if (attachment && command && !documentCommands.has(command.name)) {
      setError('Utilise /ask, /resume ou /solve avec cette pièce jointe.');
      return;
    }
    submitPending.current = true;
    stopTyping();
    setSending(true);
    setError(null);
    try {
      if (agendaCommand) {
        onAgenda(agendaPrompt ? await api.agenda.assistant(agendaPrompt, agendaTimeZone()) : undefined);
      } else {
        const start = draft.length - draft.trimStart().length;
        const hints = mentions.filter((mention) => mention.start >= start && mention.end <= start + content.length)
          .map((mention) => ({ ...mention, start: mention.start - start, end: mention.end - start }));
        const result = file ? await api.uploadFile(file, content, true, undefined, hints) : await api.send(content || `📎 ${reference!.name}`, hints, reference ? [reference.id] : []);
        if (!result.message) throw new Error('Le serveur n’a pas confirmé la publication.');
        onPublished(result.message);
      }
      setFile(null);
      setReference(null);
      setDraft('');
      setMentions([]);
      setCaret(null);
      setHighlight(-1);
    } catch (failure) {
      const detail = failure instanceof Error && !(failure instanceof TypeError) ? failure.message : '';
      const message = agendaCommand ? 'Impossible d’interroger l’agenda.'
        : attachment ? 'Impossible d’envoyer la pièce jointe.' : 'Impossible d’envoyer le message.';
      setError(detail ? message + ' ' + detail : message);
    } finally {
      submitPending.current = false;
      setSending(false);
    }
  };

  const selectCommand = (name: string) => {
    const previous = commandIn(draft);
    const text = draft.trimStart();
    const next = name + ' ' + (previous ? text.slice(previous.name.length).trimStart() : text);
    changeDraft(next, next.length);
    setCommandAnchor(null);
    focusAt(next.length);
  };

  return (
    <Box
      component="footer"
      sx={{
        borderTop: '1px solid ' + chatColors.border,
        bgcolor: chatColors.surface,
        flexShrink: 0,
        pt: { xs: 1, sm: 1.65 },
        pb: 'max(10px, env(safe-area-inset-bottom))',
      }}
    >
      <Box sx={{ maxWidth: 980, px: { xs: 1.5, sm: 3 }, mx: 'auto' }}>
        <ConversationIndicators typing={typing} assistantResponding={assistantResponding} agendaPending={sending && Boolean(agendaPrompt)} />
        {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 0.9 }}>{error}</Alert>}
        <Paper
          component="form"
          elevation={0}
          aria-label="Rédaction du message"
          aria-busy={sending}
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setCaret(null);
              stopTyping();
            }
          }}
          sx={{
            position: 'relative',
            px: 1,
            py: 0.6,
            border: '1px solid ' + chatColors.border,
            bgcolor: chatColors.surface,
            borderRadius: '14px',
            '&:focus-within': { borderColor: '#76a99f', boxShadow: '0 0 0 2px #e5f3ef' },
          }}
        >
          {suggestions.length > 0 && (
            <Paper
              id={mentionList}
              role="listbox"
              aria-label="Suggestions de mentions"
              elevation={4}
              sx={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 3, width: 'min(360px, 100%)', maxHeight: 'min(262px, 43dvh)', overflowY: 'auto', overscrollBehavior: 'contain', p: 0.5, borderRadius: '12px', border: '1px solid ' + chatColors.border }}
            >
              {suggestions.map((option, index) => (
                <ListItemButton
                  key={optionId(option)}
                  id={optionId(option)}
                  role="option"
                  aria-selected={highlight === index}
                  tabIndex={-1}
                  selected={highlight === index}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => chooseMention(option)}
                  sx={{ gap: 1, minHeight: 44, borderRadius: '8px', py: 0.4 }}
                >
                  <Avatar src={option.avatar ?? undefined} aria-hidden="true" sx={{ width: 30, height: 30, bgcolor: chatColors.accentSoft, color: chatColors.accent, fontSize: 14, fontWeight: 750 }}>
                    {option.userId === null ? '@' : option.name.slice(0, 1).toUpperCase()}
                  </Avatar>
                  <ListItemText sx={{ minWidth: 0 }} primary={'@' + option.name} secondary={option.detail} slotProps={{ primary: { noWrap: true, fontWeight: 700 } }} />
                </ListItemButton>
              ))}
            </Paper>
          )}
          {attachment && (
            <Box
              sx={{
                mx: 0.65, my: 0.65, p: 0.75,
                display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap',
                borderRadius: '9px', bgcolor: chatColors.background, border: '1px solid ' + chatColors.border,
              }}
            >
              <InsertDriveFileOutlinedIcon fontSize="small" sx={{ ml: 0.25, color: chatColors.accent }} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography noWrap title={attachment.name} sx={{ fontSize: '0.83rem', fontWeight: 700, color: chatColors.ink }}>
                  {attachment.name}
                </Typography>
                <Typography component="span" variant="caption" sx={{ color: chatColors.muted }}>{formatFileSize(attachment.size)}</Typography>
                {reference && <DocumentAnalysis analysis={reference.analysis} details />}
              </Box>
              <IconButton aria-label="Retirer la pièce jointe" size="small" disabled={sending} onClick={() => { setFile(null); setReference(null); }} sx={toolStyle}>
                <CloseIcon fontSize="small" />
              </IconButton>
              <Box sx={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
                <Button size="small" disabled={sending} onClick={() => selectCommand('/resume')}>Résumer le fichier</Button>
                <Button size="small" disabled={sending} onClick={() => selectCommand('/ask')}>Analyser / questionner</Button>
                <Typography variant="caption" sx={{ color: chatColors.muted }}>Extraction locale puis contrôle LinGuard avant l’IA.</Typography>
              </Box>
            </Box>
          )}
          <TextField
            value={draft}
            multiline
            minRows={1}
            maxRows={5}
            fullWidth
            size="small"
            inputRef={textInput}
            placeholder={attachment ? 'Ajouter une question ou choisir Résumer le fichier…' : 'Écrire un message…'}
            error={tooLong}
            helperText={tooLong ? 'Le message dépasse la limite de 4 000 caractères.' : attachment && command?.name === '/resume' ? 'Résumer le document joint après son extraction locale' : command?.description}
            onChange={(event) => changeDraft(event.target.value, event.target.selectionStart)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) {
                event.preventDefault();
                if (event.key === 'Escape') setDismissed(true);
                else if (event.key === 'ArrowDown') setHighlight((highlight + 1) % suggestions.length);
                else setHighlight(highlight <= 0 ? suggestions.length - 1 : highlight - 1);
                return;
              }
              if (event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              if (highlighted) chooseMention(highlighted);
              else void submit();
            }}
            slotProps={{
              htmlInput: {
                'aria-label': 'Écrire un message',
                'aria-autocomplete': 'list',
                'aria-controls': suggestions.length ? mentionList : undefined,
                'aria-activedescendant': highlightedId,
                onFocus: (event: FocusEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart),
                onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => {
                  const { selectionStart, selectionEnd } = event.currentTarget;
                  const position = selectionStart === selectionEnd ? selectionStart : null;
                  if (position !== caret) { setCaret(position); setHighlight(-1); setDismissed(false); }
                },
              },
              input: { readOnly: sending },
            }}
            sx={{
              '& .MuiOutlinedInput-notchedOutline': { border: 0 },
              '& .MuiOutlinedInput-root': { px: 0.85, pt: 0.95, pb: 0.55, fontSize: '1rem', lineHeight: 1.52, color: chatColors.ink },
              '& textarea::placeholder': { color: chatColors.muted, opacity: 1 },
              '& .MuiFormHelperText-root': { mx: 0.85, mt: 0.25 },
            }}
          />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.35 }}>
            <input
              hidden
              ref={fileInput}
              type="file"
              aria-label="Fichier à joindre"
              onChange={(event) => {
                const selected = event.target.files?.[0];
                event.target.value = '';
                if (selected) { setFile(selected); setReference(null); setError(null); }
              }}
            />
            <Tooltip title="Joindre un fichier">
              <span>
                <IconButton aria-label="Joindre un fichier à la conversation" disabled={sending} onClick={() => fileInput.current?.click()} sx={toolStyle}>
                  <AttachFileOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Mentionner quelqu’un">
              <span>
                <IconButton aria-label="Mentionner quelqu’un" disabled={sending} onMouseDown={(event) => event.preventDefault()} onClick={insertAt} sx={toolStyle}>
                  <AlternateEmailRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Commandes de l’assistant">
              <span>
                <IconButton
                  aria-label="Commandes de l’assistant"
                  disabled={sending}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(commandAnchor)}
                  onClick={(event) => setCommandAnchor(event.currentTarget)}
                  sx={toolStyle}
                >
                  <AutoAwesomeOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" sx={{ mr: 1.1, color: chatColors.muted, display: { xs: 'none', sm: 'inline' } }}>
              Maj + Entrée pour un saut de ligne
            </Typography>
            <Button
              aria-label="Envoyer"
              variant="contained"
              disableElevation
              type="submit"
              disabled={!canSubmit}
              endIcon={sending ? <CircularProgress size={16} color="inherit" /> : <SendRoundedIcon fontSize="small" />}
              sx={{
                minHeight: 38, px: 1.45, borderRadius: '9px', textTransform: 'none', fontWeight: 720,
                bgcolor: chatColors.accent, '&:hover': { bgcolor: '#0d524b' },
              }}
            >
              {sending ? 'Envoi…' : 'Envoyer'}
            </Button>
          </Box>
        </Paper>
        <Menu
          open={Boolean(commandAnchor)}
          anchorEl={commandAnchor}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          onClose={() => setCommandAnchor(null)}
          slotProps={{ paper: { sx: { maxWidth: 'calc(100vw - 28px)', mb: 1, borderRadius: '12px' } } }}
        >
          {commands.map((entry) => (
            <MenuItem key={entry.name} disabled={Boolean(attachment) && !documentCommands.has(entry.name)} onClick={() => selectCommand(entry.name)}>
              <ListItemText
                primary={entry.name}
                secondary={attachment && entry.name === '/resume' ? 'Résumer le document joint' : entry.description}
                slotProps={{ primary: { sx: { fontWeight: 720, color: chatColors.accent } } }}
              />
            </MenuItem>
          ))}
        </Menu>
      </Box>
    </Box>
  );
}
