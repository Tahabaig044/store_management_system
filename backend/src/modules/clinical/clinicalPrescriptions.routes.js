// The versioned, patient-linked "master" prescription. Distinct from the
// existing OpticalOrder-embedded Prescription (an unchanged, order-time
// snapshot) - this is the clinical record of what was prescribed and when,
// and it is never overwritten: a correction creates a new row referencing
// the one it supersedes, which is marked inactive but never deleted.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireModule } = require('../../middleware/moduleAccess');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');

const eyeSchema = z.object({
  sphere: z.number().optional(),
  cylinder: z.number().optional(),
  axis: z.number().int().min(0).max(180).optional(),
  add: z.number().optional(),
});

const createSchema = z.object({
  patientId: z.string().uuid(),
  examinationId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  issueDate: z.coerce.date().optional(),
  od: eyeSchema.optional(),
  os: eyeSchema.optional(),
  pd: z.number().optional(),
  lensRecommendation: z.string().optional(),
  notes: z.string().optional(),
  // If this prescription corrects an earlier one, link it here rather than
  // editing the old row - the old one is marked inactive, never rewritten.
  supersedesId: z.string().uuid().optional(),
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

router.get('/', requirePermission('PRESCRIPTION', 'VIEW'), async (req, res) => {
  const { patientId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (patientId) where.patientId = patientId;

  const [items, total] = await Promise.all([
    prisma.clinicalPrescription.findMany({
      where,
      include: { patient: { include: { customer: true } }, doctor: true, examination: true },
      orderBy: { issueDate: 'desc' },
      skip,
      take,
    }),
    prisma.clinicalPrescription.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PRESCRIPTION', 'VIEW'), async (req, res) => {
  const item = await prisma.clinicalPrescription.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { patient: { include: { customer: true } }, doctor: true, examination: true, supersedes: true, supersededBy: true },
  });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('PRESCRIPTION', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid prescription data', parsed.error.flatten());
  const data = flattenEyeFields(parsed.data);

  const patient = await prisma.patient.findFirst({ where: { id: data.patientId, tenantId: req.user.tenantId } });
  if (!patient) throw new NotFoundError('Patient not found');
  if (data.doctorId) {
    const doctor = await prisma.doctor.findFirst({ where: { id: data.doctorId, tenantId: req.user.tenantId } });
    if (!doctor) throw new NotFoundError('Doctor not found');
  }
  if (data.examinationId) {
    const exam = await prisma.examination.findFirst({ where: { id: data.examinationId, tenantId: req.user.tenantId, patientId: data.patientId } });
    if (!exam) throw new NotFoundError('Examination not found for this patient');
  }

  let version = 1;
  if (data.supersedesId) {
    const previous = await prisma.clinicalPrescription.findFirst({ where: { id: data.supersedesId, tenantId: req.user.tenantId, patientId: data.patientId } });
    if (!previous) throw new NotFoundError('Prescription to supersede not found for this patient');
    if (!previous.isActive) throw new ConflictError('This prescription has already been superseded');
    version = previous.version + 1;
  }

  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.clinicalPrescription.create({
      data: { ...data, tenantId: req.user.tenantId, version, createdById: req.user.id },
      include: { patient: { include: { customer: true } }, doctor: true },
    });
    if (data.supersedesId) {
      await tx.clinicalPrescription.update({ where: { id: data.supersedesId }, data: { isActive: false } });
    }
    return created;
  });

  await logAudit({ req, action: 'PRESCRIPTION_CREATE', entity: 'ClinicalPrescription', entityId: item.id, metadata: { patientId: item.patientId, version } });
  res.status(201).json({ item });
});

// Print/share-ready format - a plain structured payload; rendering to
// PDF/HTML happens on the frontend using the existing print/barcode
// pattern (see the frontend Prescriptions page), not a server-side
// document engine.
router.get('/:id/print', requirePermission('PRESCRIPTION', 'VIEW'), async (req, res) => {
  const item = await prisma.clinicalPrescription.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    include: { patient: { include: { customer: true } }, doctor: true },
  });
  if (!item) throw new NotFoundError();
  await logAudit({ req, action: 'PRESCRIPTION_PRINT', entity: 'ClinicalPrescription', entityId: item.id });
  res.json({ item });
});

module.exports = router;
