// Test helpers for the protected local storage (offline/secureStore.js): most tests just need the key present.
import { getOfflineDb } from '../offline/db';
import { unlock, sealRows } from '../offline/secureStore';

export const TEST_PASSWORD = 'test-password';
export const unlockFor = (tenantId) => unlock(tenantId, TEST_PASSWORD, { authoritative: true });

// Stores rows the way the app does: sealed. (Writing plain rows into a sealed table is never trusted.)
export async function putSealed(tenantId, table, rows) {
  const sealed = await sealRows(tenantId, table, rows);
  await getOfflineDb(tenantId)[table].bulkPut(sealed);
}
