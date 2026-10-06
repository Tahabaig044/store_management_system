// Phase 7 clinical/optical reports. Doctor performance, lab turnaround, and
// prescription history already exist as dedicated endpoints
// (GET /doctors/:id/activity, /labs/:id/queue, /clinical-prescriptions) -
// this module covers the remaining report types.
const express = require('express');
const prisma = require('../../config/prisma');
const { dateRange } = require('../../utils/dateRange');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireModule } = require('../../middleware/moduleAccess');
const { NotFoundError } = require('../../utils/errors');
const { branchScopeWhere } = require('../../middleware/branchScope');

const router = express.Router();
router.use(authenticate, requireTenant, requireModule('OPTICAL'));

function num(v) { return Number(v || 0); }

// 1. Patient Visit Report
router.get('/patient-visits', requirePermission('PATIENT', 'VIEW'), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const { patientId } = req.query;
  const appointments = await prisma.appointment.findMany({
    where: { tenantId: req.user.tenantId, scheduledAt: { gte: from, lte: to }, ...(patientId && { patientId }), ...(await branchScopeWhere(prisma, req.user)) },
    include: { patient: { include: { customer: true } }, doctor: true },
    orderBy: { scheduledAt: 'desc' },
  });
  res.json({ from, to, rows: appointments, count: appointments.length });
});

// 2. Appointment Report
router.get('/appointments', requirePermission('APPOINTMENT', 'VIEW'), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const appointments = await prisma.appointment.findMany({
    where: { tenantId: req.user.tenantId, scheduledAt: { gte: from, lte: to }, ...(await branchScopeWhere(prisma, req.user)) },
    include: { patient: { include: { customer: true } }, doctor: true },
    orderBy: { scheduledAt: 'asc' },
  });
  const byStatus = {};
  for (const a of appointments) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  res.json({ from, to, rows: appointments, byStatus, count: appointments.length });
});

// 3. Examination / Refraction Report
router.get('/examinations', requirePermission('EXAMINATION', 'VIEW'), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const { doctorId } = req.query;
  const rows = await prisma.examination.findMany({
    where: { tenantId: req.user.tenantId, examDate: { gte: from, lte: to }, ...(doctorId && { doctorId }) },
    include: { patient: { include: { customer: true } }, doctor: true },
    orderBy: { examDate: 'desc' },
  });
  res.json({ from, to, rows, count: rows.length });
});

// 4. Pending/Delayed Job Report
router.get('/pending-delayed-jobs', requirePermission('REPORT', 'VIEW'), async (req, res) => {
  const scope = await branchScopeWhere(prisma, req.user);
  const jobs = await prisma.opticalOrder.findMany({
    where: { tenantId: req.user.tenantId, status: { notIn: ['DELIVERED', 'CANCELLED'] }, ...scope },
    include: { customer: true, lab: true },
    orderBy: { expectedDeliveryDate: 'asc' },
  });
  const now = new Date();
  const rows = jobs.map((j) => ({
    ...j,
    isDelayed: !!(j.expectedDeliveryDate && new Date(j.expectedDeliveryDate) < now),
  }));
  res.json({ rows, pendingCount: rows.length, delayedCount: rows.filter((r) => r.isDelayed).length });
});

// 5. Optical Sales / Profitability Report - profitability here means
// revenue minus lab cost, since optical orders (frame/lens descriptions)
// aren't linked to tracked Product/inventory cost the way a Sale is.
router.get('/optical-profitability', requirePermission('REPORT', 'VIEW'), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const scope = await branchScopeWhere(prisma, req.user);
  const orders = await prisma.opticalOrder.findMany({
    where: { tenantId: req.user.tenantId, status: { not: 'CANCELLED' }, createdAt: { gte: from, lte: to }, ...scope },
    select: { id: true, orderNumber: true, totalAmount: true, labCost: true },
  });
  const revenue = orders.reduce((s, o) => s + num(o.totalAmount), 0);
  const labCost = orders.reduce((s, o) => s + num(o.labCost), 0);
  res.json({ from, to, count: orders.length, revenue, labCost, profit: revenue - labCost, rows: orders });
});

// 6. Customer Retention / Repeat-Purchase Report - a customer counts as
// "retained" if they have more than one completed sale or optical order.
router.get('/customer-retention', requirePermission('REPORT', 'VIEW'), async (req, res) => {
  const tenantId = req.user.tenantId;
  const [sales, opticalOrders] = await Promise.all([
    prisma.sale.findMany({ where: { tenantId, status: 'COMPLETED', customerId: { not: null } }, select: { customerId: true } }),
    prisma.opticalOrder.findMany({ where: { tenantId, status: { not: 'CANCELLED' } }, select: { customerId: true } }),
  ]);
  const countByCustomer = new Map();
  for (const s of [...sales, ...opticalOrders]) {
    countByCustomer.set(s.customerId, (countByCustomer.get(s.customerId) || 0) + 1);
  }
  const repeatCustomers = [...countByCustomer.values()].filter((c) => c > 1).length;
  res.json({
    totalCustomersWithActivity: countByCustomer.size,
    repeatCustomers,
    oneTimeCustomers: countByCustomer.size - repeatCustomers,
    retentionRatePercent: countByCustomer.size > 0 ? (repeatCustomers / countByCustomer.size) * 100 : 0,
  });
});

// 7. New vs Returning Customer Report
router.get('/new-vs-returning', requirePermission('REPORT', 'VIEW'), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;
  const [newCustomers, activeInRange] = await Promise.all([
    prisma.customer.count({ where: { tenantId, createdAt: { gte: from, lte: to } } }),
    prisma.sale.findMany({ where: { tenantId, status: 'COMPLETED', createdAt: { gte: from, lte: to }, customerId: { not: null } }, select: { customer: { select: { id: true, createdAt: true } } }, distinct: ['customerId'] }),
  ]);
  const returning = activeInRange.filter((s) => s.customer && new Date(s.customer.createdAt) < from).length;
  res.json({ from, to, newCustomers, returningCustomers: returning });
});

// 8. Customer Outstanding Report - unpaid sales + optical order balances,
// per customer.
router.get('/customer-outstanding', requirePermission('REPORT', 'VIEW'), async (req, res) => {
  const tenantId = req.user.tenantId;
  const [sales, opticalOrders] = await Promise.all([
    prisma.sale.findMany({ where: { tenantId, status: 'COMPLETED', paymentStatus: { not: 'PAID' } }, include: { customer: true } }),
    prisma.opticalOrder.findMany({ where: { tenantId, status: { not: 'CANCELLED' } }, include: { customer: true } }),
  ]);
  const byCustomer = new Map();
  const bucket = (c) => {
    if (!byCustomer.has(c.id)) byCustomer.set(c.id, { customerId: c.id, customerName: c.name, outstanding: 0 });
    return byCustomer.get(c.id);
  };
  for (const s of sales) {
    const due = num(s.total) - num(s.amountPaid);
    if (due > 0 && s.customer) bucket(s.customer).outstanding += due;
  }
  for (const o of opticalOrders) {
    const due = num(o.totalAmount) - num(o.amountPaid);
    if (due > 0 && o.customer) bucket(o.customer).outstanding += due;
  }
  const rows = [...byCustomer.values()].filter((r) => r.outstanding > 0.001).sort((a, b) => b.outstanding - a.outstanding);
  res.json({ rows, total: rows.reduce((s, r) => s + r.outstanding, 0) });
});

// 9. Branch-wise Clinic/Optical Report
router.get('/branch-clinic-optical', requirePermission('REPORT', 'VIEW'), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;
  const [branches, appointments, opticalOrders] = await Promise.all([
    prisma.branch.findMany({ where: { tenantId } }),
    prisma.appointment.findMany({ where: { tenantId, scheduledAt: { gte: from, lte: to } }, select: { branchId: true } }),
    prisma.opticalOrder.findMany({ where: { tenantId, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } }, select: { branchId: true, totalAmount: true } }),
  ]);
  const byBranch = new Map();
  for (const b of branches) byBranch.set(b.id, { branchId: b.id, branchName: b.name, appointments: 0, opticalOrders: 0, opticalRevenue: 0 });
  byBranch.set('unassigned', { branchId: null, branchName: 'Unassigned', appointments: 0, opticalOrders: 0, opticalRevenue: 0 });
  for (const a of appointments) {
    const key = a.branchId || 'unassigned';
    const bucket = byBranch.get(key) || byBranch.get('unassigned');
    bucket.appointments += 1;
  }
  for (const o of opticalOrders) {
    const key = o.branchId || 'unassigned';
    const bucket = byBranch.get(key) || byBranch.get('unassigned');
    bucket.opticalOrders += 1;
    bucket.opticalRevenue += num(o.totalAmount);
  }
  res.json({ from, to, rows: [...byBranch.values()].filter((b) => b.appointments > 0 || b.opticalOrders > 0) });
});

// 10. Prescription-to-Order Conversion Report
router.get('/prescription-conversion', requirePermission('PRESCRIPTION', 'VIEW'), async (req, res) => {
  const { from, to } = dateRange(req.query);
  const tenantId = req.user.tenantId;
  const prescriptions = await prisma.clinicalPrescription.findMany({
    where: { tenantId, issueDate: { gte: from, lte: to } },
    select: { id: true, patientId: true, opticalOrders: { select: { id: true } } },
  });
  const converted = prescriptions.filter((p) => p.opticalOrders.length > 0).length;
  res.json({
    from,
    to,
    totalPrescriptions: prescriptions.length,
    convertedToOrder: converted,
    conversionRatePercent: prescriptions.length > 0 ? (converted / prescriptions.length) * 100 : 0,
  });
});

module.exports = router;
