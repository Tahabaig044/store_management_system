-- CreateEnum
CREATE TYPE "NoteApplicationStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- AlterTable
ALTER TABLE "credit_notes" ADD COLUMN     "appliedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "debit_notes" ADD COLUMN     "appliedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "note_applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "creditNoteId" TEXT,
    "debitNoteId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "NoteApplicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "branchId" TEXT,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "note_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_application_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "saleId" TEXT,
    "purchaseId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "note_application_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "note_applications_tenantId_idx" ON "note_applications"("tenantId");

-- CreateIndex
CREATE INDEX "note_applications_creditNoteId_idx" ON "note_applications"("creditNoteId");

-- CreateIndex
CREATE INDEX "note_applications_debitNoteId_idx" ON "note_applications"("debitNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "note_applications_tenantId_idempotencyKey_key" ON "note_applications"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "note_application_lines_tenantId_idx" ON "note_application_lines"("tenantId");

-- CreateIndex
CREATE INDEX "note_application_lines_applicationId_idx" ON "note_application_lines"("applicationId");

-- AddForeignKey
ALTER TABLE "note_applications" ADD CONSTRAINT "note_applications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_applications" ADD CONSTRAINT "note_applications_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_applications" ADD CONSTRAINT "note_applications_debitNoteId_fkey" FOREIGN KEY ("debitNoteId") REFERENCES "debit_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_application_lines" ADD CONSTRAINT "note_application_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_application_lines" ADD CONSTRAINT "note_application_lines_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "note_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_application_lines" ADD CONSTRAINT "note_application_lines_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_application_lines" ADD CONSTRAINT "note_application_lines_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

