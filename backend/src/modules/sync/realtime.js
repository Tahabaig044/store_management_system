// Phase 3.4: "something changed" push for terminals, over Server-Sent Events.
//
// Why: a terminal refreshes its local copy every 60 s. When another terminal sells the last unit, or a
// return or stock adjustment lands, this tells every other terminal of the shop within about a second, so
// it re-checks its manifest (a cheap request) instead of selling against a stale number for up to a minute.
//
// What it is NOT: a data channel. An event carries no business data - only "something in your shop changed"
// - so nothing can leak across branches or roles; the terminal then pulls through the normal, permission-
// and branch-scoped /api/offline endpoints. If the stream is unavailable the terminal simply keeps its 60 s
// polling (nothing depends on the stream). State is in this process's memory, so with several server
// instances only changes made on the same instance are announced immediately (documented limitation; the
// polling covers the rest).
const DEBOUNCE_MS = 300;
const HEARTBEAT_MS = 25000;
const MAX_PER_USER = 5;
const MAX_PER_TENANT = 200;

const clients = new Map(); // tenantId -> Set<{ res, userId, timer }>
const pending = new Map(); // tenantId -> timeout handle

function send(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // A dead socket is removed by its own 'close' handler.
  }
}

// Called after any successful write request of a shop. Bursts are collapsed into one event.
function announce(tenantId) {
  const set = clients.get(tenantId);
  if (!set || set.size === 0 || pending.has(tenantId)) return;
  pending.set(tenantId, setTimeout(() => {
    pending.delete(tenantId);
    const live = clients.get(tenantId);
    if (live) for (const c of live) send(c, 'changed', { at: new Date().toISOString() });
  }, DEBOUNCE_MS));
}

// Express middleware: mount before the routes. Reads req.user AFTER the response finished (the route's own
// authenticate has set it by then), so it never needs to run authentication itself.
function announceChanges(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/sync/') && !req.path.startsWith('/auth/')) {
    res.on('finish', () => {
      if (res.statusCode < 400 && req.user?.tenantId) announce(req.user.tenantId);
    });
  }
  next();
}

// Registers one open stream. Returns false (and writes nothing) when a cap is exceeded.
function subscribe(req, res) {
  const { tenantId, id: userId } = req.user;
  const set = clients.get(tenantId) || new Set();
  if (set.size >= MAX_PER_TENANT || [...set].filter((c) => c.userId === userId).length >= MAX_PER_USER) return false;
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');
  const client = { res, userId };
  client.timer = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, HEARTBEAT_MS);
  set.add(client);
  clients.set(tenantId, set);
  send(client, 'ready', { at: new Date().toISOString() });
  const cleanup = () => {
    clearInterval(client.timer);
    set.delete(client);
    if (set.size === 0) clients.delete(tenantId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return true;
}

const stats = () => ({ tenants: clients.size, streams: [...clients.values()].reduce((n, s) => n + s.size, 0) });

module.exports = { announceChanges, announce, subscribe, stats, MAX_PER_USER, MAX_PER_TENANT };
