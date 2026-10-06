-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "expense_categories" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "optical_orders" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_idempotencyKey_key" ON "customers"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_tenantId_idempotencyKey_key" ON "expenses"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "optical_orders_tenantId_idempotencyKey_key" ON "optical_orders"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_tenantId_idempotencyKey_key" ON "purchases"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_idempotencyKey_key" ON "suppliers"("tenantId", "idempotencyKey");

