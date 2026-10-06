// Phase 3.2: the synchronization engine - ONE ordered, resumable, conflict-aware pass over every
// outbox (the Phase 2 queue tables), replacing the per-outbox "drain until the first hiccup" loops.
//
// What it guarantees
//   Ordering     entries are attempted oldest-first across ALL outboxes; an entry that refers to another
//                queued entry ("$ref:<clientId>") is not sent until that one has synced (the real id is
//                then substituted). If the one it waits for needs attention, the dependent is shown as
//                BLOCKED - visibly, with the reason - and released automatically when that is resolved.
//   Independence a failing/conflicting/backing-off entry never holds up unrelated entries.
//   No loss      the only ways an entry leaves the queue are (a) the server accepted it, (b) a person
//                discards it after seeing it (logged). Network loss, restarts and crashes keep it.
//   Retry        unreachable server: wait, uncounted, resume on reconnect/timer. Transient server errors:
//                bounded exponential backoff, then a visible 'failed' item - never dropped.
//   Resume       an entry interrupted mid-request ('syncing' when the app died) is re-queued; replaying it
//                is safe because every create carries its client idempotency key.
//   Conflicts    the server is authoritative. A rejection is classified by status + machine code
//                (syncCore.classifyFailure), stored on the entry, and shown - nothing is overwritten.
//   Convergence  after a pass that changed anything the local read copy (stock above all) is re-downloaded,
//                so local numbers = server truth + only what is still queued.
//
// What it does not do: create new kinds of offline operation (the Phase 2.4 boundary still decides
// what may be queued), or merge concurrent edits of the same record (nothing queued edits an
// existing record other than the guarded reversal).
import apiClient from '../api/client';
import { getOfflineDb, offlineDbName } from './db';
import { getRegistered, registeredTables, extractRefs, resolveRefs, classifyFailure, backoffMs, MAX_SERVER_ATTEMPTS } from './syncCore';
import { syncLocalData } from './localData';

export const QUEUED_EVENT = 'akvf:queued';
export const SYNC_FINISHED_EVENT = 'akvf:sync-finished';

const SYNCED_RETENTION_MS = 24 * 60 * 60 * 1000;
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine);

// ---------------------------------------------------------------------------------------------
// Loading and persisting
// ---------------------------------------------------------------------------------------------
async function loadAll(db) {
  const rows = [];
  for (const table of registeredTables()) {
    for (const entry of await db[table].toArray()) rows.push({ table, entry });
  }
  rows.sort((a, b) => a.entry.createdAt - b.entry.createdAt || (a.entry.clientId < b.entry.clientId ? -1 : 1));
  return rows;
}

async function patch(db, rec, changes) {
  await db[rec.table].update(rec.entry.clientId, changes);
  Object.assign(rec.entry, changes);
}

// An entry can only be 'syncing' if the app died mid-request (a live pass sets it and resolves it in
// the same breath). Put it back in the queue; the idempotency key makes a second send harmless.
async function recoverInterrupted(db) {
  let recovered = 0;
  for (const table of registeredTables()) {
    // The request may or may not have reached the server before the app died.
    recovered += await db[table].where('status').equals('syncing').modify({ status: 'pending', maybeApplied: true });
  }
  return recovered;
}

// ---------------------------------------------------------------------------------------------
// Choosing what to send next
// ---------------------------------------------------------------------------------------------
async function nextEligible(db, rows, byId, { only, force, result }) {
  for (const rec of rows) {
    const { entry } = rec;
    if (entry.status !== 'pending' && entry.status !== 'blocked') continue;
    if (only && !only.includes(rec.table)) continue;

    const deps = entry.dependsOn || [...extractRefs(entry.payload)];
    let waiting = false;
    let blockedBy = null;
    let missing = false;
    for (const id of deps) {
      const dep = byId.get(id);
      if (!dep) { missing = true; break; }
      if (dep.entry.status === 'synced') continue;
      if (dep.entry.status === 'conflict' || dep.entry.status === 'failed') { blockedBy = id; break; }
      waiting = true;
    }

    if (missing) {
      await patch(db, rec, { status: 'failed', blockedBy: null, failure: { kind: 'DEPENDENCY_DISCARDED', code: null, status: null, message: 'A record this depends on was discarded', at: Date.now() }, lastError: 'A record this depends on was discarded' });
      result.failed += 1;
      continue;
    }
    if (blockedBy) {
      const dep = byId.get(blockedBy);
      if (entry.status !== 'blocked' || entry.blockedBy !== blockedBy) {
        await patch(db, rec, { status: 'blocked', blockedBy, failure: { kind: 'DEPENDENCY', code: null, status: null, message: `Waiting for ${getRegistered(dep.table)?.label || 'another record'} that needs attention`, at: Date.now() } });
      }
      result.blocked += 1;
      continue;
    }
    if (waiting) {
      if (entry.status === 'blocked') await patch(db, rec, { status: 'pending', blockedBy: null, failure: null });
      continue;
    }
    if (entry.status === 'blocked') await patch(db, rec, { status: 'pending', blockedBy: null, failure: null });
    if (!force && entry.nextAttemptAt && entry.nextAttemptAt > Date.now()) {
      result.waiting += 1;
      continue;
    }
    return rec;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------------------------
async function attempt(db, rec, byId, result) {
  const def = getRegistered(rec.table);
  const attempts = (rec.entry.attempts || 0) + 1;
  await patch(db, rec, { status: 'syncing', lastAttemptAt: Date.now() });

  // Building the request can only fail for an entry that is itself damaged (a payload the outbox cannot turn
  // into a request). That must never take the rest of the queue down with it: the entry becomes a visible,
  // non-retryable failure and the pass carries on with everything else.
  let path;
  let body;
  try {
    const payload = resolveRefs(rec.entry.payload, (id, refPath) => {
      const result = byId.get(id)?.entry.serverResult;
      if (!refPath) return result?.id;
      return refPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), result);
    });
    ({ path, body } = def.request(payload));
  } catch (err) {
    const message = `This entry is damaged and cannot be sent (${err?.message || 'unreadable'})`;
    await patch(db, rec, { status: 'failed', attempts, failure: { kind: 'CORRUPT', code: null, status: null, message, at: Date.now() }, lastError: message, nextAttemptAt: null, blockedBy: null, maybeApplied: false });
    result.failed += 1;
    return 'ok';
  }
  try {
    const { data } = body === undefined ? await apiClient.post(path) : await apiClient.post(path, body);
    await patch(db, rec, { status: 'synced', serverResult: data?.item ?? null, syncedAt: Date.now(), attempts, failure: null, lastError: null, nextAttemptAt: null, blockedBy: null, maybeApplied: false });
    result.synced += 1;
    return 'ok';
  } catch (err) {
    const c = classifyFailure(err, { intentIdempotent: def.intentIdempotent });
    if (c.action === 'network') {
      // The request left this device but no answer came back: the server may have applied it. Until a
      // definitive answer arrives it must not be edited (a replay with the same key would return the
      // ORIGINAL record and silently ignore the edit).
      await patch(db, rec, { status: 'pending', lastError: 'Waiting for the network', maybeApplied: true });
      result.offline = true;
      return 'stop';
    }
    if (c.action === 'auth') {
      await patch(db, rec, { status: 'pending', lastError: 'Signed out - sign in to continue syncing', maybeApplied: false });
      result.paused = 'auth';
      return 'stop';
    }
    if (c.action === 'success') {
      await patch(db, rec, { status: 'synced', serverResult: { alreadyApplied: true }, syncedAt: Date.now(), attempts, failure: null, lastError: null, nextAttemptAt: null, maybeApplied: false });
      result.synced += 1;
      return 'ok';
    }
    if (c.action === 'server') {
      if (attempts >= MAX_SERVER_ATTEMPTS) {
        await patch(db, rec, { status: 'failed', attempts, failure: c, lastError: c.message, nextAttemptAt: null, maybeApplied: true });
        result.failed += 1;
      } else {
        await patch(db, rec, { status: 'pending', attempts, failure: c, lastError: c.message, nextAttemptAt: Date.now() + backoffMs(attempts), maybeApplied: true });
        result.retryLater += 1;
      }
      return 'ok';
    }
    const { action, ...failure } = c;
    // A definitive rejection: the server did NOT apply it, so it is safe to edit.
    await patch(db, rec, { status: action === 'conflict' ? 'conflict' : 'failed', attempts, failure, lastError: c.message, nextAttemptAt: null, maybeApplied: false });
    if (action === 'conflict') result.conflicts += 1;
    else result.failed += 1;
    return 'ok';
  }
}

// ---------------------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------------------
async function doProcess(tenantId, { only, force }) {
  if (!isOnline()) return { skipped: 'offline' };
  const db = getOfflineDb(tenantId);
  const result = { synced: 0, conflicts: 0, failed: 0, retryLater: 0, waiting: 0, blocked: 0, offline: false, paused: null, recovered: 0 };
  await db.meta.put({ key: 'syncActive', value: true });
  try {
    result.recovered = await recoverInterrupted(db);
    const rows = await loadAll(db);
    const byId = new Map(rows.map((r) => [r.entry.clientId, r]));
    const limit = rows.length * 3 + 5;
    for (let i = 0; i < limit; i += 1) {
      // Counters for things merely observed (waiting/blocked) restart each look so they are not double counted.
      result.waiting = 0;
      result.blocked = 0;
      const rec = await nextEligible(db, rows, byId, { only, force, result });
      if (!rec) break;
      if ((await attempt(db, rec, byId, result)) === 'stop') break;
    }
    await finish(db, rows, result);
  } catch (err) {
    // The database was closed under us (sign-out, switching shop/user mid-pass). Nothing is lost - every
    // change was persisted as it happened and the entries are picked up again when a session resumes.
    if (err?.name !== 'DatabaseClosedError') throw err;
    return { ...result, skipped: 'database-closed' };
  } finally {
    await db.meta.put({ key: 'syncActive', value: false }).catch(() => {});
  }
  if (result.synced || result.conflicts) syncLocalData(tenantId, { reason: 'after-sync' }).catch(() => {});
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SYNC_FINISHED_EVENT, { detail: { tenantId, ...result } }));
  return result;
}

// Bookkeeping after a pass: last-sync marks (what the UI shows) and pruning of old synced entries
// that nothing still waiting refers to.
async function finish(db, rows, result) {
  const touched = new Set(rows.filter((r) => r.entry.syncedAt && Date.now() - r.entry.syncedAt < 60000).map((r) => r.table));
  for (const t of touched) await db.meta.put({ key: `lastSyncAt:${t}`, value: Date.now() });
  if (result.synced) await db.meta.put({ key: 'lastSyncAt', value: Date.now() });

  const referenced = new Set();
  for (const r of rows) {
    if (r.entry.status !== 'synced') (r.entry.dependsOn || [...extractRefs(r.entry.payload)]).forEach((id) => referenced.add(id));
  }
  for (const r of rows) {
    if (r.entry.status === 'synced' && r.entry.syncedAt && Date.now() - r.entry.syncedAt > SYNCED_RETENTION_MS && !referenced.has(r.entry.clientId)) {
      await db[r.table].delete(r.entry.clientId);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Single flight (per database), with one shared follow-up for callers that arrive mid-pass
// ---------------------------------------------------------------------------------------------
const runs = new Map(); // db name -> { current, queued, queuedOpts }

function withCrossTabLock(name, fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`akvf-sync:${name}`, { ifAvailable: true }, (lock) => (lock ? fn() : { skipped: 'other-tab' }));
  }
  return fn();
}

const mergeOpts = (a, b) => ({ only: a.only && b.only ? [...new Set([...a.only, ...b.only])] : undefined, force: Boolean(a.force || b.force) });

// Runs a pass. `only` limits WHICH tables are attempted (an outbox's own sync()); `force` ignores
// retry backoff (a person pressing Sync now, the browser coming back online).
export function processQueue(tenantId, { only, force = false } = {}) {
  const name = offlineDbName(tenantId);
  let s = runs.get(name);
  if (!s) {
    s = { current: null, queued: null, queuedOpts: null };
    runs.set(name, s);
  }
  const opts = { only, force };
  if (!s.current) {
    s.current = withCrossTabLock(name, () => doProcess(tenantId, opts)).finally(() => {
      s.current = null;
    });
    return s.current;
  }
  // A pass is running; whatever prompted this call may postdate what it already read. Share ONE follow-up.
  s.queuedOpts = s.queuedOpts ? mergeOpts(s.queuedOpts, opts) : opts;
  if (!s.queued) {
    s.queued = s.current.then(() => {
      const next = s.queuedOpts;
      s.queued = null;
      s.queuedOpts = null;
      return processQueue(tenantId, next);
    });
  }
  return s.queued;
}

// ---------------------------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------------------------
export async function retryEntry(tenantId, table, clientId) {
  const db = getOfflineDb(tenantId);
  await db[table].update(clientId, { status: 'pending', failure: null, lastError: null, attempts: 0, nextAttemptAt: null, blockedBy: null });
  return processQueue(tenantId, { force: true });
}

// Removing an entry is the one way queued work can be lost, so it is always logged (what it was and
// when) and lets go of anything that was waiting on it (those become visible 'failed' items).
export async function discardEntry(tenantId, table, clientId, { reason = 'user' } = {}) {
  const db = getOfflineDb(tenantId);
  const entry = await db[table].get(clientId);
  if (!entry) return false;
  const log = (await db.meta.get('discardLog'))?.value || [];
  log.unshift({ clientId, table, label: getRegistered(table)?.label, payload: entry.payload, status: entry.status, failure: entry.failure || null, revisions: entry.revisions || [], at: Date.now(), reason });
  await db.meta.put({ key: 'discardLog', value: log.slice(0, 100) });
  await db[table].delete(clientId);
  // Its optimistic stock effect is no longer real; take the server's word for stock again.
  syncLocalData(tenantId, { reason: 'after-discard' }).catch(() => {});
  return true;
}

export async function getDiscardLog(tenantId) {
  return (await getOfflineDb(tenantId).meta.get('discardLog'))?.value || [];
}

// ---------------------------------------------------------------------------------------------
// Automatic operation
// ---------------------------------------------------------------------------------------------
const INTERVAL_MS = 30 * 1000;

async function earliestRetryDelay(tenantId) {
  const db = getOfflineDb(tenantId);
  let earliest = null;
  for (const table of registeredTables()) {
    for (const e of await db[table].where('status').equals('pending').toArray()) {
      if (e.nextAttemptAt && (earliest === null || e.nextAttemptAt < earliest)) earliest = e.nextAttemptAt;
    }
  }
  return earliest === null ? null : Math.max(earliest - Date.now(), 0);
}

// Starts automatic processing for a signed-in terminal: once now (which also recovers an interrupted
// queue after a restart), when the browser comes back online, whenever something is queued, when the
// tab becomes visible, on a 30 s heartbeat, and at the exact moment the next backoff expires.
// Returns a stop function.
export function startSyncCoordinator(tenantId) {
  if (!tenantId || typeof window === 'undefined') return () => {};
  let timer = null;
  let stopped = false;

  const schedule = async () => {
    clearTimeout(timer);
    if (stopped) return;
    const delay = await earliestRetryDelay(tenantId).catch(() => null);
    if (delay !== null && !stopped) timer = setTimeout(() => kick('backoff'), delay + 50);
  };
  const kick = (reason, force = false) => {
    if (stopped || !isOnline()) return Promise.resolve();
    return processQueue(tenantId, { force }).catch(() => {}).then(schedule);
  };

  const onOnline = () => kick('online', true);
  const onQueued = () => kick('queued');
  const onVisible = () => { if (document.visibilityState === 'visible') kick('visible'); };
  window.addEventListener('online', onOnline);
  window.addEventListener(QUEUED_EVENT, onQueued);
  document.addEventListener('visibilitychange', onVisible);
  const interval = setInterval(() => kick('interval'), INTERVAL_MS);
  kick('start', true);

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
    window.removeEventListener('online', onOnline);
    window.removeEventListener(QUEUED_EVENT, onQueued);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
