-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'INVENTORY_ADJUSTMENT';

-- AlterTable
ALTER TABLE "credit_notes" ADD COLUMN     "reversedSaleId" TEXT;

-- AlterTable
ALTER TABLE "debit_notes" ADD COLUMN     "returnedPurchaseId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_reversedSaleId_key" ON "credit_notes"("reversedSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_returnedPurchaseId_key" ON "debit_notes"("returnedPurchaseId");

