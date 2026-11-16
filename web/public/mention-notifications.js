self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { roomId, notificationId } = event.notification.data ?? {};
  if (![roomId, notificationId].every((id) => Number.isSafeInteger(id) && id > 0)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = windows.find((client) => {
      const url = new URL(client.url);
      return url.pathname === '/' && url.searchParams.get('room') === String(roomId);
    });
    const focused = target && await target.focus().catch(() => null);
    if (focused) {
      focused.postMessage({ type: 'openMentionNotification', roomId, notificationId });
      return;
    }
    const url = new URL('/', self.location.origin);
    url.searchParams.set('room', String(roomId));
    url.searchParams.set('notification', String(notificationId));
    await self.clients.openWindow(url.href);
  })());
});
