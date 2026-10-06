# Phase 7 — Advanced Optical + Eye Clinic + CRM

Supplements the Phase 4/5/6 docs. Covers the clinical/EMR layer added on top
of the existing operational, accounting, and multi-branch foundation.

## 1. The Central Design Decision: Patient Is Not a New Identity

Per the phase's own migration guidance ("where a customer already
represents a patient, design a safe relationship rather than duplicating
identities"), `Patient` is a **1:1 clinical extension of `Customer`**
(`Patient.customerId` unique, required) — never a parallel name/phone/
email record. Every existing Customer-linked capability (Sales, Payments,
the existing Customer History endpoint) keeps working completely
unchanged for a Customer that never becomes a Patient. A Customer becomes
clinically active only when a `Patient` row is explicitly created for
them — either alongside a brand-new Customer, or attached to an existing
one via `customerId`.

**Duplicate detection**: registering a new patient with a name+phone that
matches an existing Customer is rejected (409) with the existing record's
id, rather than silently creating a second identity — the caller links
the existing Customer instead. A `POST /api/patients/:id/merge` endpoint
additionally lets two already-created Patient records be consolidated:
every appointment/examination/prescription/optical-order moves to the
primary, and the duplicate is deactivated (`isActive: false`), never
deleted — preserving its audit trail.

## 2. Why `ClinicalPrescription` Is a New Model, Not a Change to `Prescription`

The existing `Prescription` model (1:1 with `OpticalOrder`, embedded,
order-time snapshot) was **not touched** — editing it or its relationship
to `OpticalOrder` would have meant rewriting how every existing optical
order stores its prescription, directly against the instruction not to
rewrite historical optical orders. Instead, `ClinicalPrescription` is a
new, separate, **patient-linked and versioned** model: the actual clinical
record of what was prescribed, independent of any specific order. A
correction is never an edit — it's a new row with `supersedesId` pointing
at the one it replaces, which flips to `isActive: false` but is never
deleted or rewritten. `version` increments each time.

**Clinical-to-commercial integration** (the phase's stated critical
requirement) happens by extending the *existing* `OpticalOrder` creation
endpoint (`POST /api/optical-orders`) with two new optional fields,
`patientId` and `clinicalPrescriptionId` — when a `clinicalPrescriptionId`
is supplied and the request doesn't already include its own `prescription`
object, the OD/OS/PD values are copied in automatically. No parallel
"create order from prescription" endpoint was built; the natural,
already-tested commercial engine handles it, satisfying "avoid isolated
modules" directly. An explicitly-provided `prescription` in the same
request still wins, for the case where a receptionist adjusts something at
order time.

## 3. Job Card / Lab Lifecycle

`OpticalOrder` (unchanged core fields) gained additive fields:
`patientId`, `clinicalPrescriptionId`, `labId`, `labCost`, `qcPassed`,
`qcNotes`, `qcAt`, `fittingNotes`, and a new status value `QUALITY_CHECK`
inserted into the existing lifecycle (`PENDING → IN_LAB → QUALITY_CHECK →
READY → DELIVERED`/`CANCELLED`). No parallel "Job" table was created —
every job **is** an `OpticalOrder`, per the instruction to integrate with
existing records. `Lab` (new, minimal: name/type/contact) represents both
in-house and third-party labs; `GET /api/labs/:id/queue` computes pending/
delayed counts and average turnaround directly from the `OpticalOrder`
rows assigned to that lab — no separate metrics table needed.

## 4. Appointments & Conflict Detection

`Appointment` supports the full stated status lifecycle (`SCHEDULED →
CONFIRMED → ARRIVED → IN_PROGRESS → COMPLETED`, with `CANCELLED`/
`NO_SHOW` as terminal alternates) and follow-up chaining
(`followUpOfId`, self-relation). **Conflict detection**: a doctor cannot
have two overlapping active appointments — checked by loading that
doctor's same-day active appointments and testing real time-range overlap
in application code (Prisma has no native "ranges overlap" operator),
tested explicitly including an exact back-to-back (non-overlapping)
booking succeeding. **Token/queue**: each appointment gets an
auto-incrementing token number, scoped per branch per day; `GET
/api/appointments/today` is the queue dashboard with waiting/in-progress/
completed counts.

## 5. Clinical & Sensitive Data Security

A new `DOCTOR` role and a `CLINICAL_STAFF` role group
(`TENANT_ADMIN`/`MANAGER`/`DOCTOR`/`RECEPTIONIST`) gate every clinical
endpoint (`/api/patients`, `/api/doctors`, `/api/appointments`,
`/api/examinations`, `/api/clinical-prescriptions`). **`CASHIER`,
`STORE_KEEPER`, and `ACCOUNTANT` are deliberately excluded** — tested
explicitly — even though those same roles can still see the same person
as an ordinary `Customer` via the pre-existing, unchanged
`/api/customers` endpoints. This is the concrete backend enforcement of
"separate clinical permissions from ordinary POS permissions" and "keep
ordinary shop users away from unnecessary clinical complexity."
Sensitive mutations (patient create/update, patient merge, patient 360
view, examination create, prescription create, prescription print,
appointment create/status-change, optical order create/update) all write
to the existing `AuditLog` via the existing `logAudit()` helper — no new
audit mechanism was needed. No clinical data is logged via `console.*`
anywhere in the new code (checked directly).

**Not implemented, disclosed rather than assumed**: file/document
attachments for patients. This codebase has no existing file-upload/
storage infrastructure to extend safely within this phase's scope, and
building one from scratch was judged too large a undertaking to do
correctly alongside everything else — flagged as a genuine gap, not
silently skipped.

## 6. Command Center Integration

`GET /api/dashboard/command-center` gained an additive `clinical` key:
- `today`: appointments, patientsSeen, waitingQueue, completedExaminations,
  prescriptionsIssued — literal "today," independent of the dashboard's
  range filter, matching how the original Phase 1 dashboard treats
  "today's sales."
- `range`: examinationsCount, opticalOrdersCreated/byStatus,
  pendingJobs/delayedJobs/readyOrders/deliveredOrders,
  outstandingOpticalPayments, newPatients/returningPatients,
  examinationToOpticalOrderConversionPercent — all respecting the
  dashboard's existing date-range selector.
- `doctorPerformance`: appointments/completions per doctor in range.

Existing keys (`kpis`, `stock`, `locations`, etc.) are completely
unchanged — this is purely additive.

## 7. Reports

Doctor performance, lab turnaround/rejection, and prescription history
already exist as dedicated endpoints from other modules
(`/doctors/:id/activity`, `/labs/:id/queue`, `/clinical-prescriptions`) and
weren't duplicated. New under `/api/clinical-reports/*`: patient visits,
appointments, examinations, pending/delayed jobs, optical
sales/profitability (revenue minus lab cost — optical orders aren't linked
to tracked Product/inventory cost, so this isn't a COGS-based margin the
way Sale profitability is), customer retention/repeat-purchase, new vs
returning customers, customer outstanding (sales + optical order
balances combined per customer), branch-wise clinic/optical activity, and
prescription-to-order conversion rate.

## 8. Migration & Data Safety

One migration, `phase7_optical_clinic_crm` — purely additive: 6 new
tables (`patients`, `doctors`, `appointments`, `examinations`,
`clinical_prescriptions`, `labs`), a new `DOCTOR` value on `RoleName`, a
new `QUALITY_CHECK` value on `OpticalOrderStatus`, and 9 new nullable
columns on `OpticalOrder` (`patientId`, `clinicalPrescriptionId`, `labId`,
`labCost`, `qcPassed`, `qcNotes`, `qcAt`, `fittingNotes`). No existing
column was altered, no existing table renamed, no data rewritten. Every
pre-existing `OpticalOrder`/`Prescription`/`Customer` row is valid and
unaffected exactly as it was before this phase. Verified via `prisma
migrate deploy` against a disposable database; **not applied to
production.**

## 9. Testing

32 new tests in `tests/clinical.test.js`: patient creation/duplicate-
detection/linking/merge, clinical RBAC (explicit rejection of
CASHIER/STORE_KEEPER/ACCOUNTANT, explicit acceptance of DOCTOR/
RECEPTIONIST), doctor management, appointment conflict detection
(overlapping rejected, back-to-back accepted) and idempotent retry,
appointment status lifecycle (including regression-from-final-state
rejection), today's queue, examination creation and historical listing,
prescription versioning (supersede chain, old version's values proven
unchanged, cannot supersede an already-superseded version), the
prescription→optical-order integration (defaults applied, explicit
override wins, cross-patient prescription rejected), the full job-card/
lab lifecycle through `QUALITY_CHECK`/`DELIVERED` with a balanced ledger
entry proving financial integration is unaffected, the 360 view, three
new clinical report assertions with real numbers, audit log entries
actually being written, and tenant isolation across every new model. All
199 backend tests (167 pre-existing + 32 new) and 48 frontend tests (46
pre-existing + 2 new) pass.

## 10. Frontend Coverage

New pages: `pages/patients/Patients.jsx` (search, registration, and an
integrated 360° view with tabs for appointments/examinations/
prescriptions/orders — including in-line examination and prescription
entry forms and a one-click "Create Optical Order" action from any active
prescription, directly demonstrating the clinical-to-commercial
integration in the UI, not just the API), `pages/clinical/Appointments.jsx`
(booking, today's queue, status actions), `pages/clinical/Doctors.jsx`
(minimal admin list/create — necessary for appointment booking to be
usable at all). **Not built as a dedicated screen this phase** (fully
tested and reachable via API): a Labs admin page (optical orders function
fine with `labId` left unset, so this doesn't block core usage), and
dedicated screens for the ten new clinical/optical reports (accessible via
API; a future phase could add an "Optical & Clinic Reports" tab following
the same pattern as the existing Accounting reports page).
