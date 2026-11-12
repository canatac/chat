import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import ForumIcon from '@mui/icons-material/Forum';
import LogoutIcon from '@mui/icons-material/Logout';
import PhoneIcon from '@mui/icons-material/Phone';
import SendIcon from '@mui/icons-material/Send';
import {
  AppBar,
  Avatar,
  Badge,
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import AdminDialog from './components/AdminDialog';
import CallDialog from './components/CallDialog';
import DocDrawer from './components/DocDrawer';
import MessageRow from './components/MessageRow';
import PresenceMenu from './components/PresenceMenu';
import type { CallInfo, Message, User } from './types';
import { ChatSocket } from './ws';

const PAGE_SIZE = 50;

const COMMAND_HINTS: Record<string, string> = {
  '/resume': 'Compte-rendu des derniers messages',
  '/solve': 'Suggestions de solutions pour un problème',
  '/ask': 'Question à l\u2019assistant (chatroom + documents déposés)',
  '/aide': 'Liste des commandes disponibles',
};

interface Props {
  token: string;
  user: User;
  onLogout: () => void;
}

export default function Chat({ token, user, onLogout }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [onlineIds, setOnlineIds] = useState<number[]>([]);
  const [input, setInput] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [connected, setConnected] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [call, setCall] = useState<CallInfo | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nearBottomRef = useRef(true);
  const socketRef = useRef<ChatSocket | null>(null);
  const [socket, setSocket] = useState<ChatSocket | null>(null);

  useEffect(() => {
    api
      .messages(undefined, PAGE_SIZE)
      .then((r) => {
        setMessages(r.messages);
        setHasMore(r.messages.length === PAGE_SIZE);
      })
      .catch(() => {});
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch(() => {});
    api
      .calls.active()
      .then((r) => setCall(r.call))
      .catch(() => {});
    const socket = new ChatSocket(token);
    socket.onStatus(setConnected);
    socket.onMessage((event) => {
      if (event.type === 'message' && event.message) {
        setMessages((prev) =>
          prev.some((m) => m.id === event.message?.id) ? prev : [...prev, event.message as Message],
        );
      } else if (event.type === 'presence' && Array.isArray(event.online)) {
        setOnlineIds(event.online);
      } else if (event.type === 'call') {
        setCall(event.call ?? null);
      }
    });
    socket.connect();
    socketRef.current = socket;
    setSocket(socket);
    return () => socket.close();
  }, [token]);

  useEffect(() => {
    const el = listRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadMore = async () => {
    const oldest = messages[0];
    if (!oldest) return;
    const r = await api.messages(oldest.id, PAGE_SIZE);
    setHasMore(r.messages.length === PAGE_SIZE);
    setMessages((prev) => [...r.messages, ...prev]);
  };

  const send = () => {
    const content = input.trim();
    if (!content) return;
    if (socketRef.current?.isOpen()) {
      socketRef.current.sendMessage(content);
    } else {
      api
        .send(content)
        .then((r) => setMessages((prev) => [...prev, r.message]))
        .catch(() => {});
    }
    setInput('');
  };

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const text = input.trim();
    try {
      await api.uploadFile(f, text, true);
      setInput('');
    } catch {
      // l'upload a échoué : le message texte reste envoyable
    }
  };

  const hint = useMemo(() => {
    const key = Object.keys(COMMAND_HINTS).find((k) => input.trimStart().startsWith(k));
    return key ? COMMAND_HINTS[key] : null;
  }, [input]);

  return (
    <Box sx={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" enableColorOnDark>
        <Toolbar>
          <ForumIcon sx={{ mr: 1 }} />
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Chat d'équipe
          </Typography>
          <Tooltip title={call ? "Appel en cours" : "Appel d'équipe"}>
            <IconButton color="inherit" onClick={() => setCallOpen(true)}>
              <Badge variant="dot" color="error" invisible={!call}>
                <PhoneIcon />
              </Badge>
            </IconButton>
          </Tooltip>
          <PresenceMenu users={users} onlineIds={onlineIds} />
          <Chip
            label={connected ? 'en ligne' : 'hors ligne'}
            size="small"
            sx={{ mr: 1, bgcolor: connected ? '#dcf8c6' : '#eeeeee', color: '#333333' }}
          />
          <Tooltip title="Espace documentaire">
            <IconButton color="inherit" onClick={() => setDocOpen(true)}>
              <FolderSharedIcon />
            </IconButton>
          </Tooltip>
          {user.isAdmin && (
            <Tooltip title="Administration (conso LLM)">
              <IconButton color="inherit" onClick={() => setAdminOpen(true)}>
                <AdminPanelSettingsIcon />
              </IconButton>
            </Tooltip>
          )}
          <Chip
            avatar={<Avatar>{user.name.slice(0, 1).toUpperCase()}</Avatar>}
            label={user.name}
            variant="outlined"
            sx={{ mx: 1, color: 'inherit', borderColor: 'rgba(255,255,255,0.5)' }}
          />
          <Tooltip title="Se déconnecter">
            <IconButton color="inherit" onClick={onLogout}>
              <LogoutIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Box
        ref={listRef}
        onScroll={onScroll}
        sx={{
          flex: 1,
          overflowY: 'auto',
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        {hasMore && (
          <Button size="small" onClick={loadMore} sx={{ alignSelf: 'center' }}>
            Charger les messages précédents
          </Button>
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} own={m.user.id === user.id} />
        ))}
      </Box>

      <Paper elevation={3} sx={{ p: 1 }}>
        {hint && (
          <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
            {hint}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
          <input hidden type="file" ref={fileRef} onChange={onFilePicked} />
          <Tooltip title="Joindre un fichier à la conversation">
            <IconButton color="primary" onClick={() => fileRef.current?.click()}>
              <AttachFileIcon />
            </IconButton>
          </Tooltip>
          <TextField
            fullWidth
            multiline
            maxRows={4}
            size="small"
            placeholder="Écrivez un message… (/aide pour les commandes LLM)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <IconButton color="primary" onClick={send} disabled={!input.trim() || !connected}>
            <SendIcon />
          </IconButton>
        </Box>
      </Paper>

      <DocDrawer open={docOpen} onClose={() => setDocOpen(false)} />
      <AdminDialog open={adminOpen} onClose={() => setAdminOpen(false)} />
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
