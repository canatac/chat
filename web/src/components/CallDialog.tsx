import CallEndIcon from '@mui/icons-material/CallEnd';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import PhoneIcon from '@mui/icons-material/Phone';
import ScreenShareIcon from '@mui/icons-material/ScreenShare';
import SoundIcon from '@mui/icons-material/VolumeUp';
import StopIcon from '@mui/icons-material/Stop';
import StopScreenShareIcon from '@mui/icons-material/StopScreenShare';
import VideocamIcon from '@mui/icons-material/Videocam';
import VideocamOffIcon from '@mui/icons-material/VideocamOff';
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
import { CallSession, loadIceServers } from '../webrtc';
import type { ChatSocket } from '../ws';

interface Props {
  open: boolean;
  onClose: () => void;
  user: User;
  socket: ChatSocket | null;
  call: CallInfo | null;
  onCallChange: (call: CallInfo | null) => void;
}

interface PeerAudio {
  peerId: number;
  stream: MediaStream;
}

interface PeerVideo {
  peerId: number;
  track: MediaStreamTrack;
  key: string;
}

type RecStatus = 'idle' | 'recording' | 'uploading' | 'done' | 'error';

function normalizeMediaError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not allowed|permission|denied/i.test(msg)) {
    return new Error(
      'Micro/caméra refusé par le navigateur. Autorise le micro pour ce site (icône 🔒 dans la barre d\'adresse), puis réessaie.',
    );
  }
  if (/secure context|insecure|not allowed by the user agent/i.test(msg)) {
    return new Error(
      'Contexte non sécurisé : ouvre l\'app en HTTPS (https://…) ou via http://localhost:4000 (tunnel SSH).',
    );
  }
  if (/notfound|notreadable/i.test(msg)) {
    return new Error('Aucun micro/caméra détecté sur cet appareil.');
  }
  return err instanceof Error ? err : new Error(msg);
}

export default function CallDialog({ open, onClose, user, socket, call, onCallChange }: Props) {
  const [title, setTitle] = useState('');
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [camera, setCamera] = useState(false);
  const [peerAudios, setPeerAudios] = useState<PeerAudio[]>([]);
  const [peerVideos, setPeerVideos] = useState<PeerVideo[]>([]);
  const [peerStates, setPeerStates] = useState<Record<number, string>>({});
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [recStatus, setRecStatus] = useState<RecStatus>('idle');
  const sessionRef = useRef<CallSession | null>(null);
  const knownPeersRef = useRef<Set<number>>(new Set());
  const audioElsRef = useRef<Map<number, HTMLAudioElement>>(new Map());
  const lastRecordingIdRef = useRef<string | null>(null);

  const rec = call?.recording ?? null;

  const enterSession = useCallback(
    async (callInfo: CallInfo, stream: MediaStream) => {
      if (!socket) return;
      const session = new CallSession(socket, user.id, callInfo.id, {
        onAudioTrack: (peerId, _track, stream) =>
          setPeerAudios((prev) => [...prev.filter((p) => p.peerId !== peerId), { peerId, stream }]),
        onVideoTrack: (peerId, track, _s) =>
          setPeerVideos((prev) => [
            ...prev.filter((p) => p.key !== `${peerId}-${track.id}`),
            { peerId, track, key: `${peerId}-${track.id}` },
          ]),
        onPeerRemoved: (peerId) => {
          setPeerAudios((prev) => prev.filter((p) => p.peerId !== peerId));
          setPeerVideos((prev) => prev.filter((p) => p.peerId !== peerId));
          setPeerStates((prev) => {
            const next = { ...prev };
            delete next[peerId];
            return next;
          });
        },
        onPeerState: (peerId, state) =>
          setPeerStates((prev) => ({ ...prev, [peerId]: state })),
      });
      session.attachLocalStream(stream);
      sessionRef.current = session;
      knownPeersRef.current = new Set();
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

  const startOrJoin = useCallback(
    async (isStart: boolean) => {
      if (!socket) return;
      setBusy(true);
      setError(null);
      try {
        const micPromise = navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const icePromise = loadIceServers();
        const stream = await micPromise;
        await icePromise;
        const result = isStart ? await api.calls.start(title.trim()) : await api.calls.join();
        onCallChange(result.call);
        await enterSession(result.call, stream);
      } catch (err) {
        setError(normalizeMediaError(err).message);
      } finally {
        setBusy(false);
      }
    },
    [socket, title, enterSession, onCallChange],
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
    session.setCallId(call.id);
    for (const p of call.participants) {
      if (p.id !== user.id && !knownPeersRef.current.has(p.id)) {
        knownPeersRef.current.add(p.id);
        void session.connectTo(p.id);
      }
    }
  }, [call, joined, user.id]);

  useEffect(() => {
    const recNow = call?.recording ?? null;
    const session = sessionRef.current;
    if (!session || !joined) return;
    if (recNow) {
      lastRecordingIdRef.current = recNow.id;
      if (recNow.startedBy.id === user.id && !session.isRecording()) {
        try {
          session.startRecording(() => {});
          setRecStatus('recording');
        } catch (err) {
          setError(err instanceof Error ? err.message : "Erreur d'enregistrement");
        }
      }
    } else if (lastRecordingIdRef.current && session.isRecording() && rec?.startedBy.id === user.id) {
      const rid = lastRecordingIdRef.current;
      lastRecordingIdRef.current = null;
      if (call && call.id) {
        const ext = session.recordingExtension();
        session.stopRecordingWith((blob) => {
          if (!call) return;
          if (blob.size === 0) {
            setError('Enregistrement vide (0 s) — aucun échantillon audio capturé.');
            setRecStatus('error');
            return;
          }
          setRecStatus('uploading');
          void api
            .uploadRecording(call.id, blob, `appel-${call.id}-${Date.now()}.${ext}`, rid)
            .then((r) => {
              setRecStatus('done');
              setNote(
                r.duplicate
                  ? 'Fichier déjà déposé (renvoi ignoré — idempotent).'
                  : r.transcriptPending
                    ? 'Enregistrement déposé — transcription en cours, à retrouver dans l’espace documentaire'
                    : 'Enregistrement déposé dans l’espace documentaire (STT non configuré : pas de transcription)',
              );
            })
            .catch((e) => {
              setRecStatus('error');
              setError(e instanceof Error ? e.message : "Erreur d'envoi — le fichier reste dispo pour un nouvel essai");
            });
        });
      }
    }
  }, [call?.recording, joined, user.id, rec?.startedBy.id, call]);

  useEffect(() => {
    return () => {
      sessionRef.current?.leave();
      sessionRef.current = null;
    };
  }, []);

  const playAllAudio = useCallback(() => {
    let blocked = false;
    for (const el of audioElsRef.current.values()) {
      el.muted = false;
      const p = el.play();
      if (p) p.catch(() => (blocked = true));
    }
    setAudioBlocked(blocked);
  }, []);

  const leave = async () => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    setJoined(false);
    setPeerAudios([]);
    setPeerVideos([]);
    setPeerStates({});
    setSharing(false);
    setRecStatus('idle');
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
    setPeerAudios([]);
    setPeerVideos([]);
    setPeerStates({});
    setRecStatus('idle');
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

  const toggleCamera = async () => {
    setError(null);
    try {
      if (camera) {
        await sessionRef.current?.stopCamera();
        setCamera(false);
      } else {
        await sessionRef.current?.startCamera();
        setCamera(true);
      }
    } catch (err) {
      setError(normalizeMediaError(err).message);
    }
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
    if (!call) return;
    setError(null);
    if (rec) {
      api.calls
        .recordingStop(call.id, rec.id)
        .then((r) => onCallChange(r.call))
        .catch((e) => setError(e instanceof Error ? e.message : 'Erreur'));
    } else {
      if (typeof MediaRecorder === 'undefined') {
        setError('Enregistrement non supporté par ce navigateur (MediaRecorder indisponible). Essaie Safari ou Chrome.');
        return;
      }
      api.calls
        .recordingStart(call.id)
        .then((r) => onCallChange(r.call))
        .catch((e) => setError(e instanceof Error ? e.message : 'Erreur'));
    }
  };

  const screenStream = sessionRef.current?.getScreenStream() ?? null;
  const videoStream = sessionRef.current?.getVideoStream() ?? null;

  const recChip = () => {
    if (!rec) return null;
    if (recStatus === 'uploading') return <Chip size="small" color="warning" label="Envoi en cours…" />;
    if (recStatus === 'done') return <Chip size="small" color="success" label="Déposé ✓" />;
    if (recStatus === 'error') return <Chip size="small" color="error" label="Échec" />;
    return <Chip size="small" color="error" label={`REC — ${rec.startedBy.name}`} />;
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" keepMounted>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PhoneIcon color="primary" />
        {call ? `Appel en cours${call.title ? ` — ${call.title}` : ''}` : "Appel d'équipe"}
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        {note && <Alert severity="success" sx={{ mb: 1 }}>{note}</Alert>}
        {audioBlocked && joined && (
          <Alert
            severity="warning"
            sx={{ mb: 1 }}
            action={
              <Button color="inherit" size="small" startIcon={<SoundIcon />} onClick={playAllAudio}>
                Activer le son
              </Button>
            }
          >
            Lecture audio bloquée par le navigateur (autoplay).
          </Alert>
        )}
        {!call && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <TextField
              size="small"
              fullWidth
              label="Titre de l'appel (optionnel)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button variant="contained" startIcon={<PhoneIcon />} onClick={() => void startOrJoin(true)} disabled={busy}>
              Démarrer l'appel
            </Button>
          </Box>
        )}
        {call && (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2, alignItems: 'center' }}>
              {call.participants.map((p) => (
                <Chip
                  key={p.id}
                  avatar={<Avatar>{p.name.slice(0, 1).toUpperCase()}</Avatar>}
                  label={p.name}
                  color={p.id === call.startedBy.id ? 'primary' : 'default'}
                  size="small"
                />
              ))}
              {Object.entries(peerStates)
                .filter(([, st]) => st === 'failed' || st === 'disconnected')
                .map(([peerId, st]) => (
                  <Chip key={`st-${peerId}`} size="small" color="warning" label={`pair ${peerId}: ${st}`} />
                ))}
            </Box>
            {!joined && (
              <Button variant="contained" startIcon={<PhoneIcon />} onClick={() => void startOrJoin(false)} disabled={busy}>
                Rejoindre l'appel
              </Button>
            )}
            {joined && (
              <>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1, mb: 2 }}>
                  {camera && videoStream && (
                    <Box>
                      <Typography variant="caption">Votre caméra</Typography>
                      <video
                        ref={(el) => {
                          if (el && el.srcObject !== videoStream) el.srcObject = videoStream;
                        }}
                        autoPlay
                        playsInline
                        muted
                        style={{ width: '100%', borderRadius: 8, background: '#000' }}
                      />
                    </Box>
                  )}
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
                  {peerVideos.map((pv) => (
                    <Box key={pv.key}>
                      <Typography variant="caption">Vidéo de {pv.peerId}</Typography>
                      <video
                        ref={(el) => {
                          if (el) {
                            const s = new MediaStream([pv.track]);
                            if (el.srcObject !== s) el.srcObject = s;
                          }
                        }}
                        autoPlay
                        playsInline
                        style={{ width: '100%', borderRadius: 8, background: '#000' }}
                      />
                    </Box>
                  ))}
                  {peerAudios.map((pa) => (
                    <audio
                      key={pa.peerId}
                      playsInline
                      ref={(el) => {
                        if (!el) return;
                        audioElsRef.current.set(pa.peerId, el);
                        el.muted = false;
                        if (el.srcObject !== pa.stream) el.srcObject = pa.stream;
                        const p = el.play();
                        if (p) p.catch(() => setAudioBlocked(true));
                      }}
                      autoPlay
                    />
                  ))}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Tooltip title={muted ? 'Activer le micro' : 'Couper le micro'}>
                    <IconButton color={muted ? 'error' : 'primary'} onClick={toggleMute}>
                      {muted ? <MicOffIcon /> : <MicIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={camera ? 'Éteindre la caméra' : 'Activer la caméra'}>
                    <IconButton color={camera ? 'error' : 'primary'} onClick={() => void toggleCamera()}>
                      {camera ? <VideocamOffIcon /> : <VideocamIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={sharing ? "Arrêter le partage d'écran" : 'Partager mon écran'}>
                    <IconButton color={sharing ? 'error' : 'primary'} onClick={() => void toggleScreen()}>
                      {sharing ? <StopScreenShareIcon /> : <ScreenShareIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={rec ? "Arrêter l'enregistrement (partagé)" : "Enregistrer l'appel (partagé)"}>
                    <IconButton color={rec ? 'error' : 'primary'} onClick={toggleRecord}>
                      {rec ? <StopIcon /> : <FiberManualRecordIcon />}
                    </IconButton>
                  </Tooltip>
                  {recChip()}
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
