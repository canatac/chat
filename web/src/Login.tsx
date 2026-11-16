import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import { Alert, Box, Button, Card, CircularProgress, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { chatColors } from './theme';
import type { RoomSession } from './types';

interface Props {
  invitationToken: string | null;
  onAuth: (token: string, session: RoomSession) => void;
  onCancelInvitation: () => void;
}

export default function Login({ invitationToken, onAuth, onCancelInvitation }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('');
  const [alias, setAlias] = useState('');
  const [email, setEmail] = useState('');
  const [roomName, setRoomName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState<Awaited<ReturnType<typeof api.previewInvitation>> | null>(null);

  useEffect(() => {
    if (!invitationToken) return;
    const controller = new AbortController();
    api.previewInvitation(invitationToken, controller.signal)
      .then(setInvitation)
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [invitationToken]);

  const isLogin = !invitationToken && mode === 'login';
  const isRegister = !invitationToken && mode === 'register';
  const minPassword = isLogin ? 6 : 8;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = invitationToken
        ? await api.acceptInvitation(invitationToken, alias.trim(), password)
        : isRegister
          ? await api.register(alias.trim(), email.trim(), password, roomName.trim())
          : await api.login(identifier.trim(), password);
      onAuth(result.token, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', bgcolor: chatColors.background, p: { xs: 2, sm: 4 } }}>
      <Card
        variant="outlined"
        sx={{
          width: '100%', maxWidth: 440, px: { xs: 2.5, sm: 4 }, py: { xs: 3, sm: 4 },
          borderColor: chatColors.border, borderRadius: 4, boxShadow: '0 18px 64px #142f330d',
        }}
      >
        <Stack gap={2.5}>
          <Box>
            <Box sx={{ display: 'grid', placeItems: 'center', width: 44, height: 44, mb: 1.75, borderRadius: 2.5, color: chatColors.accent, bgcolor: chatColors.accentSoft }}>
              <ForumOutlinedIcon />
            </Box>
            <Typography component="h1" variant="h5" sx={{ fontWeight: 750, letterSpacing: '-0.025em', color: chatColors.ink, overflowWrap: 'anywhere' }}>
              {invitation?.room.name ?? (invitationToken ? 'Invitation à un salon' : 'Chat d’équipe')}
            </Typography>
            {invitation && <Typography variant="body2" sx={{ color: chatColors.muted, mt: 0.75, overflowWrap: 'anywhere' }}>Invitation pour {invitation.email}</Typography>}
          </Box>
          {!invitationToken && (
            <Tabs
              value={mode}
              onChange={(_event, value: 'login' | 'register') => {
                setMode(value);
                setError(null);
                setPassword('');
              }}
              variant="fullWidth"
              aria-label="Accès au chat"
              sx={{ borderBottom: '1px solid ' + chatColors.border, '& .MuiTab-root': { textTransform: 'none', fontWeight: 700 } }}
            >
              <Tab label="Connexion" value="login" disabled={busy} />
              <Tab label="Créer un compte" value="register" disabled={busy} />
            </Tabs>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {invitationToken && !invitation && !error && <CircularProgress size={24} aria-label="Vérification de l’invitation" />}
          {(!invitationToken || invitation) && (
            <Stack component="form" onSubmit={submit} gap={1.75}>
              {isRegister && (
                <>
                  <Typography variant="body2" sx={{ color: chatColors.muted }}>Votre compte crée un salon privé. Vous pourrez ensuite y inviter des membres.</Typography>
                  <TextField label="Nom du salon" value={roomName} onChange={(event) => setRoomName(event.target.value)} required size="small" slotProps={{ htmlInput: { minLength: 2, maxLength: 80 } }} />
                </>
              )}
              {isLogin ? (
                <TextField label="E-mail ou identifiant" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required autoComplete="username" size="small" />
              ) : (
                <>
                  <TextField label="Alias" value={alias} onChange={(event) => setAlias(event.target.value)} required autoComplete="nickname" size="small" slotProps={{ htmlInput: { minLength: 2, maxLength: 40 } }} />
                  {isRegister && <TextField label="Adresse e-mail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" size="small" />}
                </>
              )}
              <TextField
                label="Mot de passe"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                size="small"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                helperText={isLogin ? undefined : '8 caractères minimum'}
                slotProps={{ htmlInput: { minLength: minPassword, maxLength: isLogin ? 100 : 72 } }}
              />
              <Button type="submit" variant="contained" endIcon={<ArrowForwardIcon />} disabled={busy} sx={{ minHeight: 44, mt: 0.5, textTransform: 'none', bgcolor: chatColors.accent }}>
                {isLogin ? 'Se connecter' : isRegister ? 'Créer mon salon' : 'Rejoindre le salon'}
              </Button>
            </Stack>
          )}
          {invitationToken && <Button onClick={onCancelInvitation} disabled={busy} sx={{ alignSelf: 'flex-start', textTransform: 'none' }}>Revenir à l’accueil</Button>}
        </Stack>
      </Card>
    </Box>
  );
}
