import type { MentionNotification, Room } from './types';

let worker: Promise<ServiceWorkerRegistration> | null = null;

export function supportsSystemNotifications(): boolean {
  return window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator &&
    'ServiceWorkerRegistration' in window && 'showNotification' in ServiceWorkerRegistration.prototype;
}

function notificationWorker() {
  if (!worker) {
    worker = navigator.serviceWorker.register('/mention-notifications.js')
      .then(() => navigator.serviceWorker.ready)
      .catch((error: unknown) => { worker = null; throw error; });
  }
  return worker;
}

export function mentionLabel(notification: MentionNotification): string {
  return notification.kind === 'room'
    ? notification.senderName + ' a mentionné le salon'
    : notification.senderName + ' vous a mentionné';
}

export async function enableSystemNotifications(): Promise<void> {
  if (!supportsSystemNotifications()) throw new Error('Alertes système indisponibles sur ce navigateur.');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Autorisez les notifications dans les réglages de votre navigateur.');
  await notificationWorker();
}

export async function showSystemNotification(room: Room, notification: MentionNotification): Promise<void> {
  if (!supportsSystemNotifications()) return;
  const registration = await notificationWorker();
  await registration.showNotification(room.name, {
    body: mentionLabel(notification),
    tag: `room-${room.id}-notification-${notification.id}`,
    data: { roomId: room.id, notificationId: notification.id },
  });
}
