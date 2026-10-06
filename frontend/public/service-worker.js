// Phase 1 PWA foundation - caches the static app shell so the app can install
// and reopen while offline. Deliberately does NOT cache or queue API/data
// requests: full offline transactions and sync are Phase 2 work.
const CACHE_NAME = 'bizos-shell-v4';
// BizOS is served under /BizOS/, not the domain root - every shell path this
// worker caches/serves must carry that same prefix.
const BASE_PATH = '/BizOS/';
const APP_SHELL = [BASE_PATH, `${BASE_PATH}index.html`, `${BASE_PATH}manifest.webmanifest`];

// Phase 3.1: the shell is cached together with the build's own script/style files (read out of
// index.html), so a cold start while offline finds everything it needs - not only whatever pages
// happened to be opened online before.
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL);
  try {
    const html = await (await fetch(`${BASE_PATH}index.html`, { cache: 'no-store' })).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/BizOS\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await Promise.all(assets.map((a) => cache.add(a).catch(() => {})));
  } catch {
    // Offline during install: the runtime cache below still fills as pages are used online.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never cache API calls - all business data must come from the network.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first, cache fallback. A cache-first strategy here would mean a
  // deployed update never reaches an already-installed app until the user
  // manually clears their cache - the whole point of shipping a fix is that
  // it should be visible on the next normal reload while online.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Phase 3.1: a client-side route (/pos, /products, ...) has no file of its own - opening one
        // while offline (e.g. after a browser restart) must serve the app shell, which then routes.
        if (request.mode === 'navigate') return (await caches.match(`${BASE_PATH}index.html`)) || (await caches.match(BASE_PATH));
        return undefined;
      })
  );
});

// ---------------------------------------------------------------------------------------------
// Phase 3.4: background synchronization.
//
// When the connection returns while the app is open but not in use (a background tab, whose own timers
// the browser throttles), the browser fires a 'sync' event here (Background Sync) - and, on installed apps
// that were granted it, a 'periodicsync' one. The worker does NOT replay transactions itself: the offline
// queue's ordering, idempotency, dependency and conflict rules live in the app, and the session token is
// not available here. It wakes the app's windows, which run the normal single-flight sync. With no window
// open there is nothing that may send safely, so the event fails and the browser retries it later; the
// queue is always still intact and is sent the moment the app is opened. Where Background Sync is not
// supported (Safari, Firefox) the app's own triggers apply: reconnect, visibility, focus and a heartbeat.
async function wakeWindows(reason) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.length === 0) throw new Error('no window to run the sync');
  windows.forEach((w) => w.postMessage({ type: 'akvf-background-sync', reason }));
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'akvf-sync') event.waitUntil(wakeWindows('sync'));
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'akvf-periodic') event.waitUntil(wakeWindows('periodic').catch(() => {}));
});
