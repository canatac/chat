import { useCallback, useEffect, useRef, useState } from 'react';
import { CallRingtone, ringOnce } from './callRingtone';
import type { ChatSocket } from './ws';

function soundEnabled(key: string): boolean {
  try { return localStorage.getItem(key) !== 'false'; } catch { return true; }
}

export default function useCallRingtone(socket: ChatSocket | null, userId: number, roomId: number) {
  const preferenceKey = 'chat.call-sound.' + userId;
  const [enabled, setEnabled] = useState(() => soundEnabled(preferenceKey));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<CallRingtone | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    const ringtone = audio.current ?? new CallRingtone(setReady);
    audio.current = ringtone;
    const unlock = () => {
      if (!ringtone.isReady()) void ringtone.unlock().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
      audio.current = null;
      ringtone.close();
    };
  }, [enabled]);

  useEffect(() => {
    const syncPreference = (event: StorageEvent) => {
      if (event.key === preferenceKey || event.key === null) setEnabled(soundEnabled(preferenceKey));
    };
    window.addEventListener('storage', syncPreference);
    return () => window.removeEventListener('storage', syncPreference);
  }, [preferenceKey]);

  useEffect(() => socket?.onMessage((event) => {
    const call = event.call;
    if (event.type !== 'callStarted' || !call || call.startedBy.id === userId || !enabled || !soundEnabled(preferenceKey)) return;
    if (!audio.current?.isReady()) {
      setError('Nouvel appel. Active le son pour entendre la sonnerie.');
      return;
    }
    const ringtone = audio.current;
    void ringOnce('chat.call-sound-played.' + userId + '.' + roomId, call.id,
      () => audio.current === ringtone && soundEnabled(preferenceKey) && ringtone.play())
      .catch(() => setError('Impossible de jouer la sonnerie. Active le son pour réessayer.'));
  }), [enabled, preferenceKey, roomId, socket, userId]);

  const enableAndTest = useCallback(async () => {
    setError(null);
    setEnabled(true);
    try {
      localStorage.setItem(preferenceKey, 'true');
    } catch { /* Le réglage reste disponible pour cet onglet. */ }
    try {
      if (!audio.current) audio.current = new CallRingtone(setReady);
      await audio.current.unlock();
      if (!audio.current?.play()) throw new Error('Lecture bloquée');
    } catch {
      setError('La sonnerie est bloquée. Autorise le son pour ce site dans ton navigateur.');
    }
  }, [preferenceKey]);

  function toggle() {
    if (!enabled || !ready) {
      void enableAndTest();
      return;
    }
    try { localStorage.setItem(preferenceKey, 'false'); } catch { /* Le réglage reste disponible pour cet onglet. */ }
    setEnabled(false);
    setError(null);
  }

  return { enabled, ready, error, toggle, enableAndTest, dismissError: () => setError(null) };
}
