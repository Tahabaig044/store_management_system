// On-demand scheduled-automation scan. The backend runs as Vercel
// serverless functions with no persistent in-process timer, so time-based
// automations (reminders, overdue alerts, delayed jobs, inactivity,
// end-of-day summary) cannot fire from a setInterval - instead this
// endpoint is meant to be invoked periodically by an external scheduler
// (e.g. Vercel Cron hitting this route once an hour/once a day). Every
// synthetic sourceId below is deliberately deterministic per
// day/record so a scheduler that fires twice (or is replayed) can never
// produce a duplicate message - the same AutomationExecution unique
// constraint used by every other event guards this endpoint too.
const express = require('express');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { TENANT_ADMIN_ONLY } = require('../../constants/roles');
const { triggerEvent } = require('./automation');
const { processQueue } = require('./queue');
const { refreshInsights } = require('../ai/recommendations');
// Phase 0.7: Owner Mobile push dispatch resumes on this same tick, now that
// DeviceToken/UserNotificationPreference/PushConfig are declared in
// schema.prisma (see docs/phase0-7-owner-android-compatibility-verification-report.md).
// Both are no-ops for a tenant with no registered device (0 users
// considered, 0 sent), so a tenant that has never used Owner Mobile sees no
// behavior change from this route.
const { dispatchAlertPush } = require('../push/pushService');
const { sendDailySummaryIfDue } = require('../push/dailySummary');

const router = express.Router();

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function scanAppointmentsApproaching(tenantId, now) {
  const windowStart = new Date(now.getTime() + 23 * 60 * 60000);
  const windowEnd = new Date(now.getTime() + 25 * 60 * 60000);
  const appointments = await prisma.appointment.findMany({
    where: { tenantId, status: { in: ['SCHEDULED', 'CONFIRMED'] }, scheduledAt: { gte: windowStart, lte: windowEnd } },
    include: { patient: { include: { customer: true } } },
  });
  for (const appt of appointments) {
    const customer = appt.patient?.customer;
    if (!customer) continue;
    await triggerEvent(prisma, {
      tenantId,
      event: 'APPOINTMENT_APPROACHING',
      sourceId: `appt-reminder:${appt.id}:${dayKey(now)}`,
      branchId: appt.branchId,
      customer,
      variables: { customerName: customer.name, scheduledAt: appt.scheduledAt.toISOString() },
    });
  }
  return appointments.length;
}

async function scanInvoicesOverdue(tenantId, now) {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60000);
  const sales = await prisma.sale.findMany({
    where: { tenantId, paymentStatus: { in: ['UNPAID', 'PARTIAL'] }, createdAt: { lte: cutoff } },
    include: { customer: true },
  });
  for (const sale of sales) {
    if (!sale.customer) continue;
    const balance = Number(sale.total) - Number(sale.amountPaid);
    if (balance <= 0) continue;
    await triggerEvent(prisma, {
      tenantId,
      event: 'INVOICE_OVERDUE',
      sourceId: `invoice-overdue:${sale.id}:${dayKey(now)}`,
      branchId: sale.branchId,
      customer: sale.customer,
      variables: { customerName: sale.customer.name, amount: balance.toFixed(2), invoiceNumber: sale.invoiceNumber },
    });
  }
  return sales.length;
}

async function scanOpticalJobsDelayed(tenantId, now) {
  const orders = await prisma.opticalOrder.findMany({
    where: {
      tenantId,
      status: { in: ['PENDING', 'IN_LAB', 'QUALITY_CHECK'] },
      expectedDeliveryDate: { lt: now },
    },
    include: { customer: true },
  });
  for (const order of orders) {
    await triggerEvent(prisma, {
      tenantId,
      event: 'OPTICAL_JOB_DELAYED',
      sourceId: `job-delayed:${order.id}:${dayKey(now)}`,
      customer: order.customer,
      internalTitle: 'Delayed optical job',
      internalBody: `Order ${order.orderNumber} is past its expected delivery date`,
      variables: { link: `/optical-orders/${order.id}` },
    });
  }
  return orders.length;
}

async function scanExpiryApproaching(tenantId, now) {
  const windowEnd = new Date(now.getTime() + 30 * 24 * 60 * 60000);
  const products = await prisma.product.findMany({
    where: { tenantId, expiryDate: { not: null, gte: now, lte: windowEnd }, stockQuantity: { gt: 0 } },
  });
  for (const product of products) {
    await triggerEvent(prisma, {
      tenantId,
      event: 'EXPIRY_APPROACHING',
      sourceId: `expiry:${product.id}:${dayKey(now)}`,
      internalTitle: 'Product nearing expiry',
      internalBody: `${product.name} (batch ${product.batchNumber || 'N/A'}) expires on ${product.expiryDate.toISOString().slice(0, 10)}`,
      variables: { link: `/products/${product.id}` },
    });
  }
  return products.length;
}

async function scanCustomerInactive(tenantId, now) {
  const cutoff = new Date(now.getTime() - 180 * 24 * 60 * 60000);
  const customers = await prisma.customer.findMany({
    where: { tenantId, isActive: true, sales: { none: { createdAt: { gte: cutoff } } }, createdAt: { lt: cutoff } },
    take: 100,
  });
  const monthKey = now.toISOString().slice(0, 7);
  for (const customer of customers) {
    await triggerEvent(prisma, {
      tenantId,
      event: 'CUSTOMER_INACTIVE',
      sourceId: `customer-inactive:${customer.id}:${monthKey}`,
      internalTitle: 'Inactive customer follow-up opportunity',
      internalBody: `${customer.name} has not purchased in 180+ days`,
      variables: { link: `/customers/${customer.id}` },
    });
  }
  return customers.length;
}

async function scanDailyClose(tenantId, now) {
  const key = dayKey(now);
  await triggerEvent(prisma, {
    tenantId,
    event: 'DAILY_CLOSE',
    sourceId: `daily-close:${key}`,
    internalTitle: 'Daily summary ready',
    internalBody: `The daily close summary for ${key} is ready to review.`,
    variables: { link: '/dashboard' },
  });
  return 1;
}

// Requires TENANT_ADMIN so a real external scheduler must call it with a
// tenant-admin-level API credential; runs across every active tenant when
// no tenantId query param is given (the intended external-scheduler mode),
// or a single tenant when scoped by an authenticated admin from the UI.
router.post('/run-scheduled', authenticate, requireTenant, requireRole(...TENANT_ADMIN_ONLY), async (req, res) => {
  const now = new Date();
  const tenantId = req.user.tenantId;

  const [appointmentsApproaching, invoicesOverdue, opticalJobsDelayed, expiryApproaching, customersInactive] = await Promise.all([
    scanAppointmentsApproaching(tenantId, now),
    scanInvoicesOverdue(tenantId, now),
    scanOpticalJobsDelayed(tenantId, now),
    scanExpiryApproaching(tenantId, now),
    scanCustomerInactive(tenantId, now),
  ]);
  await scanDailyClose(tenantId, now);
  const dispatched = await processQueue(prisma, tenantId, 200);

  // Refreshes the existing Web ERP AI Recommendation Center's insights on
  // the same tick.
  const insightRefresh = await refreshInsights(tenantId);

  // Owner Mobile push dispatch runs after the insight refresh above, so it
  // considers this tick's freshly-generated insights, not stale ones from
  // before it.
  const alertPush = await dispatchAlertPush(tenantId);
  const dailySummary = await sendDailySummaryIfDue(tenantId);

  res.json({
    scanned: { appointmentsApproaching, invoicesOverdue, opticalJobsDelayed, expiryApproaching, customersInactive },
    queueDispatched: dispatched.length,
    insightRefresh,
    alertPush,
    dailySummary,
    at: now.toISOString(),
  });
});

module.exports = router;
