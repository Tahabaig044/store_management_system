-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "code" TEXT,
ADD COLUMN     "notes" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_code_key" ON "suppliers"("tenantId", "code");
