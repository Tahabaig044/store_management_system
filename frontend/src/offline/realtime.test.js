// Phase 3.4: realtime refresh, background sync wiring, persistent storage and the full-device path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readEvents, startRealtime } from './realtime';
import { requestPersistentStorage, registerBackgroundSync, backgroundCapabilities, startReliability } from './reliability';
import { getOfflineDb } from './db';
import { OUTBOXES } from './syncEngine';

vi.mock('../api/client', () => ({ default: { defaults: { baseURL: 'http://api.test/api' }, get: vi.fn(), post: vi.fn() } }));
vi.mock('./syncCoordinator', async (orig) => ({ ...(await orig()), processQueue: vi.fn().mockResolvedValue({}) }));
vi.mock('./localData', async (orig) => ({ ...(await orig()), syncLocalData: vi.fn().mockResolvedValue({}) }));

const setOnline = (v) => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });

// A controllable event stream: push(text) delivers a chunk, end() closes it.
function fakeStream() {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const enc = new TextEncoder();
  return { body, push: (t) => controller.enqueue(enc.encode(t)), end: () => controller.close() };
}
const sse = (name) => `event: ${name}\ndata: {}\n\n`;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { setOnline(true); });
afterEach(() => { setOnline(true); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('reading the event stream', () => {
  it('parses events split across chunks and ignores keepalive comments', async () => {
    const s = fakeStream();
    const seen = [];
    const done = readEvents(s.body, (n) => seen.push(n));
    s.push('retry: 5000\n\n: keepalive\n\nevent: rea');
    s.push('dy\ndata: {}\n\n');
    s.push(sse('changed'));
    s.end();
    await done;
    expect(seen).toEqual(['ready', 'changed']);
  });
});

describe('realtime refresh (client)', () => {
  it('refreshes at once when connected (catching up on anything missed) and once per burst of changes', async () => {
    const s = fakeStream();
    const onChange = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, body: s.body });
    const stop = startRealtime('t1', { fetchImpl, onChange, getToken: () => 'tok', baseUrl: 'http://api.test/api', debounceMs: 20, minGapMs: 0 });
    await tick(10);
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/sync/stream', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }));
    s.push(sse('ready'));
    await tick(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    s.push(sse('changed') + sse('changed') + sse('changed'));
    await tick(80);
    expect(onChange).toHaveBeenCalledTimes(2); // three pushes, one refresh
    stop();
  });

  it('event-driven refreshes are spaced at least minGapMs apart, however many changes arrive', async () => {
    const s = fakeStream();
    const onChange = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, body: s.body });
    const stop = startRealtime('t1', { fetchImpl, onChange, getToken: () => 'tok', baseUrl: 'http://api.test/api', debounceMs: 10, minGapMs: 300 });
    await tick(10);
    s.push(sse('changed'));
    await tick(40);
    expect(onChange).toHaveBeenCalledTimes(1); // first change: nothing recent, refreshes after the short debounce
    s.push(sse('changed'));
    await tick(100);
    expect(onChange).toHaveBeenCalledTimes(1); // second change within the gap: held back
    await tick(300);
    expect(onChange).toHaveBeenCalledTimes(2); // ...and released once the gap has passed
    stop();
  });

  it('a stream that is refused or drops is retried with backoff, never hammered; a 401 stops it', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const stop = startRealtime('t1', { fetchImpl, onChange: vi.fn(), getToken: () => 'tok', baseUrl: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000); // next wait is 4 s, so not yet
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    stop();

    const unauthorized = vi.fn().mockResolvedValue({ ok: false, status: 401, body: null });
    const stop2 = startRealtime('t1', { fetchImpl: unauthorized, onChange: vi.fn(), getToken: () => 'tok', baseUrl: 'x' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(unauthorized).toHaveBeenCalledTimes(1); // the session is over: no retry loop
    stop2();
  });

  it('no token, or offline: it does not connect at all', async () => {
    const fetchImpl = vi.fn();
    startRealtime('t1', { fetchImpl, getToken: () => null, baseUrl: 'x' })();
    setOnline(false);
    startRealtime('t1', { fetchImpl, getToken: () => 'tok', baseUrl: 'x' })();
    await tick(20);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('persistent storage and background sync', () => {
  it('asks the browser not to evict the queue, and reports plainly when it cannot', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: { persist, persisted: vi.fn().mockResolvedValue(false) } }));
    expect(await requestPersistentStorage()).toEqual({ supported: true, persisted: true });
    expect(persist).toHaveBeenCalled();
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { storage: undefined }));
    expect(await requestPersistentStorage()).toEqual({ supported: false, persisted: false });
    vi.unstubAllGlobals();
  });

  it('registers a background sync where supported and reports unsupported browsers honestly', async () => {
    const register = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { serviceWorker: { ready: Promise.resolve({ sync: { register } }) } }));
    expect(await registerBackgroundSync()).toEqual({ registered: true });
    expect(register).toHaveBeenCalledWith('akvf-sync');
    expect(await backgroundCapabilities()).toMatchObject({ serviceWorker: true, backgroundSync: true, periodicSync: false });

    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { serviceWorker: { ready: Promise.resolve({}) } }));
    expect(await registerBackgroundSync()).toEqual({ registered: false, reason: 'unsupported' });
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { serviceWorker: undefined }));
    delete navigator.serviceWorker;
    vi.unstubAllGlobals();
  });

  it('a message from the service worker runs the normal sync and a data refresh - nothing else', async () => {
    const { processQueue } = await import('./syncCoordinator');
    const { syncLocalData } = await import('./localData');
    const listeners = {};
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { serviceWorker: { addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: () => {}, ready: new Promise(() => {}) }, storage: undefined }));
    const stop = startReliability('t1');
    listeners.message({ data: { type: 'something-else' } });
    expect(processQueue).not.toHaveBeenCalled();
    listeners.message({ data: { type: 'akvf-background-sync', reason: 'sync' } });
    expect(processQueue).toHaveBeenCalledWith('t1', { force: true });
    expect(syncLocalData).toHaveBeenCalledWith('t1', { reason: 'background-sync' });
    stop();
    vi.unstubAllGlobals();
  });
});

describe('a full device', () => {
  it('says so plainly, saves nothing, and leaves the queue as it was', async () => {
    const tenantId = `q-${crypto.randomUUID()}`;
    const db = getOfflineDb(tenantId);
    const keep = await OUTBOXES.expenses.queue(tenantId, { amount: 1, description: 'first', method: 'cash' });
    vi.spyOn(db.pendingExpenses, 'add').mockRejectedValue(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    await expect(OUTBOXES.expenses.queue(tenantId, { amount: 2, description: 'second', method: 'cash' })).rejects.toMatchObject({ code: 'STORAGE_FULL', message: expect.stringMatching(/out of storage/) });
    vi.restoreAllMocks();
    const rows = await db.pendingExpenses.toArray();
    expect(rows.map((r) => r.clientId)).toEqual([keep.clientId]);
  });
});
