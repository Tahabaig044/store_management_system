// Appointment booking, queue/token management, and status lifecycle:
// SCHEDULED -> CONFIRMED -> ARRIVED -> IN_PROGRESS -> COMPLETED, with
// CANCELLED/NO_SHOW as terminal alternates.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireModule } = require('../../middleware/moduleAccess');
const { findExistingByIdempotencyKey } = require('../../utils/idempotency');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');
const { branchScopeWhere, assertBranchAccess } = require('../../middleware/branchScope');
const { triggerEvent } = require('../communication/automation');

const ACTIVE_STATUSES = ['SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS'];

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

const createSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  appointmentType: z.string().optional(),
  scheduledAt: z.coerce.date(),
  durationMinutes: z.number().int().positive().default(30),
  notes: z.string().optional(),
  followUpOfId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
});

async function assertNoConflict(tx, { tenantId, doctorId, scheduledAt, durationMinutes, excludeId }) {
  if (!doctorId) return; // no doctor assigned yet - nothing to conflict with
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);

  const candidates = await tx.appointment.findMany({
    where: {
      tenantId,
      doctorId,
      status: { in: ACTIVE_STATUSES },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      // Narrow to the same day first (cheap), then check real overlap in JS
      // since Prisma can't express "rangeA overlaps rangeB" directly.
      scheduledAt: { gte: startOfDay(start), lte: endOfDay(start) },
    },
    select: { id: true, scheduledAt: true, durationMinutes: true },
  });

  for (const c of candidates) {
    const cStart = new Date(c.scheduledAt);
    const cEnd = new Date(cStart.getTime() + c.durationMinutes * 60000);
    if (start < cEnd && cStart < end) {
      throw new ConflictError('This doctor already has an appointment that overlaps this time slot');
    }
  }
}

const router = express.Router();
router.use(authenticate, requireTenant, requireModule('OPTICAL'));

router.get('/', requirePermission('APPOINTMENT', 'VIEW'), async (req, res) => {
  const { patientId, doctorId, status, from, to } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) };
  if (patientId) where.patientId = patientId;
  if (doctorId) where.doctorId = doctorId;
  if (status) where.status = status;
  if (from || to) {
    where.scheduledAt = {};
    if (from) where.scheduledAt.gte = new Date(from);
    if (to) where.scheduledAt.lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: { patient: { include: { customer: true } }, doctor: true, branch: true },
      orderBy: { scheduledAt: 'asc' },
      skip,
      take,
    }),
    prisma.appointment.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

// Today's queue dashboard - active appointments for today, ordered by
// token, with a simple waiting-time estimate.
router.get('/today', requirePermission('APPOINTMENT', 'VIEW'), async (req, res) => {
  const where = {
    tenantId: req.user.tenantId,
    ...(await branchScopeWhere(prisma, req.user)),
    scheduledAt: { gte: startOfDay(), lte: endOfDay() },
    status: { in: [...ACTIVE_STATUSES, 'COMPLETED', 'NO_SHOW'] },
  };
  const items = await prisma.appointment.findMany({
    where,
    include: { patient: { include: { customer: true } }, doctor: true },
    orderBy: [{ tokenNumber: 'asc' }, { scheduledAt: 'asc' }],
  });

  const waiting = items.filter((a) => ['SCHEDULED', 'CONFIRMED', 'ARRIVED'].includes(a.status));
  res.json({
    date: startOfDay(),
    items,
    waitingCount: waiting.length,
    inProgressCount: items.filter((a) => a.status === 'IN_PROGRESS').length,
    completedCount: items.filter((a) => a.status === 'COMPLETED').length,
  });
});

router.get('/:id', requirePermission('APPOINTMENT', 'VIEW'), async (req, res) => {
  const item = await prisma.appointment.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) },
    include: { patient: { include: { customer: true } }, doctor: true, branch: true, examination: true },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('APPOINTMENT', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid appointment data', parsed.error.flatten());
  const { patientId, doctorId, appointmentType, scheduledAt, durationMinutes, notes, followUpOfId, idempotencyKey } = parsed.data;
  const branchId = parsed.data.branchId ?? req.user.branchId ?? null;

  if (idempotencyKey) {
    const existing = await findExistingByIdempotencyKey(prisma.appointment, req.user.tenantId, idempotencyKey, {
      patient: { include: { customer: true } },
      doctor: true,
    });
    if (existing) return res.status(200).json({ item: existing, deduplicated: true });
  }

  const patient = await prisma.patient.findFirst({ where: { id: patientId, tenantId: req.user.tenantId } });
  if (!patient) throw new NotFoundError('Patient not found');
  if (doctorId) {
    const doctor = await prisma.doctor.findFirst({ where: { id: doctorId, tenantId: req.user.tenantId } });
    if (!doctor) throw new NotFoundError('Doctor not found');
  }
  if (branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }
  await assertBranchAccess(prisma, req.user, branchId);
  if (followUpOfId) {
    const original = await prisma.appointment.findFirst({ where: { id: followUpOfId, tenantId: req.user.tenantId } });
    if (!original) throw new NotFoundError('Original appointment not found');
  }

  const item = await prisma.$transaction(async (tx) => {
    await assertNoConflict(tx, { tenantId: req.user.tenantId, doctorId, scheduledAt, durationMinutes });

    const tokenCount = await tx.appointment.count({
      where: { tenantId: req.user.tenantId, branchId, scheduledAt: { gte: startOfDay(scheduledAt), lte: endOfDay(scheduledAt) } },
    });

    return tx.appointment.create({
      data: {
        tenantId: req.user.tenantId,
        branchId,
        patientId,
        doctorId,
        appointmentType,
        scheduledAt,
        durationMinutes,
        notes,
        followUpOfId,
        tokenNumber: tokenCount + 1,
        idempotencyKey,
        createdById: req.user.id,
      },
      include: { patient: { include: { customer: true } }, doctor: true },
    });
  });

  await logAudit({ req, action: 'APPOINTMENT_CREATE', entity: 'Appointment', entityId: item.id });

  const bookedCustomer = item.patient?.customer;
  if (bookedCustomer?.phone) {
    await triggerEvent(prisma, {
      tenantId: req.user.tenantId,
      event: 'APPOINTMENT_BOOKED',
      sourceId: item.id,
      branchId: item.branchId,
      customer: bookedCustomer,
      variables: { customerName: bookedCustomer.name, scheduledAt: item.scheduledAt.toISOString() },
    });
  }

  res.status(201).json({ item });
});

const STATUS_VALUES = ['SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

router.patch('/:id/status', requirePermission('APPOINTMENT', 'UPDATE'), async (req, res) => {
  const schema = z.object({ status: z.enum(STATUS_VALUES) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid status', parsed.error.flatten());

  const existing = await prisma.appointment.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) },
  });
  if (!existing) throw new NotFoundError();
  if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(existing.status)) {
    throw new ConflictError('This appointment has already reached a final status');
  }

  const item = await prisma.appointment.update({
    where: { id: existing.id },
    data: { status: parsed.data.status },
    include: { patient: { include: { customer: true } } },
  });
  await logAudit({ req, action: 'APPOINTMENT_STATUS_CHANGE', entity: 'Appointment', entityId: item.id, metadata: { from: existing.status, to: parsed.data.status } });

  if (parsed.data.status === 'NO_SHOW') {
    await triggerEvent(prisma, {
      tenantId: req.user.tenantId,
      event: 'APPOINTMENT_NO_SHOW',
      sourceId: item.id,
      branchId: item.branchId,
      internalTitle: 'Patient no-show',
      internalBody: `${item.patient?.customer?.name || 'A patient'} did not show up for their appointment`,
      variables: { link: `/appointments/${item.id}` },
    });
  }

  res.json({ item });
});

router.patch('/:id/reschedule', requirePermission('APPOINTMENT', 'UPDATE'), async (req, res) => {
  const schema = z.object({ scheduledAt: z.coerce.date(), durationMinutes: z.number().int().positive().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid reschedule data', parsed.error.flatten());

  const existing = await prisma.appointment.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId, ...(await branchScopeWhere(prisma, req.user)) },
  });
  if (!existing) throw new NotFoundError();
  if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(existing.status)) {
    throw new ConflictError('This appointment has already reached a final status');
  }

  const item = await prisma.$transaction(async (tx) => {
    await assertNoConflict(tx, {
      tenantId: req.user.tenantId,
      doctorId: existing.doctorId,
      scheduledAt: parsed.data.scheduledAt,
      durationMinutes: parsed.data.durationMinutes ?? existing.durationMinutes,
      excludeId: existing.id,
    });
    return tx.appointment.update({
      where: { id: existing.id },
      data: { scheduledAt: parsed.data.scheduledAt, durationMinutes: parsed.data.durationMinutes ?? existing.durationMinutes },
    });
  });
  res.json({ item });
});

module.exports = router;
