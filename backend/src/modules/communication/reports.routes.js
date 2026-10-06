// Phase 8 communication/automation reports. Volume/status stats already
// exist on GET /api/communication/messages/stats for the Communication
// Center itself - this module covers the remaining report types the phase
// calls for: delivery/failure breakdowns, automation execution history,
// and per-category/per-branch communication activity.
const express = require('express');
const prisma = require('../../config/prisma');
const { dateRange } = require('../../utils/dateRange');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { MANAGEMENT } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { branchScopeWhere, getAccessibleBranchIds } = require('../../middleware/branchScope');

const router = express.Router();
router.use(authenticate, requireTenant, requirePermission('COMMUNICATION', 'VIEW'));

// 1. Communication Volume Report - by channel and status.
router.get('/volume', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const rows = await prisma.message.findMany({
    where: { tenantId: req.user.tenantId, queuedAt: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    select: { channel: true, status: true },
  });
  const byChannel = {};
  const byStatus = {};
  for (const r of rows) {
    byChannel[r.channel] = (byChannel[r.channel] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  res.json({ from, to, total: rows.length, byChannel, byStatus });
});

// 2. WhatsApp Delivery/Failure Report.
router.get('/whatsapp-delivery', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const rows = await prisma.message.findMany({
    where: { tenantId: req.user.tenantId, channel: 'WHATSAPP', queuedAt: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    select: { status: true, failureReason: true },
  });
  const sent = rows.filter((r) => ['SENT', 'DELIVERED', 'READ'].includes(r.status)).length;
  const failed = rows.filter((r) => r.status === 'FAILED').length;
  const failureReasons = {};
  for (const r of rows) {
    if (r.status === 'FAILED' && r.failureReason) failureReasons[r.failureReason] = (failureReasons[r.failureReason] || 0) + 1;
  }
  res.json({
    from,
    to,
    total: rows.length,
    sent,
    failed,
    pending: rows.length - sent - failed,
    deliveryRatePercent: rows.length > 0 ? (sent / rows.length) * 100 : 0,
    failureReasons,
  });
});

// 3. Automation Execution Report - by event and outcome.
router.get('/automation-executions', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const rows = await prisma.automationExecution.findMany({
    where: { tenantId: req.user.tenantId, createdAt: { gte: from, lte: to } },
    include: { automationRule: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const byEvent = {};
  const byStatus = {};
  for (const r of rows) {
    byEvent[r.event] = (byEvent[r.event] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  res.json({
    from,
    to,
    total: rows.length,
    byEvent,
    byStatus,
    recentFailures: rows.filter((r) => r.status === 'FAILED').slice(0, 20).map((r) => ({ id: r.id, event: r.event, ruleName: r.automationRule?.name, error: r.error, at: r.createdAt })),
  });
});

// 4. Customer Follow-up Report - portal-originated follow-up/callback requests.
router.get('/customer-follow-up', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const rows = await prisma.notification.findMany({
    where: { tenantId: req.user.tenantId, type: 'PORTAL_FOLLOW_UP_REQUEST', createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ from, to, total: rows.length, outstanding: rows.filter((r) => !r.isRead).length, rows });
});

// 5. Appointment Reminder Report - APPOINTMENT_APPROACHING / APPOINTMENT_BOOKED sends.
router.get('/appointment-reminders', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const rows = await prisma.message.findMany({
    where: { tenantId: req.user.tenantId, sourceEventType: { in: ['APPOINTMENT_APPROACHING', 'APPOINTMENT_BOOKED'] }, queuedAt: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    select: { sourceEventType: true, status: true },
  });
  const byEvent = {};
  for (const r of rows) byEvent[r.sourceEventType] = (byEvent[r.sourceEventType] || 0) + 1;
  res.json({ from, to, total: rows.length, byEvent, sent: rows.filter((r) => ['SENT', 'DELIVERED', 'READ'].includes(r.status)).length });
});

// 6. Payment Reminder Report - INVOICE_OVERDUE sends.
router.get('/payment-reminders', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const rows = await prisma.message.findMany({
    where: { tenantId: req.user.tenantId, sourceEventType: 'INVOICE_OVERDUE', queuedAt: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    select: { status: true },
  });
  res.json({ from, to, total: rows.length, sent: rows.filter((r) => ['SENT', 'DELIVERED', 'READ'].includes(r.status)).length });
});

// 7. Optical Order Notification Report - order lifecycle messages.
router.get('/optical-order-notifications', async (req, res) => {
  const { from, to } = dateRange(req.query);
  const events = ['OPTICAL_ORDER_CREATED', 'OPTICAL_JOB_READY', 'OPTICAL_ORDER_DELIVERED', 'OPTICAL_JOB_DELAYED'];
  const rows = await prisma.message.findMany({
    where: { tenantId: req.user.tenantId, sourceEventType: { in: events }, queuedAt: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    select: { sourceEventType: true, status: true },
  });
  const byEvent = {};
  for (const e of events) byEvent[e] = 0;
  for (const r of rows) byEvent[r.sourceEventType] += 1;
  res.json({ from, to, total: rows.length, byEvent });
});

// 8. Branch-wise Communication Activity Report. Phase 0.3: this is an
// explicit cross-branch breakdown, so - unlike the other reports in this
// file - it's gated to MANAGEMENT (unrestricted by definition) rather than
// the broader COMMUNICATION_STAFF group, which includes branch-restrictable
// roles like RECEPTIONIST/ACCOUNTANT. Also fixed the same Branch-query bug
// found in accounting/reports.routes.js (filtering Branch by its own `id`,
// not a `branchId` field it doesn't have).
router.get('/branch-activity', requireRole(...MANAGEMENT), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;
  const accessibleBranchIds = await getAccessibleBranchIds(prisma, req.user);
  const [branches, rows] = await Promise.all([
    prisma.branch.findMany({ where: { tenantId, ...(accessibleBranchIds !== null ? { id: { in: accessibleBranchIds } } : {}) } }),
    prisma.message.findMany({
      where: { tenantId, queuedAt: { gte: from, lte: to }, ...(accessibleBranchIds !== null ? { branchId: { in: accessibleBranchIds } } : {}) },
      select: { branchId: true, status: true },
    }),
  ]);
  const byBranch = new Map();
  for (const b of branches) byBranch.set(b.id, { branchId: b.id, branchName: b.name, total: 0, sent: 0, failed: 0 });
  if (accessibleBranchIds === null) byBranch.set('unassigned', { branchId: null, branchName: 'Unassigned', total: 0, sent: 0, failed: 0 });
  for (const r of rows) {
    const key = r.branchId || 'unassigned';
    const bucket = byBranch.get(key) || byBranch.get('unassigned');
    bucket.total += 1;
    if (['SENT', 'DELIVERED', 'READ'].includes(r.status)) bucket.sent += 1;
    if (r.status === 'FAILED') bucket.failed += 1;
  }
  res.json({ from, to, rows: [...byBranch.values()].filter((b) => b.total > 0) });
});

module.exports = router;
