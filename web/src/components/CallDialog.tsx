import CallEndIcon from '@mui/icons-material/CallEnd';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import PhoneIcon from '@mui/icons-material/Phone';
import ScreenShareIcon from '@mui/icons-material/ScreenShare';
import StopIcon from '@mui/icons-material/Stop';
import StopScreenShareIcon from '@mui/icons-material/StopScreenShare';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CallInfo, User } from '../types';
import { CallSession } from '../webrtc';
import type { ChatSocket } from '../ws';

interface Props {
  open: boolean;
  onClose: () => void;
  user: User;
  socket: ChatSocket | null;
  call: CallInfo | null;
  onCallChange: (call: CallInfo | null) => void;
}

interface RemoteStream {
  userId: number;
  stream: MediaStream;
}

function normalizeMediaError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not allowed|permission|denied|secure context|insecure|notfound|notreadable/i.test(msg)) {
    return new Error(
      "Accès micro/écran bloqué par le navigateur (contexte non sécurisé ou permission refusée). " +
        "Ouvre l'app en HTTPS (DOMAIN=chat.tondomaine.fr dans .env + docker compose --profile https up -d) " +
        "ou via http://localhost:4000 (tunnel SSH : ssh -L 4000:127.0.0.1:4000 root@<IP_VM>). " +
        "Vérifie aussi que le micro est autorisé pour ce site (icône 🔒 dans la barre d'adresse).",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export default function CallDialog({ open, onClose, user, socket, call, onCallChange }: Props) {
  const [title, setTitle] = useState('');
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [remotes, setRemotes] = useState<RemoteStream[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const knownPeersRef = useRef<Set<number>>(new Set());

  const enterSession = useCallback(
    async (callInfo: CallInfo) => {
      if (!socket) return;
      const session = new CallSession(socket, user.id, {
        onRemoteStream: (userId, stream) =>
          setRemotes((prev) => [...prev.filter((r) => r.userId !== userId), { userId, stream }]),
        onPeerRemoved: (userId) => setRemotes((prev) => prev.filter((r) => r.userId !== userId)),
      });
      sessionRef.current = session;
      knownPeersRef.current = new Set();
      try {
        await session.start();
      } catch (err) {
        sessionRef.current = null;
        throw normalizeMediaError(err);
      }
      for (const p of callInfo.participants) {
        if (p.id !== user.id) {
          knownPeersRef.current.add(p.id);
          await session.connectTo(p.id);
        }
      }
      setJoined(true);
    },
    [socket, user.id],
  );

  useEffect(() => {
    if (!socket) return;
    const handler = (event: { type: string; from?: number; data?: unknown; call?: CallInfo | null }) => {
      if (event.type === 'signal' && typeof event.from === 'number' && sessionRef.current) {
        void sessionRef.current.handleSignal(event.from, event.data);
      }
    };
    socket.onMessage(handler);
  }, [socket]);

  useEffect(() => {
    if (!call || !sessionRef.current || !joined) return;
    const session = sessionRef.current;
    for (const p of call.participants) {
      if (p.id !== user.id && !knownPeersRef.current.has(p.id)) {
        knownPeersRef.current.add(p.id);
        void session.connectTo(p.id);
      }
    }
  }, [call, joined, user.id]);

  useEffect(() => {
    if (!open) {
      sessionRef.current?.leave();
      sessionRef.current = null;
      setJoined(false);
      setRemotes([]);
      setMuted(false);
      setSharing(false);
      setRecording(false);
      setError(null);
      setNote(null);
    }
  }, [open]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.calls.start(title.trim());
      onCallChange(r.call);
      await enterSession(r.call);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!call) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.calls.join();
      onCallChange(r.call);
      await enterSession(r.call);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    setJoined(false);
    setRemotes([]);
    setSharing(false);
    setRecording(false);
    try {
      const r = await api.calls.leave();
      onCallChange(r.call);
    } catch {
      // ignore
    }
  };

  const endCall = async () => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    setJoined(false);
    setRemotes([]);
    try {
      await api.calls.end();
      onCallChange(null);
    } catch {
      // ignore
    }
  };

  const toggleMute = () => {
    const next = !muted;
    sessionRef.current?.setMuted(next);
    setMuted(next);
  };

  const toggleScreen = async () => {
    setError(null);
    try {
      if (sharing) {
        await sessionRef.current?.stopScreenShare();
        setSharing(false);
      } else {
        await sessionRef.current?.startScreenShare();
        setSharing(true);
      }
    } catch (err) {
      setError(normalizeMediaError(err).message);
    }
  };

  const toggleRecord = () => {
    const session = sessionRef.current;
    if (!session || !call) return;
    if (recording) {
      session.stopRecording();
      setRecording(false);
      session.startRecording((blob) => {
        void api
          .uploadRecording(call.id, blob, `appel-${call.id}-${Date.now()}.webm`)
          .then((r) =>
            setNote(
              r.transcriptPending
                ? "Enregistrement envoyé — transcription en cours, à retrouver dans l'espace documentaire"
                : "Enregistrement déposé dans l'espace documentaire (STT non configuré : pas de transcription)",
            ),
          )
          .catch((e) => setError(e instanceof Error ? e.message : "Erreur d'envoi"))
      });
    } else {
      session.startRecording(() => {});
      setRecording(true);
      setNote(null);
    }
  };

  const screenStream = sessionRef.current?.getScreenStream() ?? null;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PhoneIcon color="primary" />
        {call ? `Appel en cours${call.title ? ` — ${call.title}` : ''}` : "Appel d'équipe"}
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        {note && <Alert severity="success" sx={{ mb: 1 }}>{note}</Alert>}
        {!call && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <TextField
              size="small"
              fullWidth
              label="Titre de l'appel (optionnel)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button variant="contained" startIcon={<PhoneIcon />} onClick={start} disabled={busy}>
              Démarrer l'appel
            </Button>
          </Box>
        )}
        {call && (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
              {call.participants.map((p) => (
                <Chip key={p.id} avatar={<Avatar>{p.name.slice(0, 1).toUpperCase()}</Avatar>} label={p.name} color={p.id === call.startedBy.id ? 'primary' : 'default'} size="small" />
              ))}
            </Box>
            {!joined && (
              <Button variant="contained" startIcon={<PhoneIcon />} onClick={join} disabled={busy}>
                Rejoindre l'appel
              </Button>
            )}
            {joined && (
              <>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1, mb: 2 }}>
                  {sharing && screenStream && (
                    <Box>
                      <Typography variant="caption">Votre écran (partagé)</Typography>
                      <video
                        ref={(el) => {
                          if (el && el.srcObject !== screenStream) el.srcObject = screenStream;
                        }}
                        autoPlay
                        playsInline
                        muted
                        style={{ width: '100%', borderRadius: 8, background: '#000' }}
                      />
                    </Box>
                  )}
                  {remotes.map((r) =>
                    r.stream.getVideoTracks().length > 0 ? (
                      <Box key={r.userId}>
                        <Typography variant="caption">Écran partagé (participant {r.userId})</Typography>
                        <video
                          ref={(el) => {
                            if (el && el.srcObject !== r.stream) el.srcObject = r.stream;
                          }}
                          autoPlay
                          playsInline
                          style={{ width: '100%', borderRadius: 8, background: '#000' }}
                        />
                      </Box>
                    ) : (
                      <audio
                        key={r.userId}
                        ref={(el) => {
                          if (el && el.srcObject !== r.stream) el.srcObject = r.stream;
                        }}
                        autoPlay
                      />
                    )
                  )}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  <Tooltip title={muted ? 'Activer le micro' : 'Couper le micro'}>
                    <IconButton color={muted ? 'error' : 'primary'} onClick={toggleMute}>
                      {muted ? <MicOffIcon /> : <MicIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={sharing ? "Arrêter le partage d'écran" : "Partager mon écran"}>
                    <IconButton color={sharing ? 'error' : 'primary'} onClick={() => void toggleScreen()}>
                      {sharing ? <StopScreenShareIcon /> : <ScreenShareIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={recording ? "Arrêter l'enregistrement" : "Enregistrer l'appel"}>
                    <IconButton color={recording ? 'error' : 'primary'} onClick={toggleRecord}>
                      {recording ? <StopIcon /> : <FiberManualRecordIcon />}
                    </IconButton>
                  </Tooltip>
                  {recording && <Chip size="small" color="error" label="REC" />}
                </Box>
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        {call && joined && (
          <Button color="warning" onClick={() => void leave()}>
            Quitter l'appel
          </Button>
        )}
        {call && (
          <Button color="error" startIcon={<CallEndIcon />} onClick={() => void endCall()}>
            Terminer l'appel
          </Button>
        )}
        <Button onClick={onClose}>Fermer</Button>
      </DialogActions>
    </Dialog>
  );
}
