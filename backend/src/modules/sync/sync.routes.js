// Phase 3.3.4 - multi-terminal reconciliation: visibility and hand-off, never a second write path.
//
// Every terminal (one browser/device, identified by an id it generates once) tells the server two things
// after it has tried to sync:
//   - how much it still holds unsent (pending / conflict / failed counts, age of the oldest), and
//   - which of its queued transactions the server REFUSED (a conflict), with the machine-readable reason,
//     plus which previously reported ones are no longer a problem (synced after an edit, or discarded).
// A manager then sees, across ALL terminals, who is sitting on unsynced work, which terminals have gone
// silent while holding some, and which conflicts nobody has looked at - and can acknowledge them.
//
// What this module deliberately does NOT do: touch accounting, inventory or any queued transaction. A
// report only ever changes these two bookkeeping tables; the outboxes and their server-side guards stay
// the only way anything is applied. A report is replay-safe (upserts on a unique key) and two reports
// racing for the same terminal or issue cannot create duplicates.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { logAudit } = require('../../middleware/audit');
const { ValidationError, NotFoundError, AppError } = require('../../utils/errors');
const { subscribe } = require('./realtime');

const router = express.Router();
router.use(authenticate, requireTenant);

// A terminal that holds unsent work but has not been heard from for this long is "silent".
const SILENT_AFTER_MS = 15 * 60 * 1000;

const reportSchema = z
  .object({
    terminalId: z.string().min(8).max(100),
    label: z.string().max(100).optional(),
    // When the terminal composed this report. Reports can arrive out of order (two in flight over a bad
    // link); an older one must never overwrite a newer one.
    sentAt: z.coerce.date(),
    counts: z.object({
      pending: z.number().int().nonnegative(),
      conflict: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      oldestPendingAt: z.coerce.date().nullable().optional(),
    }),
    issues: z
      .array(
        z.object({
          clientId: z.string().min(1).max(100),
          entity: z.string().min(1).max(60),
          kind: z.string().min(1).max(60),
          code: z.string().max(60).nullish(),
          message: z.string().max(500),
          details: z.any().optional(),
        })
      )
      .max(200)
      .default([]),
    resolved: z.array(z.object({ clientId: z.string().min(1).max(100), resolution: z.enum(['synced', 'discarded']) })).max(500).default([]),
  })
  .strict();

// The terminal row for (tenant, terminalId): created on first contact. Two first reports racing each
// other both want to create it - the loser of the unique key retries and finds it.
async function ensureTerminal(tx, tenantId, terminalId) {
  return tx.syncTerminal.upsert({ where: { tenantId_terminalId: { tenantId, terminalId } }, create: { tenantId, terminalId }, update: {} });
}

async function withRetryOnRace(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      // P2002: a concurrent report created the same row first; P2034: serialization/deadlock retry.
      if ((err.code === 'P2002' || err.code === 'P2034') && attempt < 6) continue;
      throw err;
    }
  }
}

router.post('/terminal-report', async (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid terminal report', parsed.error.flatten());
  const body = parsed.data;
  const { tenantId } = req.user;

  const outcome = await withRetryOnRace(async () => {
    const terminal = await ensureTerminal(prisma, tenantId, body.terminalId);
    return prisma.$transaction(async (tx) => {
      // The claim takes the terminal's row lock for the rest of the transaction, so reports from one terminal
      // are applied one at a time, and a report older than one already applied is recognised and dropped.
      const claim = await tx.syncTerminal.updateMany({
        where: { id: terminal.id, OR: [{ lastReportSentAt: null }, { lastReportSentAt: { lte: body.sentAt } }] },
        data: {
          label: body.label,
          userId: req.user.id,
          userName: req.user.name || req.user.email || null,
          pendingCount: body.counts.pending,
          conflictCount: body.counts.conflict,
          failedCount: body.counts.failed,
          oldestPendingAt: body.counts.oldestPendingAt || null,
          lastReportSentAt: body.sentAt,
          lastSeenAt: new Date(),
        },
      });
      if (claim.count === 0) return { stale: true, acknowledged: [] };

      const now = new Date();
      for (const issue of body.issues) {
        const data = { entity: issue.entity, kind: issue.kind, code: issue.code || null, message: issue.message, details: issue.details ?? undefined, lastReportedAt: now };
        await tx.syncIssue.upsert({
          where: { terminalRecordId_clientId: { terminalRecordId: terminal.id, clientId: issue.clientId } },
          create: { tenantId, terminalRecordId: terminal.id, clientId: issue.clientId, ...data },
          update: data,
        });
        // A refusal that comes back after being resolved (edited, retried, refused again) reopens; one a
        // manager already acknowledged stays acknowledged.
        await tx.syncIssue.updateMany({
          where: { terminalRecordId: terminal.id, clientId: issue.clientId, status: 'RESOLVED' },
          data: { status: 'OPEN', resolvedAt: null, resolution: null, acknowledgedAt: null, acknowledgedById: null, acknowledgeNote: null },
        });
      }
      for (const r of body.resolved) {
        await tx.syncIssue.updateMany({
          where: { terminalRecordId: terminal.id, clientId: r.clientId, status: { not: 'RESOLVED' } },
          data: { status: 'RESOLVED', resolvedAt: now, resolution: r.resolution },
        });
      }
      const seen = await tx.syncIssue.findMany({ where: { terminalRecordId: terminal.id, status: 'ACKNOWLEDGED' }, select: { clientId: true, acknowledgeNote: true } });
      return { stale: false, acknowledged: seen };
    });
  });

  // Retention: resolved issues are history, not a to-do list - keep 90 days. A terminal that has held nothing
  // for 180 days and has not been heard from is forgotten (it re-registers on its next report).
  if (!outcome.stale) {
    const day = 86400000;
    prisma.syncIssue.deleteMany({ where: { tenantId, status: 'RESOLVED', resolvedAt: { lt: new Date(Date.now() - 90 * day) } } })
      .then(() => prisma.syncTerminal.deleteMany({ where: { tenantId, lastSeenAt: { lt: new Date(Date.now() - 180 * day) }, pendingCount: 0, conflictCount: 0, failedCount: 0 } }))
      .catch(() => {});
  }

  res.json({ ok: true, ...outcome });
});

// Phase 3.4: the "something changed" stream (see realtime.js). Any signed-in user of the shop may listen; an
// event carries no data. Capped per user and per shop so a runaway client cannot exhaust connections.
router.get('/stream', (req, res) => {
  if (!subscribe(req, res)) throw new AppError(429, 'Too many open update streams', undefined, 'TOO_MANY_STREAMS');
});

const managers = requireRole('TENANT_ADMIN', 'MANAGER');

router.get('/terminals', managers, async (req, res) => {
  const { tenantId } = req.user;
  const [terminals, open] = await Promise.all([
    prisma.syncTerminal.findMany({ where: { tenantId }, orderBy: { lastSeenAt: 'desc' }, take: 500 }),
    prisma.syncIssue.groupBy({ by: ['terminalRecordId', 'status'], where: { tenantId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, _count: { _all: true } }),
  ]);
  const byTerminal = new Map();
  for (const g of open) {
    const cur = byTerminal.get(g.terminalRecordId) || { open: 0, acknowledged: 0 };
    if (g.status === 'OPEN') cur.open = g._count._all;
    else cur.acknowledged = g._count._all;
    byTerminal.set(g.terminalRecordId, cur);
  }
  const now = Date.now();
  const items = terminals.map((t) => {
    const holdsWork = t.pendingCount + t.conflictCount + t.failedCount > 0;
    const silentForMs = now - t.lastSeenAt.getTime();
    return { ...t, openIssues: byTerminal.get(t.id)?.open || 0, acknowledgedIssues: byTerminal.get(t.id)?.acknowledged || 0, silent: holdsWork && silentForMs > SILENT_AFTER_MS, silentForMs };
  });
  const summary = {
    terminals: items.length,
    withUnsyncedWork: items.filter((t) => t.pendingCount + t.conflictCount + t.failedCount > 0).length,
    silentWithWork: items.filter((t) => t.silent).length,
    pending: items.reduce((s, t) => s + t.pendingCount, 0),
    conflicts: items.reduce((s, t) => s + t.conflictCount, 0),
    failed: items.reduce((s, t) => s + t.failedCount, 0),
    openIssues: items.reduce((s, t) => s + t.openIssues, 0),
  };
  res.json({ items, summary, silentAfterMs: SILENT_AFTER_MS });
});

router.get('/issues', managers, async (req, res) => {
  const status = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(req.query.status) ? req.query.status : undefined;
  const items = await prisma.syncIssue.findMany({
    where: { tenantId: req.user.tenantId, ...(status ? { status } : { status: { in: ['OPEN', 'ACKNOWLEDGED'] } }) },
    include: { terminal: { select: { terminalId: true, label: true, userName: true, lastSeenAt: true } } },
    orderBy: { lastReportedAt: 'desc' },
    take: 500,
  });
  res.json({ items });
});

// A manager saying "I have seen this". Atomic and idempotent: two managers pressing it together both get an
// answer, and the first acknowledgement is the one kept.
router.post('/issues/:id/acknowledge', managers, async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
  const claim = await prisma.syncIssue.updateMany({
    where: { id: req.params.id, tenantId: req.user.tenantId, status: 'OPEN' },
    data: { status: 'ACKNOWLEDGED', acknowledgedById: req.user.id, acknowledgedAt: new Date(), acknowledgeNote: note },
  });
  const item = await prisma.syncIssue.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!item) throw new NotFoundError('Issue not found');
  if (claim.count === 1) await logAudit({ req, action: 'SYNC_ISSUE_ACKNOWLEDGE', entity: 'SyncIssue', entityId: item.id, metadata: { clientId: item.clientId, kind: item.kind } });
  res.json({ item, alreadyHandled: claim.count === 0 });
});

module.exports = router;
