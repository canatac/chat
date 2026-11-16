import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, selectedRoom } from './api';
import AdminDialog from './components/AdminDialog';
import CallDialog from './components/CallDialog';
import ChatComposer from './components/ChatComposer';
import ChatHeader, { type ConnectionStatus } from './components/ChatHeader';
import DocDrawer from './components/DocDrawer';
import MessageRow from './components/MessageRow';
import { chatColors } from './theme';
import type { CallInfo, Message, Room, User } from './types';
import { ChatSocket } from './ws';

const PAGE_SIZE = 50;
const groupWindow = 4 * 60 * 1000;
const calendarDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' });

interface Props {
  token: string;
  user: User;
  room: Room;
  onAdmin: () => void;
  onLogout: () => void;
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

function DayDivider({ date }: { date: Date }) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const day = date.toDateString();

  let label = calendarDate.format(date);
  if (day === today.toDateString()) label = 'Aujourd’hui';
  if (day === yesterday.toDateString()) label = 'Hier';

  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'center', gap: { xs: 0.9, sm: 1.5 }, mt: 2.25,
        '&::before, &::after': { content: '""', height: '1px', flex: 1, bgcolor: chatColors.border },
      }}
    >
      <Typography
        variant="caption"
        component="span"
        sx={{ color: chatColors.muted, fontWeight: 700, px: 1.1, py: 0.35, borderRadius: '7px', bgcolor: '#e8f0f0' }}
      >
        {label}
      </Typography>
    </Box>
  );
}

export default function Chat({ token, user, room, onAdmin, onLogout }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [onlineIds, setOnlineIds] = useState<number[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [socket, setSocket] = useState<ChatSocket | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<'recent' | 'older' | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [docOpen, setDocOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [call, setCall] = useState<CallInfo | null>(null);

  const usersById = useMemo(() => new Map(users.map((member) => [member.id, member])), [users]);
  const displayUser = { ...user, ...usersById.get(user.id) };

  const listRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const historyPosition = useRef<{ id: number; top: number } | null>(null);

  const loadRecent = useCallback(async (signal?: AbortSignal, reconnect = false) => {
    if (!reconnect) setLoading(true);
    try {
      const { messages: recent } = await api.messages(undefined, PAGE_SIZE, signal);
      if (signal?.aborted) return;
      setMessages((previous) => mergeMessages(previous, recent));
      if (!reconnect) setHasMore(recent.length === PAGE_SIZE);
      setHistoryError(null);
    } catch {
      if (!signal?.aborted && !reconnect) setHistoryError('recent');
    } finally {
      if (!signal?.aborted && !reconnect) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const request = new AbortController();
    const activeSocket = new ChatSocket(token, selectedRoom);
    let receivedPresence = false;
    let connectedBefore = false;
    let receivedCall = false;
    let knownUsers = new Set<number>();
    const refreshUsers = () => {
      void api.users()
        .then((result) => {
          if (request.signal.aborted) return;
          knownUsers = new Set(result.users.map((member) => member.id));
          setUsers(result.users);
          if (!receivedPresence) setOnlineIds(result.users.filter((member) => member.online).map((member) => member.id));
        })
        .catch(() => {});
    };
    void loadRecent(request.signal);
    refreshUsers();
    void api.calls.active()
      .then((result) => { if (!request.signal.aborted && !receivedCall) setCall(result.call); })
      .catch(() => {});

    activeSocket.onStatus((online) => {
      if (request.signal.aborted) return;
      setConnection(online ? 'online' : 'offline');
      if (online && connectedBefore) {
        void loadRecent(request.signal, true);
        refreshUsers();
      }
      if (online) connectedBefore = true;
    });
    const unsubscribe = activeSocket.onMessage((event) => {
      if (event.type === 'message' && event.message) {
        const message = event.message;
        setMessages((previous) =>
          previous.some((item) => item.id === message.id) ? previous : mergeMessages(previous, [message]),
        );
      } else if (event.type === 'presence' && Array.isArray(event.online)) {
        receivedPresence = true;
        setOnlineIds(event.online);
        if (event.online.some((id) => !knownUsers.has(id))) refreshUsers();
      } else if (event.type === 'membersChanged') {
        refreshUsers();
      } else if (event.type === 'roomUnavailable') {
        location.reload();
      } else if (event.type === 'call') {
        receivedCall = true;
        setCall(event.call ?? null);
      }
    });

    activeSocket.connect();
    setSocket(activeSocket);
    return () => {
      request.abort();
      unsubscribe();
      activeSocket.close();
    };
  }, [token, loadRecent]);

  const syncScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const nearEnd = list.scrollHeight - list.clientHeight - list.scrollTop < 72;
    followMessages.current = nearEnd;
    setAtEnd(nearEnd);
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const anchor = historyPosition.current;
    if (anchor) {
      historyPosition.current = null;
      const row = list.querySelector('[data-message-id="' + anchor.id + '"]');
      if (row) list.scrollTop += row.getBoundingClientRect().top - anchor.top;
    } else if (followMessages.current) {
      list.scrollTop = list.scrollHeight;
    }
    syncScroll();
  }, [hasMore, loading, messages, syncScroll]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followMessages.current) list.scrollTop = list.scrollHeight;
      syncScroll();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [syncScroll]);

  const jumpToLatest = () => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    followMessages.current = true;
    setAtEnd(true);
  };

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const result = await api.messages(oldest.id, PAGE_SIZE);
      const row = listRef.current?.querySelector('[data-message-id="' + oldest.id + '"]');
      if (row) historyPosition.current = { id: oldest.id, top: row.getBoundingClientRect().top };
      setHasMore(result.messages.length === PAGE_SIZE);
      setMessages((previous) => mergeMessages(previous, result.messages));
    } catch {
      setHistoryError('older');
    } finally {
      setLoadingOlder(false);
    }
  };

  const publish = (message: Message) => {
    jumpToLatest();
    setMessages((previous) =>
      previous.some((item) => item.id === message.id) ? previous : mergeMessages(previous, [message]),
    );
  };

  return (
    <Box sx={{ height: '100vh', '@supports (height: 100dvh)': { height: '100dvh' }, display: 'flex', flexDirection: 'column', bgcolor: chatColors.background }}>
      <ChatHeader
        roomName={room.name}
        user={displayUser}
        users={users}
        onlineIds={onlineIds}
        connection={connection}
        hasCall={Boolean(call)}
        onCall={() => setCallOpen(true)}
        onDocuments={() => setDocOpen(true)}
        onAdmin={onAdmin}
        onStats={() => setStatsOpen(true)}
        onLogout={onLogout}
      />
      <Box component="main" sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <Box
          ref={listRef}
          role="region"
          aria-label="Historique de la conversation"
          tabIndex={0}
          onScroll={syncScroll}
          sx={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', overflowAnchor: 'none', overscrollBehavior: 'contain' }}
        >
          <Box
            sx={{
              maxWidth: 980, mx: 'auto', minHeight: '100%', px: { xs: 1.65, sm: 3 },
              pt: { xs: 0.75, sm: 1 }, pb: { xs: 2.25, sm: 2.75 }, minWidth: 0,
              display: 'flex', flexDirection: 'column',
            }}
          >
            {historyError && (
              <Alert severity="error" sx={{ mt: 1.5 }} action={(
                <Button color="inherit" size="small" onClick={() => void (historyError === 'recent' ? loadRecent() : loadOlder())}>
                  Réessayer
                </Button>
              )}>
                {historyError === 'recent' ? 'Impossible de charger la conversation.' : 'Impossible de charger les messages précédents.'}
              </Alert>
            )}
            {loading && messages.length === 0 && (
              <Box sx={{ m: 'auto' }}><CircularProgress aria-label="Chargement des messages" size={25} /></Box>
            )}
            {!loading && messages.length === 0 && !historyError && (
              <Box sx={{ m: 'auto', textAlign: 'center', p: 2 }}>
                <Box
                  sx={{ width: 52, height: 52, mx: 'auto', mb: 1.5, display: 'grid', placeItems: 'center', borderRadius: '14px', bgcolor: chatColors.accentSoft, color: chatColors.accent }}
                >
                  <ForumOutlinedIcon />
                </Box>
                <Typography component="h2" sx={{ color: chatColors.ink, fontWeight: 750 }}>Aucun message</Typography>
                <Typography variant="body2" sx={{ color: chatColors.muted, mt: 0.5 }}>Écris le premier message de l’équipe.</Typography>
              </Box>
            )}
            {hasMore && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                sx={{
                  alignSelf: 'center', mt: 1.1, borderColor: chatColors.border, bgcolor: chatColors.surface,
                  color: chatColors.accent, textTransform: 'none', fontWeight: 650, borderRadius: '8px',
                }}
              >
                {loadingOlder ? 'Chargement…' : 'Charger les messages précédents'}
              </Button>
            )}
            {messages.length > 0 && (
              <Box role="log" aria-label="Messages" sx={{ mt: 'auto', minWidth: 0 }}>
                {messages.map((message, index) => {
                  const date = new Date(message.createdAt);
                  const previous = messages[index - 1];
                  const previousDate = previous && new Date(previous.createdAt);
                  const newDay = !previousDate || date.toDateString() !== previousDate.toDateString();
                  const groupStart = newDay || previous.user.id !== message.user.id
                    || date.getTime() - previousDate.getTime() > groupWindow;

                  return (
                    <Fragment key={message.id}>
                      {newDay && <DayDivider date={date} />}
                      <MessageRow
                        message={message}
                        sender={usersById.get(message.user.id) ?? message.user}
                        own={message.user.id === user.id}
                        groupStart={groupStart}
                      />
                    </Fragment>
                  );
                })}
              </Box>
            )}
          </Box>
        </Box>
        {!atEnd && messages.length > 0 && (
          <Box sx={{ position: 'absolute', bottom: 12, insetInline: 0, maxWidth: 980, mx: 'auto', px: { xs: 1.65, sm: 3 }, display: 'flex', justifyContent: 'flex-end', pointerEvents: 'none' }}>
            <Button
              variant="contained"
              disableElevation
              startIcon={<ArrowDownwardRoundedIcon fontSize="small" />}
              onClick={jumpToLatest}
              sx={{
                pointerEvents: 'auto', fontWeight: 700, textTransform: 'none', borderRadius: '9px',
                bgcolor: chatColors.accent, '&:hover': { bgcolor: '#0d524b' },
              }}
            >
              Derniers messages
            </Button>
          </Box>
        )}
      </Box>
      <ChatComposer onPublished={publish} />

      <DocDrawer open={docOpen} onClose={() => setDocOpen(false)} socket={socket} />
      {(user.role === 'admin' || user.role === 'superadmin') && <AdminDialog open={statsOpen} onClose={() => setStatsOpen(false)} />}
      <CallDialog
        open={callOpen}
        onClose={() => setCallOpen(false)}
        user={user}
        socket={socket}
        call={call}
        onCallChange={setCall}
      />
    </Box>
  );
}
