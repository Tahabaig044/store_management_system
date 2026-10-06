// Phase 3.4: data-integrity checks on this device's unsent queue and on the ability to open its database.
//
// The queue is the one thing on the device that cannot be re-downloaded, so it is checked, never trusted:
//   - an entry that is not a well-formed queue entry (no payload, an unknown status, no creation time) can
//     only be the product of corruption or a bug. It is NOT deleted: it is marked as a visible, non-retryable
//     failure ("damaged") so a person sees it, and it can no longer disturb the rest of the queue.
//   - two live entries carrying the same idempotency key are reported (the server would apply only one, so
//     it is safe, but it means something queued the same thing twice);
//   - an entry waiting on a record that no longer exists is handled by the coordinator itself (it becomes a
//     visible failure) and is only counted here.
// Nothing here changes what a well-formed entry says. The result is kept in `meta.integrityAudit`.
import { getOfflineDb } from './db';
import { registeredTables } from './syncCore';

const STATUSES = ['pending', 'syncing', 'synced', 'conflict', 'failed', 'blocked'];

export function entryProblem(e) {
  if (!e || typeof e !== 'object') return 'not an object';
  if (!e.clientId) return 'no id';
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) return 'no readable content';
  if (!STATUSES.includes(e.status)) return `unknown status "${e.status}"`;
  if (typeof e.createdAt !== 'number' || Number.isNaN(e.createdAt)) return 'no creation time';
  return null;
}

export async function auditLocalStore(tenantId) {
  const db = getOfflineDb(tenantId);
  const report = { checkedAt: Date.now(), entries: 0, damaged: [], duplicateKeys: [], danglingReferences: 0 };
  const ids = new Set();
  const all = [];
  for (const table of registeredTables()) {
    for (const e of await db[table].toArray()) {
      report.entries += 1;
      all.push({ table, e });
      if (e?.clientId) ids.add(e.clientId);
    }
  }
  const keys = new Map();
  for (const { table, e } of all) {
    const problem = entryProblem(e);
    if (problem) {
      report.damaged.push({ table, clientId: e?.clientId ?? null, problem });
      if (e?.clientId && e.status !== 'failed') {
        const message = `This entry is damaged (${problem}) and cannot be sent`;
        await db[table].update(e.clientId, { status: 'failed', failure: { kind: 'CORRUPT', code: null, status: null, message, at: Date.now() }, lastError: message, nextAttemptAt: null, blockedBy: null, maybeApplied: false });
      }
      continue;
    }
    if (e.status === 'synced') continue;
    const key = e.payload.idempotencyKey;
    if (key) {
      const k = `${table}:${key}`;
      if (keys.has(k)) report.duplicateKeys.push({ table, idempotencyKey: key, clientIds: [keys.get(k), e.clientId] });
      else keys.set(k, e.clientId);
    }
    for (const dep of e.dependsOn || []) if (!ids.has(dep)) report.danglingReferences += 1;
  }
  await db.meta.put({ key: 'integrityAudit', value: report });
  return report;
}

// Can this device's database be opened at all? (Corruption, a blocked upgrade in another tab, a browser that
// refuses IndexedDB - e.g. some private modes.) The answer is reported, never thrown.
export async function checkOfflineDb(tenantId) {
  try {
    const db = getOfflineDb(tenantId);
    await db.open();
    await db.meta.get('scope'); // a real read, not just an open handle
    return { ok: true };
  } catch (err) {
    return { ok: false, name: err?.name || 'Error', message: err?.message || String(err) };
  }
}
