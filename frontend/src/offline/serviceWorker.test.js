import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Runs the real public/service-worker.js against fake browser primitives, so the offline behavior of
// the shipped file (not a re-implementation of it) is what is verified.
const source = fs.readFileSync(path.resolve(__dirname, '../../public/service-worker.js'), 'utf8');

function load({ online, existing = {}, indexHtml = '', windows = [] } = {}) {
  const store = new Map(Object.entries(existing));
  const handlers = {};
  const cache = {
    addAll: async (urls) => { for (const u of urls) store.set(u, { url: u }); },
    add: async (u) => { store.set(u, { url: u }); },
    put: async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res); },
  };
  const caches = {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
    match: async (req) => store.get(typeof req === 'string' ? req : new URL(req.url).pathname) ?? store.get(typeof req === 'string' ? req : req.url),
  };
  const fetchMock = vi.fn(async (req) => {
    if (!online) throw new TypeError('Failed to fetch');
    const url = typeof req === 'string' ? req : req.url;
    if (url.endsWith('/index.html')) return { ok: true, text: async () => indexHtml, clone: () => ({}) };
    return { ok: true, clone: () => ({}) };
  });
  const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: () => {}, clients: { claim: () => {}, matchAll: async () => windows } };
  new Function('self', 'caches', 'fetch', 'URL', source)(self, caches, fetchMock, URL);
  return { handlers, store, fetchMock };
}

const nav = (pathname) => ({ method: 'GET', mode: 'navigate', url: `https://shop.test${pathname}` });
const asset = (pathname) => ({ method: 'GET', mode: 'no-cors', url: `https://shop.test${pathname}` });

async function respond(handlers, request) {
  let result;
  handlers.fetch({ request, respondWith: (p) => { result = p; } });
  return result === undefined ? undefined : result;
}

describe('service worker (Phase 3.1)', () => {
  it('opening a client-side route offline (e.g. /BizOS/pos after a browser restart) serves the cached app shell', async () => {
    const { handlers } = load({ online: false, existing: { '/BizOS/index.html': { url: '/BizOS/index.html', shell: true } } });
    const res = await respond(handlers, nav('/BizOS/pos'));
    expect(res).toMatchObject({ shell: true });
  });

  it('a cached file is served offline; an uncached non-navigation file is simply unavailable', async () => {
    const { handlers } = load({ online: false, existing: { '/assets/app.js': { url: '/assets/app.js', cached: true } } });
    expect(await respond(handlers, asset('/assets/app.js'))).toMatchObject({ cached: true });
    expect(await respond(handlers, asset('/assets/other.js'))).toBeUndefined();
  });

  it('never intercepts API calls or non-GET requests', async () => {
    const { handlers } = load({ online: false });
    expect(await respond(handlers, asset('/api/products'))).toBeUndefined();
    expect(await respond(handlers, { method: 'POST', mode: 'cors', url: 'https://shop.test/sales' })).toBeUndefined();
  });

  it('installing precaches the shell AND the build\'s own script/style files so a cold offline start has them', async () => {
    const html = '<script type="module" src="/BizOS/assets/index-abc123.js"></script><link rel="stylesheet" href="/BizOS/assets/index-def456.css">';
    const { handlers, store } = load({ online: true, indexHtml: html });
    let done;
    handlers.install({ waitUntil: (p) => { done = p; } });
    await done;
    expect([...store.keys()]).toEqual(expect.arrayContaining(['/BizOS/', '/BizOS/index.html', '/BizOS/manifest.webmanifest', '/BizOS/assets/index-abc123.js', '/BizOS/assets/index-def456.css']));
  });

  it('installing while offline still succeeds (the runtime cache fills later)', async () => {
    const { handlers } = load({ online: false });
    let done;
    handlers.install({ waitUntil: (p) => { done = p; } });
    await expect(done).resolves.toBeUndefined();
  });
});

describe('service worker background sync (Phase 3.4)', () => {
  it('a sync event wakes every open window - it never sends transactions itself', async () => {
    const posted = [];
    const windows = [{ postMessage: (m) => posted.push(m) }, { postMessage: (m) => posted.push(m) }];
    const { handlers, fetchMock } = load({ online: true, windows });
    let done;
    handlers.sync({ tag: 'akvf-sync', waitUntil: (p) => { done = p; } });
    await done;
    expect(posted).toEqual([{ type: 'akvf-background-sync', reason: 'sync' }, { type: 'akvf-background-sync', reason: 'sync' }]);
    expect(fetchMock).not.toHaveBeenCalled(); // no network call of its own: the app's engine does the sending
  });

  it('with no window open the sync event fails, so the browser retries it later (the queue stays intact)', async () => {
    const { handlers } = load({ online: true, windows: [] });
    let done;
    handlers.sync({ tag: 'akvf-sync', waitUntil: (p) => { done = p; } });
    await expect(done).rejects.toThrow(/no window/);
  });

  it('ignores tags that are not its own, and a periodic sync with no window is quietly skipped', async () => {
    const { handlers } = load({ online: true, windows: [] });
    let called = false;
    handlers.sync({ tag: 'something-else', waitUntil: () => { called = true; } });
    expect(called).toBe(false);
    let done;
    handlers.periodicsync({ tag: 'akvf-periodic', waitUntil: (p) => { done = p; } });
    await expect(done).resolves.toBeUndefined();
  });
});
