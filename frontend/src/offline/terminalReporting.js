// Phase 3.3.4: a terminal tells the server how it is doing, so a manager can see - across every terminal -
// who is holding unsent work, and which transactions the server refused and nobody has dealt with.
//
// This only ever REPORTS. It reads the queue and sends counts plus the refused entries' reasons; it never
// changes an entry's payload or status and never sends a transaction (the coordinator does that, with its
// own idempotency and ordering). A report that cannot be sent (offline, server down) is simply not sent:
// nothing is lost, and the next one carries the same information. Reports carry the time they were composed,
// so one that arrives late can never overwrite a newer one on the server.
import apiClient from '../api/client';
import { getOfflineDb, offlineDbName } from './db';
import { getRegistered, registeredTables } from './syncCore';
import { SYNC_FINISHED_EVENT, QUEUED_EVENT } from './syncCoordinator';

const TERMINAL_KEY = 'akvf_terminal_id';
const HEARTBEAT_MS = 5 * 60 * 1000; // well inside the server's "gone quiet" threshold (15 min)
let memoryId = null;

// One id per browser/device, created once and kept. (Two users signing in on the same device are the same
// terminal - it is the device that holds the queue's history, not the person.)
export function getTerminalId() {
  try {
    const stored = localStorage.getItem(TERMINAL_KEY);
    if (stored) return stored;
    const id = `term-${crypto.randomUUID()}`;
    localStorage.setItem(TERMINAL_KEY, id);
    return id;
  } catch {
    if (!memoryId) memoryId = `term-${crypto.randomUUID()}`;
    return memoryId;
  }
}

const OPEN = ['pending', 'syncing', 'blocked'];

// What the terminal would say right now, and the bookkeeping to send with it.
export async function buildReport(tenantId) {
  const db = getOfflineDb(tenantId);
  const previouslyReported = new Set((await db.meta.get('reportedIssues'))?.value || []);
  const counts = { pending: 0, conflict: 0, failed: 0, oldestPendingAt: null };
  const issues = [];
  const resolved = [];
  const tableOf = new Map(); // clientId -> table (to mark an issue "seen by a manager" locally)
  const present = new Set();

  for (const table of registeredTables()) {
    for (const e of await db[table].toArray()) {
      present.add(e.clientId);
      tableOf.set(e.clientId, table);
      if (OPEN.includes(e.status)) {
        counts.pending += 1;
        if (!counts.oldestPendingAt || e.createdAt < counts.oldestPendingAt) counts.oldestPendingAt = e.createdAt;
      } else if (e.status === 'conflict' || e.status === 'failed') {
        counts[e.status] += 1;
        issues.push({
          clientId: e.clientId,
          entity: getRegistered(table)?.label || table,
          kind: e.failure?.kind || 'REJECTED',
          code: e.failure?.code || null,
          message: String(e.failure?.message || e.lastError || 'Refused by the server').slice(0, 500),
          details: e.failure?.details || undefined,
        });
      } else if (e.status === 'synced' && previouslyReported.has(e.clientId)) {
        resolved.push({ clientId: e.clientId, resolution: 'synced' });
      }
    }
  }
  for (const id of previouslyReported) if (!present.has(id)) resolved.push({ clientId: id, resolution: 'discarded' });

  const reportedNow = new Set([...previouslyReported].filter((id) => !resolved.some((r) => r.clientId === id)));
  for (const i of issues) reportedNow.add(i.clientId);
  return {
    body: { terminalId: getTerminalId(), sentAt: new Date().toISOString(), counts: { ...counts, oldestPendingAt: counts.oldestPendingAt ? new Date(counts.oldestPendingAt).toISOString() : null }, issues: issues.slice(0, 200), resolved: resolved.slice(0, 500) },
    reportedNow: [...reportedNow],
    tableOf,
  };
}

const signature = (b) => JSON.stringify([b.counts.pending, b.counts.conflict, b.counts.failed, b.issues.map((i) => `${i.clientId}:${i.kind}`).sort(), b.resolved.map((r) => r.clientId).sort()]);
const inflight = new Map(); // db name -> promise

// Sends one report if there is something new to say (or the heartbeat is due). Never throws.
export function reportTerminalState(tenantId, { force = false } = {}) {
  if (!tenantId) return Promise.resolve({ sent: false, reason: 'no-tenant' });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve({ sent: false, reason: 'offline' });
  const key = offlineDbName(tenantId);
  if (inflight.has(key)) return inflight.get(key);
  const run = doReport(tenantId, force).catch((err) => ({ sent: false, reason: err?.name === 'DatabaseClosedError' ? 'database-closed' : 'error', error: err?.message })).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function doReport(tenantId, force) {
  const db = getOfflineDb(tenantId);
  const { body, reportedNow, tableOf } = await buildReport(tenantId);
  const last = (await db.meta.get('lastTerminalReport'))?.value;
  if (!force && last && last.signature === signature(body) && Date.now() - last.at < HEARTBEAT_MS) return { sent: false, reason: 'unchanged' };

  const { data } = await apiClient.post('/sync/terminal-report', body);
  // Only after the server has it: remember what it now knows, and note which refusals a manager has seen.
  await db.meta.bulkPut([
    { key: 'reportedIssues', value: reportedNow },
    { key: 'lastTerminalReport', value: { signature: signature(body), at: Date.now() } },
  ]);
  for (const a of data?.acknowledged || []) {
    const table = tableOf.get(a.clientId);
    if (table) await db[table].update(a.clientId, { managerSeenAt: Date.now(), managerNote: a.acknowledgeNote || null }).catch(() => {});
  }
  return { sent: true, stale: Boolean(data?.stale), acknowledged: (data?.acknowledged || []).length };
}

// Runs for a signed-in terminal: after every sync pass, whenever something is queued or the connection
// returns, and on a heartbeat (so a quiet terminal that still holds work is recognisably alive).
export function startTerminalReporting(tenantId) {
  if (!tenantId || typeof window === 'undefined') return () => {};
  const send = () => { reportTerminalState(tenantId).catch(() => {}); };
  const onFinished = (e) => { if (!e.detail || e.detail.tenantId === tenantId) send(); };
  window.addEventListener(SYNC_FINISHED_EVENT, onFinished);
  window.addEventListener(QUEUED_EVENT, send);
  window.addEventListener('online', send);
  const interval = setInterval(send, HEARTBEAT_MS);
  send();
  return () => {
    window.removeEventListener(SYNC_FINISHED_EVENT, onFinished);
    window.removeEventListener(QUEUED_EVENT, send);
    window.removeEventListener('online', send);
    clearInterval(interval);
  };
}
