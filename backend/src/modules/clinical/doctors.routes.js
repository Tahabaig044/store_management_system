// Doctor/provider profiles. Optionally linked to a User login (userId) -
// a visiting or reference-only doctor may have a profile without ever
// signing in.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { CLINICAL_STAFF, MANAGEMENT } = require('../../constants/roles');
const { requireModule } = require('../../middleware/moduleAccess');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { branchScopeWhere, assertBranchAccess } = require('../../middleware/branchScope');

const createSchema = z.object({
  name: z.string().min(1),
  userId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  specialty: z.string().optional(),
  designation: z.string().optional(),
  availability: z.record(z.string(), z.array(z.string())).optional(),
  appointmentCapacityPerDay: z.number().int().positive().optional(),
});

const router = express.Router();
router.use(authenticate, requireTenant, requireModule('OPTICAL'), requireRole(...CLINICAL_STAFF));

router.get('/', async (req, res) => {
  const items = await prisma.doctor.findMany({
    where: { tenantId: req.user.tenantId, ...(req.query.includeInactive === 'true' ? {} : { isActive: true }), ...(await branchScopeWhere(prisma, req.user)) },
    include: { user: { select: { name: true, email: true } }, branch: true },
    orderBy: { name: 'asc' },
  });
  res.json({ items });
});

router.get('/:id', async (req, res) => {
  const item = await prisma.doctor.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { user: { select: { name: true, email: true } }, branch: true },
  });
  if (!item) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, item.branchId);
  res.json({ item });
});

router.post('/', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid doctor data', parsed.error.flatten());

  if (parsed.data.userId) {
    const user = await prisma.user.findFirst({ where: { id: parsed.data.userId, tenantId: req.user.tenantId } });
    if (!user) throw new NotFoundError('User not found');
    const existing = await prisma.doctor.findUnique({ where: { userId: parsed.data.userId } });
    if (existing) throw new ConflictError('This user already has a doctor profile');
  }
  if (parsed.data.branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: parsed.data.branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }

  const item = await prisma.doctor.create({ data: { ...parsed.data, tenantId: req.user.tenantId } });
  res.status(201).json({ item });
});

const updateSchema = createSchema.omit({ userId: true }).partial().extend({ isActive: z.boolean().optional() });

router.patch('/:id', requireRole(...MANAGEMENT), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid doctor data', parsed.error.flatten());

  const existing = await prisma.doctor.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();
  if (parsed.data.branchId) {
    const branch = await prisma.branch.findFirst({ where: { id: parsed.data.branchId, tenantId: req.user.tenantId } });
    if (!branch) throw new NotFoundError('Branch not found');
  }

  const item = await prisma.doctor.update({ where: { id: existing.id }, data: parsed.data });
  res.json({ item });
});

// Doctor-wise appointments, patient count, and clinical/optical activity -
// one summary endpoint rather than several thin ones.
router.get('/:id/activity', async (req, res) => {
  const doctor = await prisma.doctor.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!doctor) throw new NotFoundError();
  await assertBranchAccess(prisma, req.user, doctor.branchId);

  const { from, to } = req.query;
  const dateFilter = {};
  if (from) dateFilter.gte = new Date(from);
  if (to) dateFilter.lte = new Date(to);

  const [appointments, examinations, prescriptions, distinctPatients] = await Promise.all([
    prisma.appointment.findMany({ where: { tenantId: req.user.tenantId, doctorId: doctor.id, ...(from || to ? { scheduledAt: dateFilter } : {}) }, include: { patient: { include: { customer: true } } }, orderBy: { scheduledAt: 'desc' } }),
    prisma.examination.count({ where: { tenantId: req.user.tenantId, doctorId: doctor.id, ...(from || to ? { examDate: dateFilter } : {}) } }),
    prisma.clinicalPrescription.count({ where: { tenantId: req.user.tenantId, doctorId: doctor.id, ...(from || to ? { issueDate: dateFilter } : {}) } }),
    prisma.appointment.findMany({ where: { tenantId: req.user.tenantId, doctorId: doctor.id }, select: { patientId: true }, distinct: ['patientId'] }),
  ]);

  const byStatus = {};
  for (const a of appointments) byStatus[a.status] = (byStatus[a.status] || 0) + 1;

  res.json({
    doctor,
    appointmentCount: appointments.length,
    byStatus,
    examinationCount: examinations,
    prescriptionCount: prescriptions,
    distinctPatientCount: distinctPatients.length,
    appointments: appointments.slice(0, 50),
  });
});

module.exports = router;
