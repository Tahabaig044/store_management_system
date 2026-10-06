// In-house and third-party lab management: profiles, work queues, and
// performance metrics. Every job is an existing OpticalOrder with labId
// set - no parallel "job" table, per the instruction to integrate with
// existing records rather than duplicate them.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { FRONT_DESK, MANAGEMENT } = require('../../constants/roles');
const { requireModule } = require('../../middleware/moduleAccess');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const createSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['IN_HOUSE', 'THIRD_PARTY']).default('IN_HOUSE'),
  contactPhone: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal('')),
});

const router = express.Router();
router.use(authenticate, requireTenant, requireModule('OPTICAL'), requireRole(...FRONT_DESK));

router.get('/', async (req, res) => {
  const items = await prisma.lab.findMany({
    where: { tenantId: req.user.tenantId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
  res.json({ items });
});

router.post('/', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid lab data', parsed.error.flatten());
  const item = await prisma.lab.create({ data: { ...parsed.data, contactEmail: parsed.data.contactEmail || null, tenantId: req.user.tenantId } });
  res.status(201).json({ item });
});

const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

router.patch('/:id', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid lab data', parsed.error.flatten());
  const existing = await prisma.lab.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  const item = await prisma.lab.update({ where: { id: existing.id }, data: parsed.data });
  res.json({ item });
});

// This lab's work queue, split by job status, plus turnaround/rejection
// metrics computed from the same OpticalOrder records every other report
// already uses.
router.get('/:id/queue', async (req, res) => {
  const lab = await prisma.lab.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!lab) throw new NotFoundError();

  const jobs = await prisma.opticalOrder.findMany({
    where: { tenantId: req.user.tenantId, labId: lab.id, status: { not: 'CANCELLED' } },
    include: { customer: true, patient: { include: { customer: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const now = new Date();
  const byStatus = {};
  let delayed = 0;
  let rejected = 0;
  let turnaroundDaysSum = 0;
  let completedCount = 0;

  for (const j of jobs) {
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    if (j.expectedDeliveryDate && new Date(j.expectedDeliveryDate) < now && !['READY', 'DELIVERED'].includes(j.status)) delayed += 1;
    if (j.qcPassed === false) rejected += 1;
    if (j.deliveredAt) {
      turnaroundDaysSum += (new Date(j.deliveredAt) - new Date(j.createdAt)) / 86400000;
      completedCount += 1;
    }
  }

  res.json({
    lab,
    jobs,
    byStatus,
    delayedCount: delayed,
    rejectedCount: rejected,
    averageTurnaroundDays: completedCount > 0 ? turnaroundDaysSum / completedCount : null,
  });
});

module.exports = router;
