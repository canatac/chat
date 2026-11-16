import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { enableSystemNotifications, showSystemNotification, supportsSystemNotifications } from './systemNotifications';
import type { MentionNotification, NotificationPage, Room } from './types';
import type { ChatSocket } from './ws';

type ReadSelection = { id: number } | { through: number };

export default function useMentionNotifications(socket: ChatSocket | null, online: boolean, room: Room, userId: number) {
  const storageKey = 'chat.system-alerts.' + userId;
  const [systemEnabled, setSystemEnabled] = useState(() => localStorage.getItem(storageKey) === 'true');
  const [systemPending, setSystemPending] = useState(false);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [page, setPage] = useState<NotificationPage>({ notifications: [], unread: 0, nextBefore: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<MentionNotification | null>(null);
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(async (before?: number) => {
    if (before !== undefined && pending.current) return;
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setError(null);
    try {
      const result = await api.notifications(before, request.signal);
      if (request.signal.aborted) return;
      setPage((current) => before === undefined ? result : {
        ...result,
        notifications: [...current.notifications, ...result.notifications],
      });
    } catch {
      if (!request.signal.aborted) setError('Impossible de charger les notifications.');
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { pending.current?.abort(); pending.current = null; };
  }, [load, online]);

  useEffect(() => {
    const syncPreference = (event: StorageEvent) => {
      if (event.key === storageKey) setSystemEnabled(event.newValue === 'true');
    };
    window.addEventListener('storage', syncPreference);
    return () => window.removeEventListener('storage', syncPreference);
  }, [storageKey]);

  useEffect(() => socket?.onMessage((event) => {
    if (event.type !== 'notificationsChanged') return;
    void load();
    const notification = event.notification;
    if (!notification) return;
    if (!document.hidden) setToast(notification);
    else if (systemEnabled) {
      void showSystemNotification(room, notification).catch(() => setSystemError('Impossible d’afficher l’alerte système.'));
    }
  }), [load, room, socket, systemEnabled]);

  const read = useCallback(async (selection: ReadSelection) => {
    try {
      const { unread } = await api.readNotifications(selection);
      const readAt = new Date().toISOString();
      setPage((current) => ({ ...current, unread, notifications: current.notifications.map((item) => (
        ('id' in selection ? item.id === selection.id : item.id <= selection.through) && !item.readAt ? { ...item, readAt } : item
      )) }));
      void load();
    } catch {
      setError('Impossible de marquer la notification comme lue.');
    }
  }, [load]);

  async function toggleSystem() {
    setSystemError(null);
    if (systemEnabled) {
      localStorage.removeItem(storageKey);
      setSystemEnabled(false);
      return;
    }
    setSystemPending(true);
    try {
      await enableSystemNotifications();
      localStorage.setItem(storageKey, 'true');
      setSystemEnabled(true);
    } catch (error) {
      setSystemError(error instanceof Error ? error.message : 'Impossible d’activer les alertes système.');
    } finally {
      setSystemPending(false);
    }
  }

  const dismissToast = useCallback(() => setToast(null), []);
  return { page, load, loading, error, read, toast, dismissToast,
    systemSupported: supportsSystemNotifications(), systemEnabled, systemPending, systemError, toggleSystem };
}
