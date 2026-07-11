/* eslint-disable */
/**
 * Flock service worker — US-22 (Web Push, FR-ST4) + PWA shell (US-36, FR-UI6).
 *
 * Served from the site root (`/sw.js`) so it controls the whole origin scope.
 * It does TWO jobs, deliberately in ONE worker (Flock ships a single SW shared
 * by both stories — registering a second worker would fight for the scope):
 *
 *   1. Web Push (US-22): receive a push and show a notification. The orchestrator
 *      pushes ONLY on `awaiting_input` / `done` / `error` transitions (the
 *      trigger predicate lives server-side), so anything that arrives here is by
 *      definition worth surfacing — "which agent needs me," even with the tab
 *      closed.
 *   2. PWA shell (US-36): pre-cache the app shell on install and serve it for
 *      navigations when the network is down, so an installed Flock launches from
 *      the home screen even on a flaky phone connection.
 *
 * Plain JS (not TS/bundled) so it can be registered directly and is easy to
 * audit; it has no app dependencies.
 */

// Bump this when the shell changes so `activate` prunes the old cache.
const SHELL_CACHE = 'flock-shell-v1';

// The minimal app shell. We cache the document + Vite entry; hashed JS/CSS
// chunks are cached lazily on first fetch (cache-first below) since their names
// change per build. `/` is the SPA entry every route falls back to.
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

// Pre-cache the shell on install so the PWA is launchable offline, then activate
// immediately so a new SW controls open pages.
self.addEventListener('install', (event) => {
  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(
      caches.open(SHELL_CACHE).then((cache) =>
        // `addAll` is atomic-ish but we don't want one 404 (e.g. a missing icon
        // in dev) to abort the whole install, so cache best-effort per URL.
        Promise.all(
          SHELL_URLS.map((url) =>
            cache.addAll([url]).catch(() => {
              /* best-effort: a missing shell asset must not break install */
            }),
          ),
        ),
      ),
    );
  }
  self.skipWaiting();
});

// Drop stale shell caches from previous versions, then take control.
self.addEventListener('activate', (event) => {
  if (event && typeof event.waitUntil === 'function') {
    event.waitUntil(
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name.startsWith('flock-shell-') && name !== SHELL_CACHE)
              .map((name) => caches.delete(name)),
          ),
        )
        .then(() => self.clients.claim()),
    );
  } else {
    self.clients.claim();
  }
});

/**
 * Fetch strategy:
 *  - Navigations (page loads): network-first, falling back to the cached shell
 *    so an offline launch still opens the SPA (which then shows the live WS data
 *    once the link returns).
 *  - GET requests: stale-while-revalidate-ish — try cache, else network and
 *    cache the result. We never cache the API/WS (only same-origin static).
 * Non-GET and cross-origin requests pass straight through.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .open(SHELL_CACHE)
          .then((cache) => cache.match('/').then((cached) => cached || cache.match('/index.html'))),
      ),
    );
    return;
  }

  // Don't intercept API or websocket calls — those are the live path.
  let url;
  try {
    url = new URL(request.url, self.location ? self.location.href : 'http://localhost');
  } catch (_err) {
    return;
  }
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            // Cache successful same-origin static responses for next time.
            if (
              response &&
              response.ok &&
              url.origin === (self.location ? self.location.origin : url.origin)
            ) {
              cache.put(request, response.clone());
            }
            return response;
          }),
      ),
    ),
  );
});

/**
 * Push handler. The orchestrator sends a JSON body shaped like
 * { title, body, sessionId, status }. We render it as a notification; tapping it
 * focuses (or opens) the cockpit at the relevant session.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    // Non-JSON payload: fall back to raw text in the body.
    data = { title: 'Flock', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Flock';
  const options = {
    body: data.body || '',
    tag: data.sessionId ? `flock-session-${data.sessionId}` : 'flock',
    // Re-alerting for the same session replaces the prior notification.
    renotify: Boolean(data.sessionId),
    data: {
      sessionId: data.sessionId || null,
      status: data.status || null,
      url: data.sessionId ? `/?session=${encodeURIComponent(data.sessionId)}` : '/',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Notification click: focus an existing cockpit tab if one is open, else open a
 * new one at the session URL. This is the "tap the alert, jump to the agent that
 * needs you" flow (PRD §1.2).
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && targetUrl !== '/') {
            client.navigate(targetUrl);
          }
          return undefined;
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
