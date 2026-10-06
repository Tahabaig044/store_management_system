// Phase 3.4: keeping the queue safe and moving when the app is not being actively used.
//
//   Persistent storage   browsers may evict a site's IndexedDB under storage pressure unless it is marked
//                        persistent - which would silently lose unsent transactions. We ask for it.
//   Background sync      where the browser supports it (Chromium), a queued transaction registers a
//                        one-off 'sync' with the service worker, and installed apps may also get a periodic
//                        one. The worker only wakes the app's windows (see public/service-worker.js); the
//                        sync itself is the normal single-flight, ordered, idempotent run. Not supported
//                        (Safari/Firefox) or no window open: the app's own triggers apply and the queue is
//                        simply sent when the app is next opened - never lost.
//   Full storage         a queue write that fails because the device is full is reported plainly (see
//                        syncEngine.queue) instead of as a mystery error.
import { processQueue, QUEUED_EVENT } from './syncCoordinator';
import { syncLocalData } from './localData';
import { auditLocalStore, checkOfflineDb } from './integrity';

export const STORAGE_BROKEN_EVENT = 'akvf:storage-broken';

const SYNC_TAG = 'akvf-sync';
const PERIODIC_TAG = 'akvf-periodic';

export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return { supported: false, persisted: false };
    if (await navigator.storage.persisted?.()) return { supported: true, persisted: true };
    return { supported: true, persisted: Boolean(await navigator.storage.persist()) };
  } catch {
    return { supported: false, persisted: false };
  }
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || !e.quota) return null;
    return { usage: e.usage || 0, quota: e.quota, fraction: (e.usage || 0) / e.quota };
  } catch {
    return null;
  }
}

// What the current browser can do for background work - reported, never assumed.
export async function backgroundCapabilities() {
  const hasSw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  let sync = false;
  let periodic = false;
  if (hasSw) {
    try {
      const reg = await navigator.serviceWorker.ready;
      sync = Boolean(reg.sync);
      periodic = Boolean(reg.periodicSync);
    } catch {
      // No registration (development, or not yet installed).
    }
  }
  return { serviceWorker: hasSw, backgroundSync: sync, periodicSync: periodic, persistentStorage: Boolean(navigator.storage?.persist) };
}

export async function registerBackgroundSync() {
  try {
    if (!('serviceWorker' in navigator)) return { registered: false, reason: 'no-service-worker' };
    const reg = await navigator.serviceWorker.ready;
    if (!reg.sync) return { registered: false, reason: 'unsupported' };
    await reg.sync.register(SYNC_TAG);
    return { registered: true };
  } catch (err) {
    return { registered: false, reason: err?.name || 'error' };
  }
}

async function registerPeriodic() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.periodicSync) return false;
    await reg.periodicSync.register(PERIODIC_TAG, { minInterval: 15 * 60 * 1000 });
    return true;
  } catch {
    return false; // not installed / permission not granted: fine
  }
}

// Wires everything for a signed-in terminal; returns a stop function.
export function startReliability(tenantId) {
  if (!tenantId || typeof window === 'undefined') return () => {};
  requestPersistentStorage();
  if ('serviceWorker' in navigator) registerPeriodic();

  // Startup checks: can the database be opened, and is every queued entry well-formed?
  checkOfflineDb(tenantId).then((res) => {
    if (!res.ok) window.dispatchEvent(new CustomEvent(STORAGE_BROKEN_EVENT, { detail: res }));
    else auditLocalStore(tenantId).catch(() => {});
  });

  // Whenever work is queued offline (or the tab is about to be backgrounded), ask the browser to wake us
  // when the connection is back.
  const onQueued = () => { if (navigator.onLine === false) registerBackgroundSync(); };
  const onHidden = () => { if (document.visibilityState === 'hidden') registerBackgroundSync(); };
  window.addEventListener(QUEUED_EVENT, onQueued);
  document.addEventListener('visibilitychange', onHidden);

  // The service worker woke us: run the normal sync and refresh the local copy.
  const onMessage = (event) => {
    if (event.data?.type !== 'akvf-background-sync') return;
    processQueue(tenantId, { force: true }).catch(() => {});
    syncLocalData(tenantId, { reason: 'background-sync' }).catch(() => {});
  };
  navigator.serviceWorker?.addEventListener?.('message', onMessage);

  return () => {
    window.removeEventListener(QUEUED_EVENT, onQueued);
    document.removeEventListener('visibilitychange', onHidden);
    navigator.serviceWorker?.removeEventListener?.('message', onMessage);
  };
}
