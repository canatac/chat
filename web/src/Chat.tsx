import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import MarkChatUnreadOutlinedIcon from '@mui/icons-material/MarkChatUnreadOutlined';
import { Alert, Box, Button, CircularProgress, Snackbar, Typography } from '@mui/material';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, selectedRoom } from './api';
import AdminDialog from './components/AdminDialog';
import AgendaDrawer from './components/AgendaDrawer';
import CallDialog from './components/CallDialog';
import ChatComposer from './components/ChatComposer';
import ChatHeader, { type ConnectionStatus } from './components/ChatHeader';
import DocDrawer from './components/DocDrawer';
import MeetingDocumentDialog from './components/MeetingDocumentDialog';
import MessageRow from './components/MessageRow';
import NotificationsDrawer from './components/NotificationsDrawer';
import SecurityControls from './components/SecurityControls';
import { mentionLabel } from './systemNotifications';
import { chatColors } from './theme';
import type { AgendaAssistantResponse, CallInfo, ConversationActivity, Meeting, MeetingArtifact, MentionNotification, Message, Room, User } from './types';
import useMentionNotifications from './useMentionNotifications';
import useMessageActivity from './useMessageActivity';
import useCallRingtone from './useCallRingtone';
import useSecurity from './useSecurity';
import { ChatSocket } from './ws';

const PAGE_SIZE = 50;
const groupWindow = 4 * 60 * 1000;
const calendarDate = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' });
const noActivity: ConversationActivity = { typing: [], assistantResponding: false };

interface Props {
  token: string;
  user: User;
  room: Room;
  adminOpen: boolean;
  onAdmin: () => void;
  onLogout: () => void;
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

function mergeLiveTail(messages: Message[], tail: Message[]): Message[] {
  const latest = messages[messages.length - 1]?.id ?? 0;
  return mergeMessages(messages, tail.filter(({ id }) => id > latest));
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

export default function Chat({ token, user, room, adminOpen, onAdmin, onLogout }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [onlineIds, setOnlineIds] = useState<number[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [socket, setSocket] = useState<ChatSocket | null>(null);
  const [activity, setActivity] = useState(noActivity);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<'recent' | 'older' | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [docOpen, setDocOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [call, setCall] = useState<CallInfo | null>(null);
  const [callMeeting, setCallMeeting] = useState<Meeting>();
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaResult, setAgendaResult] = useState<AgendaAssistantResponse>();
  const [agendaRevision, setAgendaRevision] = useState(0);
  const [pendingInvitations, setPendingInvitations] = useState(0);
  const [liveInvitation, setLiveInvitation] = useState<Pick<Meeting, 'id' | 'title'>>();
  const [document, setDocument] = useState<MeetingArtifact>();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [openingNotification, setOpeningNotification] = useState<number | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<{ id: number } | null>(null);
  const [historical, setHistorical] = useState(false);
  const [openingUnread, setOpeningUnread] = useState(false);
  const [unreadError, setUnreadError] = useState(false);
  const feed = useMentionNotifications(socket, connection === 'online', room, user.id);
  const ringtone = useCallRingtone(socket, user.id, room.id);
  const security = useSecurity(socket, connection === 'online');
  const [securityOpen, setSecurityOpen] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    void api.agenda.invitations(request.signal).then(({ pending }) => {
      if (!request.signal.aborted) setPendingInvitations(pending);
    }).catch(() => {});
    return () => request.abort();
  }, [agendaRevision]);
  const { dismissToast, read } = feed;

  const usersById = useMemo(() => new Map(users.map((member) => [member.id, member])), [users]);
  const displayUser = { ...user, ...usersById.get(user.id) };
  const canInviteContacts = user.role === 'admin' || user.role === 'superadmin';

  function openMeetingCall(meeting: Meeting) {
    setCallMeeting(meeting);
    setCallOpen(true);
  }

  async function openInvitedCall(id: number) {
    setLiveInvitation(undefined);
    try {
      const { meeting } = await api.agenda.get(id);
      openMeetingCall(meeting);
    } catch {
      setAgendaOpen(true);
    }
  }

  const listRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const historyPosition = useRef<{ id: number; top: number } | null>(null);
  const focusMessage = useRef<number | null>(null);
  const archive = useRef(false);
  const liveTail = useRef<Message[]>([]);
  const timelineVersion = useRef(0);
  const navigationRequest = useRef<AbortController | null>(null);
  const conversationVisible = !(adminOpen || docOpen || statsOpen || callOpen || agendaOpen || notificationsOpen || document || securityOpen || security.review);
  const { receipts, unread, refreshUnread } = useMessageActivity(socket, connection === 'online', messages, user.id, listRef, conversationVisible);
  const typing = activity.typing.filter((person) => person.id !== user.id)
    .map((person) => usersById.get(person.id)?.name ?? person.name);
  const reportTyping = useCallback((active: boolean) => socket?.sendRaw({ type: 'typing', active }), [socket]);

  const loadRecent = useCallback(async (signal?: AbortSignal, reconnect = false, replace = false) => {
    if (archive.current && !replace) return;
    const version = timelineVersion.current;
    if (!reconnect) setLoading(true);
    try {
      const { messages: recent } = await api.messages(undefined, PAGE_SIZE, signal);
      if (signal?.aborted || timelineVersion.current !== version) return;
      if (replace) {
        archive.current = false;
        timelineVersion.current++;
        followMessages.current = true;
        setHistorical(false);
        setHighlighted(null);
        setLoadingOlder(false);
        setLoading(false);
        setMessages(mergeLiveTail(recent, liveTail.current));
      } else setMessages((previous) => mergeMessages(previous, recent));
      if (!reconnect) setHasMore(recent.length === PAGE_SIZE);
      setHistoryError(null);
    } catch {
      if (!signal?.aborted && !reconnect && timelineVersion.current === version) setHistoryError('recent');
    } finally {
      if (!signal?.aborted && !reconnect && timelineVersion.current === version) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const request = new AbortController();
    const activeSocket = new ChatSocket(token, selectedRoom);
    let receivedPresence = false;
    let connectedBefore = false;
    let callVersion = 0;
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
    const refreshCall = () => {
      const version = callVersion;
      void api.calls.active().then((result) => {
        if (!request.signal.aborted && version === callVersion) setCall(result.call);
      }).catch(() => {});
    };
    void loadRecent(request.signal);
    refreshUsers();
    refreshCall();

    activeSocket.onStatus((online) => {
      if (request.signal.aborted) return;
      setConnection(online ? 'online' : 'offline');
      if (!online) setActivity(noActivity);
      if (online && connectedBefore) {
        void loadRecent(request.signal, true);
        refreshUsers();
        refreshCall();
      }
      if (online) {
        connectedBefore = true;
        setAgendaRevision((value) => value + 1);
      }
    });
    const unsubscribe = activeSocket.onMessage((event) => {
      if (event.type === 'message' && event.message) {
        const message = event.message;
        liveTail.current = [...liveTail.current.slice(1 - PAGE_SIZE), message];
        if (archive.current) return;
        setMessages((previous) =>
          previous.some((item) => item.id === message.id) ? previous : mergeMessages(previous, [message]),
        );
      } else if (event.type === 'conversationActivity' && Array.isArray(event.typing)) {
        setActivity({ typing: event.typing, assistantResponding: Boolean(event.assistantResponding) });
      } else if (event.type === 'presence' && Array.isArray(event.online)) {
        receivedPresence = true;
        setOnlineIds(event.online);
        if (event.online.some((id) => !knownUsers.has(id))) refreshUsers();
      } else if (event.type === 'membersChanged') {
        refreshUsers();
        setAgendaRevision((value) => value + 1);
      } else if (event.type === 'roomUnavailable') {
        location.reload();
      } else if (event.type === 'call') {
        callVersion++;
        setCall(event.call ?? null);
        if (!event.call) setLiveInvitation(undefined);
        setAgendaRevision((value) => value + 1);
      } else if (event.type === 'agendaInvitation' && event.meeting) {
        setLiveInvitation(event.meeting);
      } else if (event.type === 'agendaChanged' || event.type === 'docsChanged') {
        setAgendaRevision((value) => value + 1);
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
    const focus = focusMessage.current;
    if (focus !== null) {
      const row = list.querySelector<HTMLElement>('[data-message-id="' + focus + '"]');
      if (row) {
        focusMessage.current = null;
        historyPosition.current = null;
        list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - Math.max(10, (list.clientHeight - row.offsetHeight) / 3);
        row.focus({ preventScroll: true });
        syncScroll();
        return;
      }
    }
    const anchor = historyPosition.current;
    if (anchor) {
      historyPosition.current = null;
      const row = list.querySelector('[data-message-id="' + anchor.id + '"]');
      if (row) list.scrollTop += row.getBoundingClientRect().top - anchor.top;
    } else if (followMessages.current) {
      list.scrollTop = list.scrollHeight;
    }
    syncScroll();
  }, [hasMore, highlighted, loading, messages, notificationsOpen, syncScroll]);

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
    if (archive.current) {
      if (!loading) void loadRecent(undefined, false, true);
      return;
    }
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    followMessages.current = true;
    setAtEnd(true);
  };

  const loadOlder = async () => {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    const version = timelineVersion.current;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const result = await api.messages(oldest.id, PAGE_SIZE);
      if (timelineVersion.current !== version) return;
      const row = listRef.current?.querySelector('[data-message-id="' + oldest.id + '"]');
      if (row) historyPosition.current = { id: oldest.id, top: row.getBoundingClientRect().top };
      setHasMore(result.messages.length === PAGE_SIZE);
      setMessages((previous) => mergeMessages(previous, result.messages));
    } catch {
      if (timelineVersion.current === version) setHistoryError('older');
    } finally {
      if (timelineVersion.current === version) setLoadingOlder(false);
    }
  };

  const publish = (message: Message) => {
    liveTail.current = [...liveTail.current.slice(1 - PAGE_SIZE), message];
    if (archive.current) {
      jumpToLatest();
      return;
    }
    jumpToLatest();
    setMessages((previous) =>
      previous.some((item) => item.id === message.id) ? previous : mergeMessages(previous, [message]),
    );
  };

  const showMessage = useCallback(async (id: number) => {
    navigationRequest.current?.abort();
    const request = new AbortController();
    navigationRequest.current = request;
    try {
      const existing = listRef.current?.querySelector('[data-message-id="' + id + '"]');
      if (!existing) {
        const context = await api.messageWindow(id, request.signal);
        if (request.signal.aborted) return false;
        timelineVersion.current++;
        archive.current = context.hasNewer;
        setHistorical(context.hasNewer);
        setHasMore(context.hasMore);
        setMessages(context.hasNewer ? context.messages : mergeLiveTail(context.messages, liveTail.current));
        setLoading(false);
        setLoadingOlder(false);
        setHistoryError(null);
      }
      followMessages.current = false;
      focusMessage.current = id;
      setHighlighted({ id });
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      throw error;
    } finally {
      if (navigationRequest.current === request) navigationRequest.current = null;
    }
  }, []);

  const openNotification = useCallback(async (item: MentionNotification) => {
    setOpeningNotification(item.id);
    setNotificationError(null);
    try {
      if (!await showMessage(item.messageId)) return;
      setNotificationsOpen(false);
      dismissToast();
      if (!item.readAt) void read({ id: item.id });
    } catch {
      setNotificationError('Impossible d’ouvrir le message.');
      setNotificationsOpen(true);
    } finally {
      setOpeningNotification((current) => current === item.id ? null : current);
    }
  }, [dismissToast, read, showMessage]);

  async function jumpToUnread() {
    if (unread.firstId === null || openingUnread) return;
    setOpeningUnread(true);
    setUnreadError(false);
    try {
      await showMessage(unread.firstId);
    } catch {
      refreshUnread();
      setUnreadError(true);
    } finally {
      setOpeningUnread(false);
    }
  }

  useEffect(() => {
    const request = new AbortController();
    const openFromSystem = async (id: number) => {
      try {
        const { notification } = await api.notification(id, request.signal);
        if (!request.signal.aborted) await openNotification(notification);
      } catch {
        if (!request.signal.aborted) {
          setNotificationError('Impossible d’ouvrir cette notification.');
          setNotificationsOpen(true);
        }
      }
    };
    const fromWorker = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'openMentionNotification' && data.roomId === room.id && Number.isSafeInteger(data.notificationId) && data.notificationId > 0) {
        void openFromSystem(data.notificationId);
      }
    };
    const url = new URL(location.href);
    const id = Number(url.searchParams.get('notification'));
    if (Number.isSafeInteger(id) && id > 0) {
      void openFromSystem(id).then(() => {
        if (!request.signal.aborted) {
          url.searchParams.delete('notification');
          history.replaceState(null, '', url);
        }
      });
    }
    navigator.serviceWorker?.addEventListener('message', fromWorker);
    return () => {
      request.abort();
      navigationRequest.current?.abort();
      navigator.serviceWorker?.removeEventListener('message', fromWorker);
    };
  }, [openNotification, room.id]);

  const canJumpToLatest = (!atEnd || historical) && messages.length > 0;

  return (
    <Box sx={{ height: '100vh', '@supports (height: 100dvh)': { height: '100dvh' }, display: 'flex', flexDirection: 'column', bgcolor: chatColors.background }}>
      <ChatHeader
        roomName={room.name}
        user={displayUser}
        users={users}
        onlineIds={onlineIds}
        connection={connection}
        hasCall={Boolean(call)}
        pendingInvitations={pendingInvitations}
        agendaOpen={agendaOpen}
        unreadNotifications={feed.page.unread}
        notificationsOpen={notificationsOpen}
        ringtoneActive={ringtone.enabled && ringtone.ready}
        onRingtoneToggle={ringtone.toggle}
        onRingtoneTest={() => void ringtone.enableAndTest()}
        onCall={() => { setCallMeeting(undefined); setCallOpen(true); }}
        onAgenda={() => setAgendaOpen(true)}
        onDocuments={() => setDocOpen(true)}
        onNotifications={() => { setNotificationError(null); setNotificationsOpen(true); dismissToast(); void feed.load(); }}
        onAdmin={onAdmin}
        onStats={() => setStatsOpen(true)}
        onSecurity={() => setSecurityOpen(true)}
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
                <Button color="inherit" size="small" onClick={() => void (historyError === 'recent' ? loadRecent(undefined, false, historical) : loadOlder())}>
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
                        highlighted={highlighted?.id === message.id}
                        receipt={receipts.get(message.id)}
                      />
                    </Fragment>
                  );
                })}
              </Box>
            )}
          </Box>
        </Box>
        {(unread.count > 0 || canJumpToLatest) && (
          <Box sx={{ position: 'absolute', bottom: 12, insetInline: 0, maxWidth: 980, mx: 'auto', px: { xs: 1.65, sm: 3 }, display: 'flex', gap: 0.75, flexWrap: 'wrap', justifyContent: 'flex-end', pointerEvents: 'none' }}>
            {unread.count > 0 && (
              <Button
                variant="contained"
                disableElevation
                startIcon={<MarkChatUnreadOutlinedIcon fontSize="small" />}
                onClick={() => void jumpToUnread()}
                disabled={openingUnread}
                sx={{ pointerEvents: 'auto', minHeight: 40, fontWeight: 700, textTransform: 'none', borderRadius: '9px', bgcolor: chatColors.accent }}
              >
                {unread.count} {unread.count === 1 ? 'nouveau message' : 'nouveaux messages'}
              </Button>
            )}
            {canJumpToLatest && (
              <Button
                variant={unread.count ? 'outlined' : 'contained'}
                disableElevation
                startIcon={<ArrowDownwardRoundedIcon fontSize="small" />}
                onClick={jumpToLatest}
                disabled={loading && historical}
                sx={{
                  pointerEvents: 'auto', minHeight: 40, fontWeight: 700, textTransform: 'none', borderRadius: '9px',
                  bgcolor: unread.count ? chatColors.surface : chatColors.accent,
                  '&:hover': { bgcolor: unread.count ? chatColors.accentSoft : '#0d524b' },
                }}
              >
                Derniers messages
              </Button>
            )}
          </Box>
        )}
      </Box>
      <SecurityControls security={security} settingsOpen={securityOpen} onClose={() => setSecurityOpen(false)} />
      <ChatComposer onPublished={publish} members={users} ownId={user.id} onTyping={reportTyping}
        typing={typing} assistantResponding={activity.assistantResponding} onAgenda={(result) => {
        setAgendaResult(result);
        setAgendaOpen(true);
      }} />

      <Snackbar open={unreadError} autoHideDuration={5500} onClose={() => setUnreadError(false)}>
        <Alert severity="error" onClose={() => setUnreadError(false)}>Impossible d’afficher le premier message non lu.</Alert>
      </Snackbar>
      <Snackbar open={Boolean(ringtone.error)} onClose={ringtone.dismissError}>
        <Alert severity="info" onClose={ringtone.dismissError}
          action={<Button color="inherit" size="small" onClick={() => void ringtone.enableAndTest()}>Activer le son</Button>}>
          {ringtone.error}
        </Alert>
      </Snackbar>

      <NotificationsDrawer open={notificationsOpen} onClose={() => setNotificationsOpen(false)} feed={feed}
        opening={openingNotification} openError={notificationError} onOpenMessage={(item) => void openNotification(item)} />
      {feed.toast && (
        <Snackbar key={feed.toast.id} open={!notificationsOpen} autoHideDuration={5500} onClose={dismissToast}
          anchorOrigin={{ horizontal: 'right', vertical: 'top' }} sx={{ mt: { xs: 7, sm: 8 } }}>
          <Alert severity="info" role="status" sx={{ alignItems: 'center', maxWidth: '100%', overflowWrap: 'anywhere' }}
            action={<Button color="inherit" size="small" onClick={() => { if (feed.toast) void openNotification(feed.toast); }}>Voir</Button>}>
            {mentionLabel(feed.toast)}
          </Alert>
        </Snackbar>
      )}
      {liveInvitation && (
        <Snackbar key={liveInvitation.id} open={!callOpen} autoHideDuration={8500} onClose={() => setLiveInvitation(undefined)}>
          <Alert severity="info" role="status" sx={{ alignItems: 'center', maxWidth: '100%', overflowWrap: 'anywhere' }}
            action={<Button color="inherit" onClick={() => void openInvitedCall(liveInvitation.id)} sx={{ minHeight: 44 }}>Ouvrir l’appel</Button>}>
            Invitation à « {liveInvitation.title} »
          </Alert>
        </Snackbar>
      )}

      <DocDrawer open={docOpen} onClose={() => setDocOpen(false)} socket={socket} />
      <AgendaDrawer open={agendaOpen} onClose={() => setAgendaOpen(false)} users={users} ownId={user.id} canInviteContacts={canInviteContacts}
        onCall={openMeetingCall} onRead={setDocument}
        pending={pendingInvitations} revision={agendaRevision} assistantResult={agendaResult} />
      {(user.role === 'admin' || user.role === 'superadmin') && <AdminDialog open={statsOpen} onClose={() => setStatsOpen(false)} />}
      <CallDialog
        open={callOpen}
        onClose={() => setCallOpen(false)}
        user={user}
        users={users}
        socket={socket}
        call={call}
        requestedMeeting={callMeeting}
        agendaRevision={agendaRevision}
        onRead={setDocument}
        onCallChange={setCall}
      />
      {document && <MeetingDocumentDialog key={document.id} file={document} onClose={() => setDocument(undefined)} />}
    </Box>
  );
}
