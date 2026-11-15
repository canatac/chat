import AttachFileOutlinedIcon from '@mui/icons-material/AttachFileOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CloseIcon from '@mui/icons-material/Close';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import {
  Alert, Box, Button, CircularProgress, IconButton, ListItemText, Menu, MenuItem, Paper, TextField, Tooltip, Typography,
} from '@mui/material';
import { useRef, useState } from 'react';
import { api } from '../api';
import { formatFileSize } from '../formatFileSize';
import { chatColors } from '../theme';
import type { Message } from '../types';

const MAX_MESSAGE_LENGTH = 4000;

const commands = [
  { name: '/ask', description: 'Interroger les échanges et documents' },
  { name: '/resume', description: 'Résumer les derniers échanges' },
  { name: '/solve', description: 'Proposer des pistes pour un problème' },
  { name: '/lien', description: 'Importer un lien audio' },
  { name: '/aide', description: 'Afficher les commandes disponibles' },
];

const toolStyle = {
  width: 39,
  height: 39,
  borderRadius: '9px',
  color: chatColors.muted,
  '&:hover': { color: chatColors.accent, bgcolor: chatColors.accentSoft },
};

function commandIn(text: string) {
  const [firstWord] = text.trimStart().split(/\s+/, 1);
  return commands.find((command) => command.name === firstWord);
}

interface Props {
  onPublished: (message: Message) => void;
}

export default function ChatComposer({ onPublished }: Props) {
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandAnchor, setCommandAnchor] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const submitPending = useRef(false);

  const content = draft.trim();
  const tooLong = content.length > MAX_MESSAGE_LENGTH;
  const canSubmit = Boolean(content || file) && !tooLong && !sending;
  const command = file ? undefined : commandIn(draft);

  const submit = async () => {
    if (!canSubmit || submitPending.current) return;
    submitPending.current = true;
    setSending(true);
    setError(null);
    try {
      const result = file ? await api.uploadFile(file, content, true) : await api.send(content);
      if (!result.message) throw new Error('Le serveur n’a pas confirmé la publication.');
      onPublished(result.message);
      setFile(null);
      setDraft('');
    } catch (failure) {
      const detail = failure instanceof Error && !(failure instanceof TypeError) ? failure.message : '';
      const message = file ? 'Impossible d’envoyer la pièce jointe.' : 'Impossible d’envoyer le message.';
      setError(detail ? message + ' ' + detail : message);
    } finally {
      submitPending.current = false;
      setSending(false);
    }
  };

  const selectCommand = (name: string) => {
    const previous = commandIn(draft);
    const text = draft.trimStart();
    setDraft(name + ' ' + (previous ? text.slice(previous.name.length).trimStart() : text));
    setCommandAnchor(null);
    requestAnimationFrame(() => textInput.current?.focus());
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
        {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 0.9 }}>{error}</Alert>}
        <Paper
          component="form"
          elevation={0}
          aria-label="Rédaction du message"
          aria-busy={sending}
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
          sx={{
            px: 1,
            py: 0.6,
            border: '1px solid ' + chatColors.border,
            bgcolor: chatColors.surface,
            borderRadius: '14px',
            '&:focus-within': { borderColor: '#76a99f', boxShadow: '0 0 0 2px #e5f3ef' },
          }}
        >
          {file && (
            <Box
              sx={{
                mx: 0.65, my: 0.65, p: 0.75,
                display: 'flex', alignItems: 'center', gap: 1,
                borderRadius: '9px', bgcolor: chatColors.background, border: '1px solid ' + chatColors.border,
              }}
            >
              <InsertDriveFileOutlinedIcon fontSize="small" sx={{ ml: 0.25, color: chatColors.accent }} />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography noWrap title={file.name} sx={{ fontSize: '0.83rem', fontWeight: 700, color: chatColors.ink }}>
                  {file.name}
                </Typography>
                <Typography component="span" variant="caption" sx={{ color: chatColors.muted }}>{formatFileSize(file.size)}</Typography>
              </Box>
              <IconButton aria-label="Retirer la pièce jointe" size="small" disabled={sending} onClick={() => setFile(null)} sx={toolStyle}>
                <CloseIcon fontSize="small" />
              </IconButton>
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
            placeholder={file ? 'Ajouter un message (facultatif)…' : 'Écrire un message…'}
            error={tooLong}
            helperText={tooLong ? 'Le message dépasse la limite de 4 000 caractères.' : command?.description}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void submit();
            }}
            slotProps={{
              htmlInput: { 'aria-label': 'Écrire un message' },
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
                if (selected) { setFile(selected); setError(null); }
              }}
            />
            <Tooltip title="Joindre un fichier">
              <span>
                <IconButton aria-label="Joindre un fichier à la conversation" disabled={sending} onClick={() => fileInput.current?.click()} sx={toolStyle}>
                  <AttachFileOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Commandes de l’assistant">
              <span>
                <IconButton
                  aria-label="Commandes de l’assistant"
                  disabled={Boolean(file) || sending}
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
            <MenuItem key={entry.name} onClick={() => selectCommand(entry.name)}>
              <ListItemText
                primary={entry.name}
                secondary={entry.description}
                slotProps={{ primary: { sx: { fontWeight: 720, color: chatColors.accent } } }}
              />
            </MenuItem>
          ))}
        </Menu>
      </Box>
    </Box>
  );
}
