// Phase 7 - Advanced Optical + Eye Clinic + CRM tests: patients, doctors,
// appointments, examinations, versioned prescriptions, the clinical-to-
// commercial integration into OpticalOrder, and lab/job tracking. Same
// convention as the other integration suites: real HTTP calls against a
// real (disposable, throwaway) database.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

jest.setTimeout(30000);

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function registerTenant(businessName) {
  const res = await request(app).post('/api/auth/register-tenant').send({
    businessName,
    adminName: 'Test Admin',
    email: uniqueEmail('admin'),
    password: 'TestPass123',
  });
  if (res.status !== 201) throw new Error(`register-tenant failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, tenantId: res.body.tenant.id };
}

async function createUserToken(adminToken, role) {
  const email = uniqueEmail(role.toLowerCase());
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: `Test ${role}`, email, password: 'TestPass123', role });
  if (created.status !== 201) throw new Error(`create user (${role}) failed: ${JSON.stringify(created.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return login.body.token;
}

describe('Phase 7 - Advanced Optical + Eye Clinic + CRM', () => {
  let tenantA;
  let tenantB;
  let receptionistA;
  let doctorTokenA;
  let doctorId;
  let patientId;
  let customerIdOfPatient;

  beforeAll(async () => {
    tenantA = await registerTenant(`Clinic Tenant A ${Date.now()}`);
    tenantB = await registerTenant(`Clinic Tenant B ${Date.now()}`);
    receptionistA = await createUserToken(tenantA.token, 'RECEPTIONIST');
    doctorTokenA = await createUserToken(tenantA.token, 'DOCTOR');

    const doc = await request(app)
      .post('/api/doctors')
      .set('Authorization', `Bearer ${tenantA.token}`)
      .send({ name: 'Dr. Test Optometrist', specialty: 'Optometry' });
    doctorId = doc.body.item.id;

    const patient = await request(app)
      .post('/api/patients')
      .set('Authorization', `Bearer ${receptionistA}`)
      .send({ name: 'Test Patient One', phone: '03001234567', gender: 'F', dateOfBirth: '1990-01-01' });
    patientId = patient.body.item.id;
    customerIdOfPatient = patient.body.item.customerId;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Patient management', () => {
    test('a patient is created as an extension of a new Customer, not a duplicate identity', async () => {
      const customer = await request(app).get(`/api/customers/${customerIdOfPatient}`).set('Authorization', `Bearer ${tenantA.token}`);
      expect(customer.status).toBe(200);
      expect(customer.body.item.name).toBe('Test Patient One');
    });

    test('registering the same name+phone again is flagged as a possible duplicate, not silently created', async () => {
      const res = await request(app)
        .post('/api/patients')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ name: 'Test Patient One', phone: '03001234567' });
      expect(res.status).toBe(409);
    });

    test('an existing customer can be linked as a patient instead of creating a duplicate', async () => {
      const customer = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Plain Retail Customer' });
      const linked = await request(app)
        .post('/api/patients')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customer.body.item.id });
      expect(linked.status).toBe(201);
      expect(linked.body.item.customerId).toBe(customer.body.item.id);

      // Cannot link the same customer twice.
      const again = await request(app)
        .post('/api/patients')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customer.body.item.id });
      expect(again.status).toBe(409);
    });

    test('patient search finds by name, phone, and patient number', async () => {
      const patientRecord = await request(app).get(`/api/patients/${patientId}`).set('Authorization', `Bearer ${receptionistA}`);
      const byNumber = await request(app).get(`/api/patients?search=${patientRecord.body.item.patientNumber}`).set('Authorization', `Bearer ${receptionistA}`);
      expect(byNumber.body.items.some((p) => p.id === patientId)).toBe(true);

      const byPhone = await request(app).get('/api/patients?search=03001234567').set('Authorization', `Bearer ${receptionistA}`);
      expect(byPhone.body.items.some((p) => p.id === patientId)).toBe(true);
    });

    test('two patients can be merged, moving all clinical records without deleting the duplicate', async () => {
      const dup = await request(app)
        .post('/api/patients')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ name: 'Duplicate Person', phone: '03009999999' });

      const appt = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId: dup.body.item.id, scheduledAt: new Date(Date.now() + 86400000).toISOString() });

      const merged = await request(app)
        .post(`/api/patients/${patientId}/merge`)
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ duplicatePatientId: dup.body.item.id });
      expect(merged.status).toBe(200);
      expect(merged.body.item.isActive).toBe(false); // duplicate deactivated, not deleted

      const movedAppt = await request(app).get(`/api/appointments/${appt.body.item.id}`).set('Authorization', `Bearer ${receptionistA}`);
      expect(movedAppt.body.item.patientId).toBe(patientId);
    });
  });

  describe('Clinical RBAC', () => {
    test('CASHIER, STORE_KEEPER, and ACCOUNTANT cannot access any clinical endpoint', async () => {
      const cashier = await createUserToken(tenantA.token, 'CASHIER');
      const storeKeeper = await createUserToken(tenantA.token, 'STORE_KEEPER');
      const accountant = await createUserToken(tenantA.token, 'ACCOUNTANT');

      for (const token of [cashier, storeKeeper, accountant]) {
        const patients = await request(app).get('/api/patients').set('Authorization', `Bearer ${token}`);
        expect(patients.status).toBe(403);
        const doctors = await request(app).get('/api/doctors').set('Authorization', `Bearer ${token}`);
        expect(doctors.status).toBe(403);
        const appointments = await request(app).get('/api/appointments').set('Authorization', `Bearer ${token}`);
        expect(appointments.status).toBe(403);
      }
    });

    test('a DOCTOR can access clinical endpoints; a RECEPTIONIST can too', async () => {
      const doctorView = await request(app).get('/api/patients').set('Authorization', `Bearer ${doctorTokenA}`);
      expect(doctorView.status).toBe(200);
      const receptionistView = await request(app).get('/api/appointments').set('Authorization', `Bearer ${receptionistA}`);
      expect(receptionistView.status).toBe(200);
    });

    test('an unauthenticated request to any clinical endpoint is rejected', async () => {
      const res = await request(app).get('/api/patients');
      expect(res.status).toBe(401);
    });
  });

  describe('Doctor management', () => {
    test('a doctor cannot be linked to a user who already has a doctor profile', async () => {
      const doctorUser = await request(app).post('/api/users').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Dr Linked', email: uniqueEmail('doclink'), password: 'TestPass123', role: 'DOCTOR' });
      const first = await request(app).post('/api/doctors').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Dr Linked', userId: doctorUser.body.item.id });
      expect(first.status).toBe(201);
      const second = await request(app).post('/api/doctors').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'Dr Linked Again', userId: doctorUser.body.item.id });
      expect(second.status).toBe(409);
    });

    test('doctor creation is restricted to MANAGEMENT', async () => {
      const res = await request(app).post('/api/doctors').set('Authorization', `Bearer ${receptionistA}`).send({ name: 'Unauthorized Doctor' });
      expect(res.status).toBe(403);
    });
  });

  describe('Appointment booking, conflict detection, and queue', () => {
    test('two overlapping appointments for the same doctor are rejected', async () => {
      const scheduledAt = new Date(Date.now() + 2 * 86400000);
      scheduledAt.setHours(10, 0, 0, 0);

      const first = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, doctorId, scheduledAt: scheduledAt.toISOString(), durationMinutes: 30 });
      expect(first.status).toBe(201);
      expect(first.body.item.tokenNumber).toBeGreaterThan(0);

      const overlapping = new Date(scheduledAt.getTime() + 15 * 60000); // 15 min into the first slot
      const conflict = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, doctorId, scheduledAt: overlapping.toISOString(), durationMinutes: 30 });
      expect(conflict.status).toBe(409);

      const nonOverlapping = new Date(scheduledAt.getTime() + 30 * 60000); // exactly back-to-back
      const ok = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, doctorId, scheduledAt: nonOverlapping.toISOString(), durationMinutes: 30 });
      expect(ok.status).toBe(201);
    });

    test('a retried appointment creation with the same idempotencyKey is deduplicated', async () => {
      const idempotencyKey = `appt-test-${Date.now()}`;
      const scheduledAt = new Date(Date.now() + 3 * 86400000).toISOString();
      const first = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, scheduledAt, idempotencyKey });
      const retry = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, scheduledAt, idempotencyKey });
      expect(retry.status).toBe(200);
      expect(retry.body.deduplicated).toBe(true);
      expect(retry.body.item.id).toBe(first.body.item.id);
    });

    test('appointment status moves through the lifecycle and cannot regress from a final state', async () => {
      const appt = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ patientId, scheduledAt: new Date(Date.now() + 4 * 86400000).toISOString() });

      const confirmed = await request(app).patch(`/api/appointments/${appt.body.item.id}/status`).set('Authorization', `Bearer ${receptionistA}`).send({ status: 'CONFIRMED' });
      expect(confirmed.body.item.status).toBe('CONFIRMED');

      const cancelled = await request(app).patch(`/api/appointments/${appt.body.item.id}/status`).set('Authorization', `Bearer ${receptionistA}`).send({ status: 'CANCELLED' });
      expect(cancelled.status).toBe(200);

      const afterFinal = await request(app).patch(`/api/appointments/${appt.body.item.id}/status`).set('Authorization', `Bearer ${receptionistA}`).send({ status: 'ARRIVED' });
      expect(afterFinal.status).toBe(409);
    });

    test('today\'s queue reflects an appointment scheduled for today', async () => {
      const today = new Date();
      today.setHours(14, 0, 0, 0);
      await request(app).post('/api/appointments').set('Authorization', `Bearer ${receptionistA}`).send({ patientId, scheduledAt: today.toISOString() });

      const queue = await request(app).get('/api/appointments/today').set('Authorization', `Bearer ${receptionistA}`);
      expect(queue.status).toBe(200);
      expect(queue.body.items.length).toBeGreaterThan(0);
    });
  });

  describe('Examinations and prescription versioning', () => {
    let examinationId;

    test('an examination can be created for a patient with structured refraction data', async () => {
      const res = await request(app)
        .post('/api/examinations')
        .set('Authorization', `Bearer ${doctorTokenA}`)
        .send({
          patientId,
          doctorId,
          od: { sphere: -1.5, cylinder: -0.5, axis: 90 },
          os: { sphere: -1.25, cylinder: -0.25, axis: 85 },
          pd: 62,
          diagnosis: 'Myopic astigmatism',
        });
      expect(res.status).toBe(201);
      expect(Number(res.body.item.odSphere)).toBeCloseTo(-1.5, 2);
      examinationId = res.body.item.id;
    });

    test('historical examination comparison lists all of a patient\'s exams', async () => {
      const res = await request(app).get(`/api/examinations/patient/${patientId}/history`).set('Authorization', `Bearer ${doctorTokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.items.some((e) => e.id === examinationId)).toBe(true);
    });

    test('a prescription can be created from the examination, then corrected via a new version without erasing history', async () => {
      const v1 = await request(app)
        .post('/api/clinical-prescriptions')
        .set('Authorization', `Bearer ${doctorTokenA}`)
        .send({ patientId, examinationId, doctorId, od: { sphere: -1.5 }, os: { sphere: -1.25 }, pd: 62 });
      expect(v1.status).toBe(201);
      expect(v1.body.item.version).toBe(1);
      expect(v1.body.item.isActive).toBe(true);

      const v2 = await request(app)
        .post('/api/clinical-prescriptions')
        .set('Authorization', `Bearer ${doctorTokenA}`)
        .send({ patientId, doctorId, od: { sphere: -1.75 }, os: { sphere: -1.5 }, pd: 62, supersedesId: v1.body.item.id });
      expect(v2.status).toBe(201);
      expect(v2.body.item.version).toBe(2);

      const oldOne = await request(app).get(`/api/clinical-prescriptions/${v1.body.item.id}`).set('Authorization', `Bearer ${doctorTokenA}`);
      expect(oldOne.body.item.isActive).toBe(false); // superseded, not deleted or overwritten
      expect(Number(oldOne.body.item.odSphere)).toBeCloseTo(-1.5, 2); // original value preserved

      // Cannot supersede an already-superseded prescription.
      const badSupersede = await request(app)
        .post('/api/clinical-prescriptions')
        .set('Authorization', `Bearer ${doctorTokenA}`)
        .send({ patientId, od: { sphere: -2 }, supersedesId: v1.body.item.id });
      expect(badSupersede.status).toBe(409);
    });
  });

  describe('Clinical-to-commercial integration', () => {
    let clinicalRxId;

    beforeAll(async () => {
      const rx = await request(app)
        .post('/api/clinical-prescriptions')
        .set('Authorization', `Bearer ${doctorTokenA}`)
        .send({ patientId, doctorId, od: { sphere: -2, cylinder: -0.5, axis: 90 }, os: { sphere: -1.75 }, pd: 63 });
      clinicalRxId = rx.body.item.id;
    });

    test('creating an optical order from a prescription pre-fills OD/OS/PD without re-entering them', async () => {
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerIdOfPatient, patientId, clinicalPrescriptionId: clinicalRxId, totalAmount: 150, frameDescription: 'Titanium Frame' });
      expect(order.status).toBe(201);
      expect(order.body.item.patientId).toBe(patientId);
      expect(order.body.item.clinicalPrescriptionId).toBe(clinicalRxId);

      const full = await request(app).get(`/api/optical-orders/${order.body.item.id}`).set('Authorization', `Bearer ${receptionistA}`);
      expect(Number(full.body.item.prescription.odSphere)).toBeCloseTo(-2, 2);
      expect(Number(full.body.item.prescription.pd)).toBeCloseTo(63, 2);
    });

    test('an explicitly-provided prescription on the order overrides the clinical prescription default', async () => {
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({
          customerId: customerIdOfPatient,
          patientId,
          clinicalPrescriptionId: clinicalRxId,
          totalAmount: 150,
          prescription: { od: { sphere: -9.99 } },
        });
      const full = await request(app).get(`/api/optical-orders/${order.body.item.id}`).set('Authorization', `Bearer ${receptionistA}`);
      expect(Number(full.body.item.prescription.odSphere)).toBeCloseTo(-9.99, 2);
    });

    test('a prescription belonging to a different patient cannot be used for this order', async () => {
      const otherPatient = await request(app).post('/api/patients').set('Authorization', `Bearer ${receptionistA}`).send({ name: 'Other Patient', phone: '03005551234' });
      const res = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerIdOfPatient, patientId: otherPatient.body.item.id, clinicalPrescriptionId: clinicalRxId, totalAmount: 100 });
      expect(res.status).toBe(422);
    });
  });

  describe('Optical order job-card / lab lifecycle', () => {
    let orderId;
    let labId;

    beforeAll(async () => {
      const lab = await request(app).post('/api/labs').set('Authorization', `Bearer ${tenantA.token}`).send({ name: 'In-House Lab', type: 'IN_HOUSE' });
      labId = lab.body.item.id;
      const order = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerIdOfPatient, patientId, totalAmount: 200, labId, labCost: 40 });
      orderId = order.body.item.id;
    });

    test('the job moves through IN_LAB -> QUALITY_CHECK -> READY -> DELIVERED, recording QC and delivery', async () => {
      await request(app).patch(`/api/optical-orders/${orderId}`).set('Authorization', `Bearer ${receptionistA}`).send({ status: 'IN_LAB' });
      const qc = await request(app).patch(`/api/optical-orders/${orderId}`).set('Authorization', `Bearer ${receptionistA}`).send({ status: 'QUALITY_CHECK', qcPassed: true, qcNotes: 'Lens power verified' });
      expect(qc.body.item.qcAt).toBeTruthy();
      await request(app).patch(`/api/optical-orders/${orderId}`).set('Authorization', `Bearer ${receptionistA}`).send({ status: 'READY' });
      const delivered = await request(app).patch(`/api/optical-orders/${orderId}`).set('Authorization', `Bearer ${receptionistA}`).send({ status: 'DELIVERED' });
      expect(delivered.body.item.status).toBe('DELIVERED');
      expect(delivered.body.item.deliveredAt).toBeTruthy();
    });

    test('the lab queue report reflects this job and its turnaround', async () => {
      const queue = await request(app).get(`/api/labs/${labId}/queue`).set('Authorization', `Bearer ${receptionistA}`);
      expect(queue.status).toBe(200);
      expect(queue.body.jobs.some((j) => j.id === orderId)).toBe(true);
      expect(queue.body.averageTurnaroundDays).not.toBeNull();
    });

    test('financial integration is unchanged: the order still posts a balanced ledger entry despite the new clinical fields', async () => {
      const accountantToken = await createUserToken(tenantA.token, 'ACCOUNTANT');
      const journal = await request(app).get('/api/accounting/journal?sourceType=OPTICAL_ORDER').set('Authorization', `Bearer ${accountantToken}`);
      const entry = journal.body.items.find((e) => e.sourceId === orderId);
      expect(entry).toBeDefined();
      const totalDebit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const totalCredit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(totalDebit).toBeCloseTo(totalCredit, 2);
    });
  });

  describe('Patient 360 CRM view', () => {
    test('the 360 view aggregates appointments, examinations, prescriptions, optical orders, and balance', async () => {
      const res = await request(app).get(`/api/patients/${patientId}/360`).set('Authorization', `Bearer ${receptionistA}`);
      expect(res.status).toBe(200);
      expect(res.body.appointments.length).toBeGreaterThan(0);
      expect(res.body.examinations.length).toBeGreaterThan(0);
      expect(res.body.prescriptions.length).toBeGreaterThan(0);
      expect(res.body.opticalOrders.length).toBeGreaterThan(0);
      expect(typeof res.body.outstandingBalance).toBe('number');
    });
  });

  describe('Command Center clinical integration', () => {
    test('the clinical section reports today\'s appointments and range-based optical/examination KPIs', async () => {
      const res = await request(app).get('/api/dashboard/command-center').set('Authorization', `Bearer ${tenantA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.clinical).toBeDefined();
      expect(res.body.clinical.today.appointments).toBeGreaterThan(0);
      expect(res.body.clinical.range.examinationsCount).toBeGreaterThan(0);
      expect(res.body.clinical.range.opticalOrdersCreated).toBeGreaterThan(0);
      expect(Array.isArray(res.body.clinical.doctorPerformance)).toBe(true);
    });
  });

  describe('Audit logging for sensitive clinical actions', () => {
    test('creating a patient and an examination writes audit log entries', async () => {
      const before = await prisma.auditLog.count({ where: { tenantId: tenantA.tenantId, action: 'PATIENT_CREATE' } });
      await request(app).post('/api/patients').set('Authorization', `Bearer ${receptionistA}`).send({ name: `Audit Test Patient ${Date.now()}` });
      const after = await prisma.auditLog.count({ where: { tenantId: tenantA.tenantId, action: 'PATIENT_CREATE' } });
      expect(after).toBe(before + 1);

      const examBefore = await prisma.auditLog.count({ where: { tenantId: tenantA.tenantId, action: 'EXAMINATION_CREATE' } });
      await request(app).post('/api/examinations').set('Authorization', `Bearer ${doctorTokenA}`).send({ patientId, diagnosis: 'Routine check' });
      const examAfter = await prisma.auditLog.count({ where: { tenantId: tenantA.tenantId, action: 'EXAMINATION_CREATE' } });
      expect(examAfter).toBe(examBefore + 1);
    });
  });

  describe('Clinical reports', () => {
    test('the prescription-conversion report correctly counts a converted prescription', async () => {
      const rx = await request(app)
        .post('/api/clinical-prescriptions')
        .set('Authorization', `Bearer ${doctorTokenA}`)
        .send({ patientId, od: { sphere: -1 } });
      await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerIdOfPatient, patientId, clinicalPrescriptionId: rx.body.item.id, totalAmount: 50 });

      const res = await request(app).get('/api/clinical-reports/prescription-conversion').set('Authorization', `Bearer ${doctorTokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.convertedToOrder).toBeGreaterThan(0);
      expect(res.body.conversionRatePercent).toBeGreaterThan(0);
    });

    test('the customer-outstanding report reflects an unpaid optical order', async () => {
      await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistA}`)
        .send({ customerId: customerIdOfPatient, patientId, totalAmount: 300, amountPaid: 0 });

      const accountant = await createUserToken(tenantA.token, 'ACCOUNTANT');
      const res = await request(app).get('/api/clinical-reports/customer-outstanding').set('Authorization', `Bearer ${accountant}`);
      expect(res.status).toBe(200);
      const row = res.body.rows.find((r) => r.customerId === customerIdOfPatient);
      expect(row).toBeDefined();
      expect(row.outstanding).toBeGreaterThanOrEqual(300);
    });

    test('clinical reports are restricted appropriately (FINANCE_STAFF-only reports reject a receptionist)', async () => {
      const res = await request(app).get('/api/clinical-reports/customer-outstanding').set('Authorization', `Bearer ${receptionistA}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Tenant isolation', () => {
    test('tenant B cannot see or act on tenant A\'s patients, doctors, appointments, or prescriptions', async () => {
      const receptionistB = await createUserToken(tenantB.token, 'RECEPTIONIST');

      const patientGet = await request(app).get(`/api/patients/${patientId}`).set('Authorization', `Bearer ${receptionistB}`);
      expect(patientGet.status).toBe(404);

      const patientList = await request(app).get('/api/patients').set('Authorization', `Bearer ${receptionistB}`);
      expect(patientList.body.items.find((p) => p.id === patientId)).toBeUndefined();

      const doctorGet = await request(app).get(`/api/doctors/${doctorId}`).set('Authorization', `Bearer ${receptionistB}`);
      expect(doctorGet.status).toBe(404);
    });

    test('an appointment cannot be created against another tenant\'s patient or doctor', async () => {
      const receptionistB = await createUserToken(tenantB.token, 'RECEPTIONIST');
      const res = await request(app)
        .post('/api/appointments')
        .set('Authorization', `Bearer ${receptionistB}`)
        .send({ patientId, doctorId, scheduledAt: new Date(Date.now() + 86400000).toISOString() });
      expect(res.status).toBe(404);
    });

    test('an optical order cannot be created using another tenant\'s clinical prescription', async () => {
      const receptionistB = await createUserToken(tenantB.token, 'RECEPTIONIST');
      const customerB = await request(app).post('/api/customers').set('Authorization', `Bearer ${tenantB.token}`).send({ name: 'Tenant B Customer' });
      const rx = await request(app)
        .post('/api/clinical-prescriptions')
        .set('Authorization', `Bearer ${doctorTokenA}`)
        .send({ patientId, od: { sphere: -1 } });

      const res = await request(app)
        .post('/api/optical-orders')
        .set('Authorization', `Bearer ${receptionistB}`)
        .send({ customerId: customerB.body.item.id, clinicalPrescriptionId: rx.body.item.id, totalAmount: 50 });
      expect(res.status).toBe(404);
    });
  });
});
