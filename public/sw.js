'use strict';
// Service Worker: zeigt Alarme als Mitteilung, auch wenn das iPhone gesperrt ist.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Sanitäteralarm', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Sanitäteralarm', {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    requireInteraction: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { alarmId: data.alarmId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.alarmId ? `/#alarm-${event.notification.data.alarmId}` : '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        c.navigate?.(url);
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
