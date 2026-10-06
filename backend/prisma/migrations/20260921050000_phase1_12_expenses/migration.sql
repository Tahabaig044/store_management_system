-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PAID', 'REVERSED');

-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'EXPENSE_REVERSAL';

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "expenseNumber" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "payeeUserId" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ExpenseStatus" NOT NULL DEFAULT 'PAID',
ADD COLUMN     "supplierId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "expenses_tenantId_expenseNumber_key" ON "expenses"("tenantId", "expenseNumber");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payeeUserId_fkey" FOREIGN KEY ("payeeUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

