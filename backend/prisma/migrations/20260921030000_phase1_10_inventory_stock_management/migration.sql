-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transactions_tenantId_idempotencyKey_key" ON "inventory_transactions"("tenantId", "idempotencyKey");

