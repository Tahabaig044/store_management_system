-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "code" TEXT,
ADD COLUMN     "notes" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_code_key" ON "customers"("tenantId", "code");

