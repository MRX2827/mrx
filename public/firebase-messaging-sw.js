// RedMrxGram — Push Notifications Service Worker
// Путь: ~/tgmrx/RedMrxGram/public/firebase-messaging-sw.js

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCVfXELwfW6dcYWrPbZYdh8zW6b-7dfQy4",
  authDomain: "redmrxgram.firebaseapp.com",
  projectId: "redmrxgram",
  storageBucket: "redmrxgram.firebasestorage.app",
  messagingSenderId: "512055244113",
  appId: "1:512055244113:web:78d3823515e9b2cbcb0f70"
});

const messaging = firebase.messaging();

// ── Фоновые уведомления (приложение закрыто / свёрнуто) ──
messaging.onBackgroundMessage(payload => {
  console.log('[SW] Background message:', payload);

  const notification = payload.notification || {};
  const data = payload.data || {};

  const title = notification.title || 'RedMrxGram';
  const body  = notification.body  || 'Новое сообщение';

  return self.registration.showNotification(title, {
    body,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-72.png',
    image:   notification.image || undefined,
    tag:     data.chatId || 'mrx-msg',
    renotify: true,
    silent:   false,
    vibrate:  [150, 80, 150, 80, 150],
    data,
    // Кнопки действий
    actions: [
      { action: 'reply',   title: '💬 Открыть' },
      { action: 'dismiss', title: '✕ Закрыть'  },
    ],
  });
});

// ── Клик по уведомлению ──
self.addEventListener('notificationclick', event => {
  const action = event.action;
  const chatId  = event.notification.data?.chatId;
  event.notification.close();

  if (action === 'dismiss') return;

  const url = '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        // Если приложение уже открыто — фокусируем и передаём chatId
        for (const client of list) {
          if ('focus' in client) {
            client.postMessage({ type: 'OPEN_CHAT', chatId });
            return client.focus();
          }
        }
        // Иначе открываем
        if (clients.openWindow) return clients.openWindow(url);
      })
  );
});

// ── Установка воркера ──
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));
