// Customer-facing self-service endpoints. Every query below filters by
// BOTH req.portal.tenantId AND req.portal.customerId taken from the
// verified portal JWT - never from a path or body-supplied id - so one
// customer can never read or modify another customer's (or another
// tenant's) records, even by guessing an id.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticatePortal } = require('./portalAuth');
const { NotFoundError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { FRONT_DESK } = require('../../constants/roles');
const { logAudit } = require('../../middleware/audit');

const router = express.Router();
router.use(authenticatePortal);

async function notifyStaff(tenantId, { type, title, body }) {
  const users = await prisma.user.findMany({ where: { tenantId, role: { in: FRONT_DESK }, isActive: true }, select: { id: true } });
  await Promise.all(users.map((u) => prisma.notification.create({ data: { tenantId, userId: u.id, type, title, body } })));
}

router.get('/me', async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.portal.customerId, tenantId: req.portal.tenantId },
    include: { patient: true, communicationPreference: true },
  });
  if (!customer) throw new NotFoundError();
  res.json({ customer });
});

const updateMeSchema = z.object({ email: z.string().email().optional(), address: z.string().optional() });

router.patch('/me', async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid profile data', parsed.error.flatten());
  const customer = await prisma.customer.update({
    where: { id: req.portal.customerId },
    data: parsed.data,
  });
  await logAudit({ req, action: 'PORTAL_PROFILE_UPDATE', entity: 'Customer', entityId: customer.id, metadata: { customerId: req.portal.customerId, portalEvent: true } });
  res.json({ customer });
});

router.get('/appointments', async (req, res) => {
  const patient = await prisma.patient.findFirst({ where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId } });
  if (!patient) return res.json({ items: [] });
  const items = await prisma.appointment.findMany({
    where: { patientId: patient.id, tenantId: req.portal.tenantId },
    include: { doctor: true },
    orderBy: { scheduledAt: 'desc' },
  });
  res.json({ items });
});

const requestAppointmentSchema = z.object({ preferredDate: z.string().optional(), reason: z.string().min(1).optional(), notes: z.string().optional() });

// Self-service "request an appointment" never books a slot directly -
// staff must confirm availability - so this only raises an internal
// notification for the front desk to follow up and create the real
// Appointment record themselves.
router.post('/appointments/request', async (req, res) => {
  const parsed = requestAppointmentSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid request', parsed.error.flatten());
  const customer = await prisma.customer.findFirst({ where: { id: req.portal.customerId, tenantId: req.portal.tenantId } });
  if (!customer) throw new NotFoundError();

  await notifyStaff(req.portal.tenantId, {
    type: 'PORTAL_APPOINTMENT_REQUEST',
    title: `Appointment request from ${customer.name}`,
    body: [parsed.data.preferredDate && `Preferred: ${parsed.data.preferredDate}`, parsed.data.reason, parsed.data.notes].filter(Boolean).join(' - ') || 'No further details provided',
  });
  await logAudit({ req, action: 'PORTAL_APPOINTMENT_REQUEST', entity: 'Customer', entityId: customer.id, metadata: { customerId: customer.id, portalEvent: true } });
  res.status(201).json({ message: 'Your appointment request has been sent. Our team will contact you to confirm.' });
});

const followUpSchema = z.object({ message: z.string().min(1) });

router.post('/follow-up', async (req, res) => {
  const parsed = followUpSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid request', parsed.error.flatten());
  const customer = await prisma.customer.findFirst({ where: { id: req.portal.customerId, tenantId: req.portal.tenantId } });
  if (!customer) throw new NotFoundError();

  await notifyStaff(req.portal.tenantId, {
    type: 'PORTAL_FOLLOW_UP_REQUEST',
    title: `Callback requested by ${customer.name}`,
    body: parsed.data.message,
  });
  await logAudit({ req, action: 'PORTAL_FOLLOW_UP_REQUEST', entity: 'Customer', entityId: customer.id, metadata: { customerId: customer.id, portalEvent: true } });
  res.status(201).json({ message: 'Your request has been sent. Our team will call you back soon.' });
});

router.get('/optical-orders', async (req, res) => {
  const items = await prisma.opticalOrder.findMany({
    where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId },
    include: { lab: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ items });
});

router.get('/invoices', async (req, res) => {
  const items = await prisma.sale.findMany({
    where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId },
    include: { items: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ items });
});

router.get('/payments', async (req, res) => {
  const items = await prisma.payment.findMany({
    where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId },
    orderBy: { paidAt: 'desc' },
  });
  res.json({ items });
});

router.get('/outstanding-balance', async (req, res) => {
  const [sales, opticalOrders] = await Promise.all([
    prisma.sale.findMany({ where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId, paymentStatus: { in: ['UNPAID', 'PARTIAL'] } } }),
    prisma.opticalOrder.findMany({ where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId, status: { not: 'CANCELLED' } } }),
  ]);
  const salesBalance = sales.reduce((sum, s) => sum + (Number(s.total) - Number(s.amountPaid)), 0);
  const opticalBalance = opticalOrders.reduce((sum, o) => sum + Math.max(Number(o.totalAmount) - Number(o.amountPaid), 0), 0);
  res.json({ salesBalance, opticalBalance, totalOutstanding: salesBalance + opticalBalance });
});

// Extra authorization beyond the usual tenantId+customerId scoping: a
// prescription belongs to a Patient, and a customer's own Patient link is
// re-verified here rather than trusting any prescription id directly, so
// a customer can only ever see prescriptions issued to their own patient
// record, never another patient's even within the same tenant.
router.get('/prescriptions', async (req, res) => {
  const patient = await prisma.patient.findFirst({ where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId } });
  if (!patient) return res.json({ items: [] });
  const items = await prisma.clinicalPrescription.findMany({
    where: { patientId: patient.id, tenantId: req.portal.tenantId, isActive: true },
    include: { doctor: true },
    orderBy: { issueDate: 'desc' },
  });
  res.json({ items });
});

router.get('/prescriptions/:id', async (req, res) => {
  const patient = await prisma.patient.findFirst({ where: { customerId: req.portal.customerId, tenantId: req.portal.tenantId } });
  if (!patient) throw new NotFoundError();
  const item = await prisma.clinicalPrescription.findFirst({ where: { id: req.params.id, tenantId: req.portal.tenantId }, include: { doctor: true } });
  if (!item) throw new NotFoundError();
  if (item.patientId !== patient.id) throw new ForbiddenError('You do not have access to this record');
  res.json({ item });
});

const optOutSchema = z.object({ whatsappOptOut: z.boolean().optional(), promotionalOptOut: z.boolean().optional() });

router.put('/communication-preferences', async (req, res) => {
  const parsed = optOutSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid preference data', parsed.error.flatten());
  const pref = await prisma.customerCommunicationPreference.upsert({
    where: { customerId: req.portal.customerId },
    create: { customerId: req.portal.customerId, ...parsed.data },
    update: parsed.data,
  });
  await logAudit({ req, action: 'PORTAL_COMMUNICATION_PREFERENCE_UPDATE', entity: 'Customer', entityId: req.portal.customerId, metadata: { customerId: req.portal.customerId, portalEvent: true } });
  res.json({ item: pref });
});

module.exports = router;
