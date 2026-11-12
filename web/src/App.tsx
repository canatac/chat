import { Box, CircularProgress } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import Chat from './Chat';
import Login from './Login';
import type { User } from './types';

export default function App() {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => {
        setUser(r.user);
        setLoading(false);
      })
      .catch(() => {
        setToken(null);
        setTokenState(null);
        setLoading(false);
      });
  }, [token]);

  const handleAuth = useCallback((newToken: string, u: User) => {
    setToken(newToken);
    setTokenState(newToken);
    setUser(u);
  }, []);

  const handleLogout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setUser(null);
  }, []);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!token || !user) return <Login onAuth={handleAuth} />;
  return <Chat token={token} user={user} onLogout={handleLogout} />;
}
