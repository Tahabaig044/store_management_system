// Phase 3.4: protection of the personal and financial data a terminal keeps for offline use.
//
// THREAT MODEL (stated plainly, because "encrypted" can promise more than it delivers):
//   Protected      the customer/supplier records and the history / open-document / note lists stored in
//                  IndexedDB are AES-256-GCM sealed. Someone who copies the browser profile, or reads the
//                  database with tools (or another script/profile) that do not have this user's password,
//                  sees only ciphertext.
//   How            each user's database holds a random data key WRAPPED by a key derived from that user's
//                  password (PBKDF2-SHA-256). The unwrapped key lives only in memory and is imported
//                  non-extractable. It is set when the user signs in (the password is in hand) and lost when
//                  they sign out or the page is closed; after a restart the sealed data stays locked until
//                  the password is typed again (offline included - a wrong password simply fails to unwrap).
//                  Every record is bound to its table and id (AAD), so a sealed row cannot be moved to
//                  another record, and tampering is detected.
//   NOT protected  (a) anything while this user is signed in on an unlocked device - the page itself can read
//                  it, as can anyone using the open session; (b) the unsent queue and the product / stock /
//                  branch / warehouse cache: the sync engine and stock overlay need them in the clear, and they
//                  hold ids, quantities and amounts rather than contact details; (c) the session token, which
//                  the app already keeps in localStorage.
//   Fails closed   with no WebCrypto (an insecure context) or no key, sealed datasets are simply not stored
//                  and are shown as locked - never written in the clear.
// Sealed data is a re-downloadable cache: losing the key costs a download, never a transaction.
import { getOfflineDb, offlineDbName } from './db';

// Tables whose rows are sealed. Each is a downloaded read copy (so it is purged on sign-out and can always
// be fetched again).
export const SEALED_TABLES = ['customers', 'suppliers', 'salesHistory', 'purchasesHistory', 'returnableSales', 'returnablePurchases', 'arDocuments', 'apDocuments', 'arNotes', 'apNotes'];
export const isSealedTable = (t) => SEALED_TABLES.includes(t);

let kdfIterations = 250000;
export const __setKdfIterationsForTests = (n) => { kdfIterations = n; };

const enc = new TextEncoder();
const dec = new TextDecoder();
const keys = new Map(); // db name -> CryptoKey (memory only)
const listeners = new Set();
let version = 0;
const notify = () => { version += 1; listeners.forEach((l) => l()); };
export const subscribeSecure = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const secureVersion = () => version;

// Every function below takes either a tenant id (the current user's database) or an open database.
const dbOf = (ctx) => (typeof ctx === 'string' ? getOfflineDb(ctx) : ctx);
const nameOf = (ctx) => (typeof ctx === 'string' ? offlineDbName(ctx) : ctx.name);

const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null);
export const cryptoAvailable = () => Boolean(subtle());

// 'unavailable' (no WebCrypto) | 'locked' (no key in memory) | 'unlocked'
export function secureState(tenantId) {
  if (!cryptoAvailable()) return 'unavailable';
  return keys.has(nameOf(tenantId)) ? 'unlocked' : 'locked';
}

export class LockedError extends Error {
  constructor(message = 'Protected offline data is locked') {
    super(message);
    this.name = 'LockedError';
    this.code = 'LOCKED';
  }
}

// Stored as base64 text: plain strings survive every storage layer (and structured cloning) unchanged.
const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKek(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function createKeyring(db, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKek(password, salt, kdfIterations);
  const dataKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapped = await subtle().wrapKey('raw', dataKey, kek, { name: 'AES-GCM', iv });
  await db.meta.put({ key: 'keyring', value: { v: 1, salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped), iterations: kdfIterations } });
  // Use the non-extractable form from here on.
  return unwrap(password, { salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped), iterations: kdfIterations });
}

async function unwrap(password, ring) {
  const kek = await deriveKek(password, unb64(ring.salt), ring.iterations);
  return subtle().unwrapKey('raw', unb64(ring.wrapped), kek, { name: 'AES-GCM', iv: unb64(ring.iv) }, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function wipeSealed(db) {
  const names = SEALED_TABLES;
  await db.transaction('rw', ...names.map((t) => db[t]), db.meta, async () => {
    for (const t of names) await db[t].clear();
    for (const t of names) await db.meta.delete(`dataset:${t}`);
  });
}

// Called with the password the person just typed.
//   authoritative: the server has just accepted this password (sign-in). A keyring this password cannot open
//     is stale (password changed elsewhere, or a leftover) - replace it; the sealed cache is re-downloadable.
//   otherwise (manual unlock while possibly offline): a wrong password is just refused, changing nothing.
export async function unlock(tenantId, password, { authoritative = false } = {}) {
  if (!cryptoAvailable()) return { ok: false, reason: 'unavailable' };
  const db = dbOf(tenantId);
  const name = nameOf(tenantId);
  const ring = (await db.meta.get('keyring'))?.value;
  let key = null;
  let reset = false;
  if (ring) {
    try {
      key = await unwrap(password, ring);
    } catch {
      if (!authoritative) return { ok: false, reason: 'wrong-password' };
    }
  }
  if (!key) {
    reset = Boolean(ring);
    if (ring) await wipeSealed(db); // sealed rows belong to the old key: unreadable, so drop them
    key = await createKeyring(db, password);
  }
  keys.set(name, key);
  notify();
  return { ok: true, reset };
}

// Forgets the key (sign-out, or the terminal being locked). Sealed data stays on disk, unreadable.
export function lock(tenantId) {
  if (tenantId) keys.delete(nameOf(tenantId));
  else keys.clear();
  notify();
}

export async function hasKeyring(tenantId) {
  return Boolean((await dbOf(tenantId).meta.get('keyring'))?.value);
}

// ---------------------------------------------------------------------------------------------
// Sealing rows
// ---------------------------------------------------------------------------------------------
const aad = (table, id) => enc.encode(`${table}\u0000${id}`);

function keyFor(tenantId) {
  const k = keys.get(nameOf(tenantId));
  if (!k) throw new LockedError();
  return k;
}

export async function sealRows(tenantId, table, rows) {
  const key = keyFor(tenantId);
  const out = [];
  for (const row of rows) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(table, row.id) }, key, enc.encode(JSON.stringify(row)));
    out.push({ id: row.id, _sealed: 1, _iv: b64(iv), _ct: b64(ct) });
  }
  return out;
}

// Opens rows already read from `table`. Locked => none (the caller shows a locked notice). A row that
// fails authentication (wrong key after a reset elsewhere, corruption, tampering) is dropped and counted;
// the caller invalidates the dataset so the next sync downloads it afresh.
export async function unsealRows(tenantId, table, rawRows) {
  const key = keys.get(nameOf(tenantId));
  if (!key) return { rows: [], locked: rawRows.length > 0, failed: 0 };
  const rows = [];
  let failed = 0;
  for (const r of rawRows) {
    if (!r._sealed) { failed += 1; continue; } // an unsealed row in a sealed table is never trusted
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(r._iv), additionalData: aad(table, r.id) }, key, unb64(r._ct));
      rows.push(JSON.parse(dec.decode(pt)));
    } catch {
      failed += 1;
    }
  }
  return { rows, locked: false, failed };
}

// Reads and opens a whole sealed table. Dexie reads happen BEFORE any crypto await, so this is safe inside
// a liveQuery (which only tracks reads made before its first non-Dexie await).
export async function readSealed(tenantId, table) {
  const raw = await dbOf(tenantId).table(table).toArray();
  const res = await unsealRows(tenantId, table, raw);
  if (res.failed > 0) invalidateDataset(tenantId, table).catch(() => {});
  return res.rows;
}

// Opens rows the caller already read (the shape a liveQuery needs: all Dexie reads first, crypto after).
export async function openRaw(ctx, table, raw) {
  const res = await unsealRows(ctx, table, raw);
  if (res.failed > 0) invalidateDataset(ctx, table).catch(() => {});
  return res.rows;
}

export async function readSealedRow(tenantId, table, id) {
  const raw = await dbOf(tenantId).table(table).get(id);
  if (!raw) return undefined;
  return (await unsealRows(tenantId, table, [raw])).rows[0];
}

// Forces the next sync to download `table` again (drops what cannot be read and its version record).
export async function invalidateDataset(tenantId, table) {
  const db = dbOf(tenantId);
  await db.transaction('rw', db[table], db.meta, async () => {
    await db[table].clear();
    await db.meta.delete(`dataset:${table}`);
  });
}
