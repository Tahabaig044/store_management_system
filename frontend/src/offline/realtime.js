// Phase 3.4: the terminal's side of the "something changed" stream (server: modules/sync/realtime.js).
//
// It only ever triggers what the terminal already does on a timer - a cheap manifest check that downloads
// only what really changed - so a stock change made on another terminal is noticed in about a second
// instead of at the next 60 s poll. It carries no data and nothing depends on it: if the stream cannot be
// opened (offline, an old server, a proxy that buffers), the existing polling simply carries on. The
// connection is held only while the app is online and visible, retried with bounded backoff, and never
// used to send anything.
import apiClient from '../api/client';
import { syncLocalData } from './localData';

const MIN_BACKOFF = 2000;
const MAX_BACKOFF = 60000;

// Reads a Server-Sent-Events body, calling onEvent(name) for each complete event.
export async function readEvents(body, onEvent, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    if (signal?.aborted) return;
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n\n');
    while (cut >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const m = /^event: (\w+)/m.exec(block);
      if (m) onEvent(m[1]);
      cut = buffer.indexOf('\n\n');
    }
  }
}

export function startRealtime(tenantId, { fetchImpl, onChange, getToken = () => localStorage.getItem('akvf_token'), baseUrl = apiClient.defaults.baseURL, debounceMs = 250, minGapMs = 3000 } = {}) {
  if (!tenantId || typeof window === 'undefined') return () => {};
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const doRefresh = onChange || (() => syncLocalData(tenantId, { reason: 'push' }).catch(() => {}));
  let lastRefreshAt = 0;
  const refresh = () => { lastRefreshAt = Date.now(); return doRefresh(); };
  let stopped = false;
  let controller = null;
  let backoff = MIN_BACKOFF;
  let retryTimer = null;
  let changeTimer = null;

  const wanted = () => !stopped && navigator.onLine !== false && document.visibilityState !== 'hidden';
  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    if (stopped) return;
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  };
  // Every terminal of a shop reacts to every change, so on a busy shop the refreshes multiply (measured: 25
  // terminals refreshing once a second cost about as much server time as the whole rest of the traffic).
  // Event-driven refreshes are therefore spaced at least minGapMs apart; the 60 s poll and the sale-time
  // stock check on the server are unaffected.
  const changed = () => {
    clearTimeout(changeTimer);
    const wait = Math.max(debounceMs, minGapMs - (Date.now() - lastRefreshAt));
    changeTimer = setTimeout(refresh, wait);
  };

  async function connect() {
    clearTimeout(retryTimer);
    if (!wanted() || controller) return;
    const token = getToken();
    if (!token) return;
    controller = new AbortController();
    const mine = controller;
    try {
      const res = await doFetch(`${baseUrl}/sync/stream`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: mine.signal });
      if (res.status === 401 || res.status === 403) return; // the session is over; sign-in restarts everything
      if (!res.ok || !res.body) throw new Error(`stream refused (${res.status})`);
      backoff = MIN_BACKOFF;
      await readEvents(res.body, (name) => {
        if (name === 'ready') refresh(); // events missed while disconnected are caught up at once
        else if (name === 'changed') changed();
      }, mine.signal);
    } catch {
      // Falls through to the retry below; the 60 s polling covers the gap.
    } finally {
      if (controller === mine) controller = null;
    }
    if (wanted()) scheduleRetry();
  }

  const disconnect = () => { controller?.abort(); controller = null; clearTimeout(retryTimer); };
  const onVisibility = () => (wanted() ? connect() : disconnect());
  const onOnline = () => { backoff = MIN_BACKOFF; connect(); };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', disconnect);
  document.addEventListener('visibilitychange', onVisibility);
  connect();

  return () => {
    stopped = true;
    disconnect();
    clearTimeout(changeTimer);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', disconnect);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
