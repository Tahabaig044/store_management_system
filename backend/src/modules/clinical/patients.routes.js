// Patient management. A Patient is a Customer with a clinical profile
// attached - the identity (name/phone/email) always lives on Customer and
// is never duplicated. Restricted to CLINICAL_STAFF: ordinary POS staff
// keep using the existing /api/customers endpoints unchanged for regular
// retail customers, and never see clinical fields at all.
const express = require('express');
const { z } = require('zod');
const prisma = require('../../config/prisma');
const { parsePagination } = require('../../utils/pagination');
const { authenticate, requireTenant, requireRole } = require('../../middleware/auth');
const { CLINICAL_STAFF } = require('../../constants/roles');
const { requirePermission } = require('../../middleware/permissions');
const { requireModule } = require('../../middleware/moduleAccess');
const { nextSequenceNumber } = require('../../utils/sequenceNumber');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { logAudit } = require('../../middleware/audit');

const clinicalFields = z.object({
  dateOfBirth: z.coerce.date().optional(),
  gender: z.string().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  bloodGroup: z.string().optional(),
  allergies: z.string().optional(),
  medicalHistory: z.string().optional(),
});

const createSchema = z.union([
  // Link an existing Customer as a Patient.
  z.object({ customerId: z.string().uuid() }).merge(clinicalFields),
  // Create a brand-new Customer + Patient together.
  z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    address: z.string().optional(),
  }).merge(clinicalFields),
]);

const router = express.Router();
router.use(authenticate, requireTenant, requireModule('OPTICAL'));

router.get('/', requirePermission('PATIENT', 'VIEW'), async (req, res) => {
  const { search, includeInactive } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = { tenantId: req.user.tenantId };
  if (includeInactive !== 'true') where.isActive = true;
  if (search) {
    where.OR = [
      { patientNumber: { contains: search, mode: 'insensitive' } },
      { customer: { name: { contains: search, mode: 'insensitive' } } },
      { customer: { phone: { contains: search, mode: 'insensitive' } } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.patient.findMany({ where, include: { customer: true }, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.patient.count({ where }),
  ]);
  res.json({ items, total, page: Number(page), pageSize: take });
});

router.get('/:id', requirePermission('PATIENT', 'VIEW'), async (req, res) => {
  const item = await prisma.patient.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { customer: true } });
  if (!item) throw new NotFoundError();
  res.json({ item });
});

router.post('/', requirePermission('PATIENT', 'CREATE'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid patient data', parsed.error.flatten());
  const data = parsed.data;

  const item = await prisma.$transaction(async (tx) => {
    let customerId;
    if ('customerId' in data) {
      const customer = await tx.customer.findFirst({ where: { id: data.customerId, tenantId: req.user.tenantId } });
      if (!customer) throw new NotFoundError('Customer not found');
      const existingPatient = await tx.patient.findUnique({ where: { customerId: customer.id } });
      if (existingPatient) throw new ConflictError('This customer already has a patient profile');
      customerId = customer.id;
    } else {
      // Duplicate-patient detection: warn (rather than silently create a
      // second identity) when a customer with the same name+phone already
      // exists. The caller can still proceed by linking that existing
      // customer via the customerId branch above instead.
      if (data.phone) {
        const possibleDuplicate = await tx.customer.findFirst({
          where: { tenantId: req.user.tenantId, phone: data.phone, name: { equals: data.name, mode: 'insensitive' } },
        });
        if (possibleDuplicate) {
          throw new ConflictError(
            `A customer named "${possibleDuplicate.name}" with this phone number already exists (id: ${possibleDuplicate.id}). Link that record instead of creating a duplicate.`
          );
        }
      }
      const customer = await tx.customer.create({
        data: { tenantId: req.user.tenantId, name: data.name, phone: data.phone, email: data.email || null, address: data.address },
      });
      customerId = customer.id;
    }

    const patientNumber = await nextSequenceNumber(tx.patient, req.user.tenantId, 'PT', { tx });
    return tx.patient.create({
      data: {
        tenantId: req.user.tenantId,
        customerId,
        patientNumber,
        dateOfBirth: data.dateOfBirth,
        gender: data.gender,
        emergencyContactName: data.emergencyContactName,
        emergencyContactPhone: data.emergencyContactPhone,
        bloodGroup: data.bloodGroup,
        allergies: data.allergies,
        medicalHistory: data.medicalHistory,
      },
      include: { customer: true },
    });
  });

  await logAudit({ req, action: 'PATIENT_CREATE', entity: 'Patient', entityId: item.id });
  res.status(201).json({ item });
});

const updateSchema = clinicalFields.extend({ isActive: z.boolean().optional() });

router.patch('/:id', requirePermission('PATIENT', 'UPDATE'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('Invalid patient data', parsed.error.flatten());

  const existing = await prisma.patient.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
  if (!existing) throw new NotFoundError();

  const item = await prisma.patient.update({ where: { id: existing.id }, data: parsed.data, include: { customer: true } });
  await logAudit({ req, action: 'PATIENT_UPDATE', entity: 'Patient', entityId: item.id, metadata: parsed.data });
  res.json({ item });
});

// Customer/Patient 360 - the unified clinical + commercial history view.
router.get('/:id/360', requirePermission('PATIENT', 'VIEW'), async (req, res) => {
  const patient = await prisma.patient.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { customer: true } });
  if (!patient) throw new NotFoundError();

  const [appointments, examinations, prescriptions, opticalOrders, sales, payments] = await Promise.all([
    prisma.appointment.findMany({ where: { tenantId: req.user.tenantId, patientId: patient.id }, include: { doctor: true }, orderBy: { scheduledAt: 'desc' } }),
    prisma.examination.findMany({ where: { tenantId: req.user.tenantId, patientId: patient.id }, include: { doctor: true }, orderBy: { examDate: 'desc' } }),
    prisma.clinicalPrescription.findMany({ where: { tenantId: req.user.tenantId, patientId: patient.id }, include: { doctor: true }, orderBy: { issueDate: 'desc' } }),
    prisma.opticalOrder.findMany({ where: { tenantId: req.user.tenantId, patientId: patient.id }, orderBy: { createdAt: 'desc' } }),
    prisma.sale.findMany({ where: { tenantId: req.user.tenantId, customerId: patient.customerId }, orderBy: { createdAt: 'desc' } }),
    prisma.payment.findMany({ where: { tenantId: req.user.tenantId, customerId: patient.customerId }, orderBy: { paidAt: 'desc' } }),
  ]);

  const activeSales = sales.filter((s) => s.status !== 'REVERSED');
  const salesBalance = activeSales.reduce((sum, s) => sum + Number(s.total) - Number(s.amountPaid), 0);
  const opticalBalance = opticalOrders.reduce((sum, o) => sum + Number(o.totalAmount) - Number(o.amountPaid), 0);

  await logAudit({ req, action: 'PATIENT_360_VIEW', entity: 'Patient', entityId: patient.id });
  res.json({
    patient,
    appointments,
    examinations,
    prescriptions,
    opticalOrders,
    sales,
    payments,
    outstandingBalance: salesBalance + opticalBalance,
  });
});

// Merge a duplicate patient into this one - every clinical/commercial
// record moves over, and the duplicate is deactivated (never deleted), so
// history is preserved rather than destroyed.
router.post('/:id/merge', requireRole(...CLINICAL_STAFF), async (req, res) => {
  const schema = z.object({ duplicatePatientId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError('A duplicatePatientId is required', parsed.error.flatten());

  const [primary, duplicate] = await Promise.all([
    prisma.patient.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } }),
    prisma.patient.findFirst({ where: { id: parsed.data.duplicatePatientId, tenantId: req.user.tenantId } }),
  ]);
  if (!primary) throw new NotFoundError('Primary patient not found');
  if (!duplicate) throw new NotFoundError('Duplicate patient not found');
  if (primary.id === duplicate.id) throw new ValidationError('Cannot merge a patient into itself');

  const merged = await prisma.$transaction(async (tx) => {
    await tx.appointment.updateMany({ where: { patientId: duplicate.id }, data: { patientId: primary.id } });
    await tx.examination.updateMany({ where: { patientId: duplicate.id }, data: { patientId: primary.id } });
    await tx.clinicalPrescription.updateMany({ where: { patientId: duplicate.id }, data: { patientId: primary.id } });
    await tx.opticalOrder.updateMany({ where: { patientId: duplicate.id }, data: { patientId: primary.id } });
    return tx.patient.update({ where: { id: duplicate.id }, data: { isActive: false } });
  });

  await logAudit({ req, action: 'PATIENT_MERGE', entity: 'Patient', entityId: primary.id, metadata: { mergedFrom: duplicate.id } });
  res.json({ item: merged, mergedInto: primary.id });
});

module.exports = router;
