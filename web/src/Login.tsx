import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import { Alert, Box, Button, Card, CardContent, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { User } from './types';

interface Props {
  onAuth: (token: string, user: User) => void;
}

export default function Login({ onAuth }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === 'login'
          ? await api.login(name.trim(), password)
          : await api.register(name.trim(), password);
      onAuth(result.token, result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 400 }}>
        <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
            <ChatBubbleOutlineIcon color="primary" />
            <Typography variant="h5" component="h1">
              Chat d'équipe
            </Typography>
          </Box>
          <Tabs
            value={mode}
            onChange={(_, v: 'login' | 'register') => {
              setMode(v);
              setError(null);
            }}
            variant="fullWidth"
          >
            <Tab label="Connexion" value="login" />
            <Tab label="Créer un compte" value="register" />
          </Tabs>
          <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Nom d'utilisateur"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              fullWidth
              size="small"
            />
            <TextField
              label="Mot de passe"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              fullWidth
              size="small"
              slotProps={{ htmlInput: { minLength: 6 } }}
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" disabled={busy || !name.trim() || password.length < 6}>
              {mode === 'login' ? 'Se connecter' : 'Créer le compte'}
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
