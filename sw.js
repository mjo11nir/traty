/* =====================================================================
   Service worker «Траты»: офлайн-режим.
   - Оболочка приложения и Chart.js кэшируются при установке.
   - Файлы приложения отдаются из кэша мгновенно и обновляются в фоне
     (stale-while-revalidate), поэтому приложение открывается и без сети.
   - Запросы курсов валют не кэшируются здесь: их кэш ведёт само приложение.
   После изменения файлов на хостинге увеличьте VERSION — пользователи
   увидят предложение «Доступна новая версия».
   ===================================================================== */
const VERSION = 'traty-v1.7.2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];
const CDN = ['https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js'];
const RATE_HOSTS = ['api.frankfurter.dev', 'open.er-api.com', 'currency-api.pages.dev'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Chart.js — по возможности; если CDN недоступен, установка всё равно завершится
    await Promise.all(CDN.map((url) =>
      fetch(url, { mode: 'cors' }).then((res) => (res.ok ? cache.put(url, res) : null)).catch(() => null)));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Страница присылает SKIP_WAITING, когда пользователь нажал «Обновить»
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Курсы валют — всегда напрямую в сеть
  if (RATE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h)) || url.pathname.includes('@fawazahmed0')) return;

  // Переходы по страницам приложения → index.html из кэша
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, './index.html'));
    return;
  }
  if (url.origin === self.location.origin || CDN.includes(url.href)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/* --- Уведомления (Web Push от сервера «Входящие») --- */
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(msg.title || 'Траты', {
    body: msg.body || '',
    tag: msg.tag || 'traty',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: msg.url || './' },
  }));
});
// Нажатие на уведомление: открыть приложение (или переключиться на уже открытое) нужным экраном
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(self.registration.scope));
    if (client) {
      await client.focus();
      client.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

/** Отдаёт из кэша сразу, параллельно обновляя кэш из сети. */
async function staleWhileRevalidate(event, cacheKey) {
  const cache = await caches.open(VERSION);
  const key = cacheKey || event.request;
  const cached = await cache.match(key, { ignoreSearch: true });
  const network = fetch(event.request)
    .then((res) => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  return res || new Response('Нет соединения', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
