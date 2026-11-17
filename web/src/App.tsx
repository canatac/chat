import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, openRoom, selectedRoom, setToken } from './api';
import Chat from './Chat';
import RoomAdminDialog from './components/RoomAdminDialog';
import Login from './Login';
import { chatColors } from './theme';
import type { Room, RoomMember, RoomSession } from './types';

export default function App() {
  const [token, setTokenState] = useState(getToken);
  const [session, setSession] = useState<RoomSession | null>(null);
  const [invitationToken, setInvitationToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('invitation'));
  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!token || session || invitationToken) return;
    const controller = new AbortController();
    api.me(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSession(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          setToken(null);
          setTokenState(null);
        } else {
          setError('Impossible de charger votre compte.');
        }
      });
    return () => controller.abort();
  }, [token, session, invitationToken, retry]);

  const room = session?.rooms.find((item) => String(item.id) === selectedRoom && item.archivedAt === null)
    ?? session?.rooms.find((item) => item.id === session.roomId && item.archivedAt === null);
  const roomId = room?.id ?? null;

  useEffect(() => {
    if (!invitationToken && roomId !== null && selectedRoom !== String(roomId)) openRoom(roomId);
  }, [roomId, invitationToken]);

  function clearInvitation() {
    const url = new URL(location.href);
    url.hash = '';
    history.replaceState(null, '', url);
    setInvitationToken(null);
  }

  function handleAuth(newToken: string, result: RoomSession) {
    setToken(newToken);
    setTokenState(newToken);
    setSession(result);
    setError(null);
    if (invitationToken) clearInvitation();
  }

  function logout() {
    setToken(null);
    setTokenState(null);
    setSession(null);
    setAdminOpen(false);
    setError(null);
  }

  const updateDirectory = useCallback((rooms: Room[]) => {
    setSession((current) => {
      if (!current) return current;
      const defaultRoom = rooms.find((item) => item.id === current.roomId && item.archivedAt === null)
        ?? rooms.find((item) => item.archivedAt === null);
      return { ...current, rooms, roomId: defaultRoom?.id ?? null };
    });
  }, []);

  function updateRoom(updated: Room) {
    if (!session) return;
    const rooms = [...session.rooms.filter((item) => item.id !== updated.id), updated]
      .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.name.localeCompare(b.name, 'fr'));
    updateDirectory(rooms);
  }

  function updateMember(member: RoomMember) {
    setSession((current) => {
      if (!current || member.id !== current.user.id) return current;
      const { id, name, avatar, role, isBot } = member;
      return { ...current, user: { id, name, avatar, role, isBot } };
    });
  }

  if (invitationToken || !token) {
    return <Login key={invitationToken ?? 'login'} invitationToken={invitationToken} onAuth={handleAuth} onCancelInvitation={clearInvitation} />;
  }
  if (error) {
    return (
      <Stack sx={{ maxWidth: 480, mx: 'auto', px: 2, pt: 8 }} gap={1}>
        <Alert severity="error">{error}</Alert>
        <Button onClick={() => { setError(null); setRetry((attempt) => attempt + 1); }}>Réessayer</Button>
      </Stack>
    );
  }
  if (!session || (room && String(room.id) !== selectedRoom)) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
        <CircularProgress aria-label="Chargement du salon" />
      </Box>
    );
  }

  const { user, rooms } = session;
  return (
    <>
      {room ? (
        <Chat key={`${room.id}:${user.id}`} token={token} user={user} room={room} adminOpen={adminOpen} onAdmin={() => setAdminOpen(true)} onLogout={logout} />
      ) : (
        <Stack sx={{ maxWidth: 480, mx: 'auto', px: 2, pt: 8, color: chatColors.ink }} gap={1.25}>
          <Typography variant="h5" component="h1" fontWeight={700}>Aucun salon actif</Typography>
          <Typography variant="body2">{user.role === 'superadmin' ? 'Créez ou réactivez un salon dans l’administration.' : 'Votre salon est archivé. Contactez son administrateur pour en savoir plus.'}</Typography>
          {user.role === 'superadmin' && <Button variant="contained" onClick={() => setAdminOpen(true)}>Administration</Button>}
          <Button onClick={logout}>Se déconnecter</Button>
        </Stack>
      )}
      {adminOpen && (user.role === 'admin' || user.role === 'superadmin') && (
        <RoomAdminDialog user={user} rooms={rooms} currentRoomId={roomId} onClose={() => setAdminOpen(false)} onRoomChange={updateRoom} onRoomsLoaded={updateDirectory} onMemberChange={updateMember} />
      )}
    </>
  );
}
