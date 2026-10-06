// Eye examination / refraction records. A structured core model (OD/OS
// sphere/cylinder/axis/add, visual acuity, PD) plus free-text clinical
// notes/diagnosis/treatment - never overwritten into a different clinical
// outcome; a correction is a new ClinicalPrescription version, not an edit
// to a past examination's refraction numbers.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireModule } = require('../../middleware/moduleAccess');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');

const eyeSchema = z.object({
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().min(0).max(180).optional(),
  add: z.number().optional(),
});

const createSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid().optional(),
  appointmentId: z.string().uuid().optional(),
  examDate: z.coerce.date().optional(),
  vaOdDistance: z.string().optional(),
  vaOsDistance: z.string().optional(),
  vaOdNear: z.string().optional(),
  vaOsNear: z.string().optional(),
  od: eyeSchema.optional(),
  os: eyeSchema.optional(),
  pd: z.number().optional(),
  clinicalNotes: z.string().optional(),
  diagnosis: z.string().optional(),
  treatmentAdvice: z.string().optional(),
  followUpDate: z.coerce.date().optional(),
});

function flattenEyeFields(data) {
  const { od, os, ...rest } = data;
  return {
    ...rest,
    odSphere: od?.sphere,
    odCylinder: od?.cylinder,
    odAxis: od?.axis,
    odAdd: od?.add,
    osSphere: os?.sphere,
    osCylinder: os?.cylinder,
    osAxis: os?.axis,
    osAdd: os?.add,
  };
}

const router = express.Router();
router.use(authenticate, requireTenant, requireModule('OPTICAL'));

router.get('/', requirePermission('EXAMINATION', 'VIEW'), async (req, res) => {
  const { patientId, doctorId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (patientId) where.patientId = patientId;
  if (doctorId) where.doctorId = doctorId;

  const [items, total] = await Promise.all([
    prisma.examination.findMany({
      where,
      include: { patient: { include: { customer: true } }, doctor: true },
      orderBy: { examDate: 'desc' },
      skip,
      take,
    }),
    prisma.examination.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('EXAMINATION', 'VIEW'), async (req, res) => {
  const item = await prisma.examination.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { patient: { include: { customer: true } }, doctor: true, appointment: true, prescriptions: true },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('EXAMINATION', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid examination data', parsed.error.flatten());
  const data = flattenEyeFields(parsed.data);

  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId: req.user.tenantId } });
  if (!patient) throw new NotFoundError('Patient not found');
  if (data.doctorId) {
    const doctor = await prisma.doctor.findFirst({ where: { id: data.doctorId, tenantId: req.user.tenantId } });
    if (!doctor) throw new NotFoundError('Doctor not found');
  }
  if (data.appointmentId) {
    const appointment = await prisma.appointment.findFirst({ where: { id: data.appointmentId, tenantId: req.user.tenantId, patientId: data.patientId } });
    if (!appointment) throw new NotFoundError('Appointment not found for this patient');
  }

  const item = await prisma.examination.create({
    data: { ...data, tenantId: req.user.tenantId, createdById: req.user.id },
    include: { patient: { include: { customer: true } }, doctor: true },
  });

  // An examination naturally completes the visit it was taken during.
  if (data.appointmentId) {
    await prisma.appointment.update({ where: { id: data.appointmentId }, data: { status: 'COMPLETED' } }).catch(() => {});
  }

  await logAudit({ req, action: 'EXAMINATION_CREATE', entity: 'Examination', entityId: item.id, metadata: { patientId: item.patientId } });
  res.status(201).json({ item });
});

// Historical examination comparison for a patient - side-by-side by date.
router.get('/patient/:patientId/history', requirePermission('EXAMINATION', 'VIEW'), async (req, res) => {
  const patient = await prisma.patient.findFirst({ where: { id: req.params.patientId, tenantId: req.user.tenantId } });
  if (!patient) throw new NotFoundError();

  const items = await prisma.examination.findMany({
    where: { tenantId: req.user.tenantId, patientId: patient.id },
    include: { doctor: true },
    orderBy: { examDate: 'desc' },
  });
  res.json({ items });
});

module.exports = router;
