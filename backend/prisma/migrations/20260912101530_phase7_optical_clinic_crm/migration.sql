-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "LabType" AS ENUM ('IN_HOUSE', 'THIRD_PARTY');

-- AlterEnum
ALTER TYPE "OpticalOrderStatus" ADD VALUE 'QUALITY_CHECK';

-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'DOCTOR';

-- AlterTable
ALTER TABLE "optical_orders" ADD COLUMN     "clinicalPrescriptionId" TEXT,
ADD COLUMN     "fittingNotes" TEXT,
ADD COLUMN     "labCost" DECIMAL(12,2),
ADD COLUMN     "labId" TEXT,
ADD COLUMN     "patientId" TEXT,
ADD COLUMN     "qcAt" TIMESTAMP(3),
ADD COLUMN     "qcNotes" TEXT,
ADD COLUMN     "qcPassed" BOOLEAN;

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "patientNumber" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "bloodGroup" TEXT,
    "allergies" TEXT,
    "medicalHistory" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "specialty" TEXT,
    "designation" TEXT,
    "availability" JSONB,
    "appointmentCapacityPerDay" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "appointmentType" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "tokenNumber" INTEGER,
    "notes" TEXT,
    "followUpOfId" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "examinations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "appointmentId" TEXT,
    "examDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vaOdDistance" TEXT,
    "vaOsDistance" TEXT,
    "vaOdNear" TEXT,
    "vaOsNear" TEXT,
    "odSphere" DECIMAL(5,2),
    "odCylinder" DECIMAL(5,2),
    "odAxis" INTEGER,
    "odAdd" DECIMAL(5,2),
    "osSphere" DECIMAL(5,2),
    "osCylinder" DECIMAL(5,2),
    "osAxis" INTEGER,
    "osAdd" DECIMAL(5,2),
    "pd" DECIMAL(5,2),
    "clinicalNotes" TEXT,
    "diagnosis" TEXT,
    "treatmentAdvice" TEXT,
    "followUpDate" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "examinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_prescriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "examinationId" TEXT,
    "doctorId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "odSphere" DECIMAL(5,2),
    "odCylinder" DECIMAL(5,2),
    "odAxis" INTEGER,
    "odAdd" DECIMAL(5,2),
    "osSphere" DECIMAL(5,2),
    "osCylinder" DECIMAL(5,2),
    "osAxis" INTEGER,
    "osAdd" DECIMAL(5,2),
    "pd" DECIMAL(5,2),
    "lensRecommendation" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LabType" NOT NULL DEFAULT 'IN_HOUSE',
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_customerId_key" ON "patients"("customerId");

-- CreateIndex
CREATE INDEX "patients_tenantId_idx" ON "patients"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "patients_tenantId_patientNumber_key" ON "patients"("tenantId", "patientNumber");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_userId_key" ON "doctors"("userId");

-- CreateIndex
CREATE INDEX "doctors_tenantId_idx" ON "doctors"("tenantId");

-- CreateIndex
CREATE INDEX "appointments_tenantId_scheduledAt_idx" ON "appointments"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "appointments_tenantId_doctorId_scheduledAt_idx" ON "appointments"("tenantId", "doctorId", "scheduledAt");

-- CreateIndex
CREATE INDEX "appointments_tenantId_patientId_idx" ON "appointments"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenantId_idempotencyKey_key" ON "appointments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "examinations_appointmentId_key" ON "examinations"("appointmentId");

-- CreateIndex
CREATE INDEX "examinations_tenantId_patientId_idx" ON "examinations"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_prescriptions_supersedesId_key" ON "clinical_prescriptions"("supersedesId");

-- CreateIndex
CREATE INDEX "clinical_prescriptions_tenantId_patientId_idx" ON "clinical_prescriptions"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "labs_tenantId_idx" ON "labs"("tenantId");

-- CreateIndex
CREATE INDEX "optical_orders_tenantId_patientId_idx" ON "optical_orders"("tenantId", "patientId");

-- AddForeignKey
ALTER TABLE "optical_orders" ADD CONSTRAINT "optical_orders_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optical_orders" ADD CONSTRAINT "optical_orders_clinicalPrescriptionId_fkey" FOREIGN KEY ("clinicalPrescriptionId") REFERENCES "clinical_prescriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optical_orders" ADD CONSTRAINT "optical_orders_labId_fkey" FOREIGN KEY ("labId") REFERENCES "labs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_followUpOfId_fkey" FOREIGN KEY ("followUpOfId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_examinationId_fkey" FOREIGN KEY ("examinationId") REFERENCES "examinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "clinical_prescriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labs" ADD CONSTRAINT "labs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
