import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { getOfflineDb } from './db';
import { computeFreshness } from './localData';

// Reactive freshness of this terminal's local read copy: re-evaluates when any dataset record
// changes, when the browser goes online/offline, and every 15 s (staleness is a function of time).
export function useLocalDataStatus(tenantId) {
  const [rows, setRows] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    if (!tenantId) return undefined;
    const db = getOfflineDb(tenantId);
    const sub = liveQuery(() => db.meta.where('key').startsWith('dataset:').toArray()).subscribe({
      next: setRows,
      error: (err) => console.error('Local data status query failed:', err),
    });
    const tick = setInterval(() => setNow(Date.now()), 15000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      sub.unsubscribe();
      clearInterval(tick);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [tenantId]);

  return { ...computeFreshness(rows, now), online };
}

export function formatAge(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.max(Math.round((now - ts) / 1000), 0);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(ts).toLocaleString();
}
