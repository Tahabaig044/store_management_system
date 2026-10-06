-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AutomationEvent" ADD VALUE 'SALE_CANCELLED';
ALTER TYPE "AutomationEvent" ADD VALUE 'PAYMENT_REVERSED';
ALTER TYPE "AutomationEvent" ADD VALUE 'EXPENSE_CREATED';
ALTER TYPE "AutomationEvent" ADD VALUE 'EXPENSE_REVERSED';
ALTER TYPE "AutomationEvent" ADD VALUE 'RETURN_CREATED';
ALTER TYPE "AutomationEvent" ADD VALUE 'CREDIT_NOTE_CREATED';
ALTER TYPE "AutomationEvent" ADD VALUE 'DEBIT_NOTE_CREATED';
ALTER TYPE "AutomationEvent" ADD VALUE 'QUOTATION_ACCEPTED';
ALTER TYPE "AutomationEvent" ADD VALUE 'SALES_ORDER_CONFIRMED';
ALTER TYPE "AutomationEvent" ADD VALUE 'SALES_ORDER_CANCELLED';

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'IN_APP',
ADD COLUMN     "deliveryStatus" TEXT NOT NULL DEFAULT 'DELIVERED',
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "readAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entity_entityId_idx" ON "audit_logs"("tenantId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_action_idx" ON "audit_logs"("tenantId", "action");

-- CreateIndex
CREATE INDEX "notifications_tenantId_userId_createdAt_idx" ON "notifications"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_tenantId_entityType_entityId_idx" ON "notifications"("tenantId", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

