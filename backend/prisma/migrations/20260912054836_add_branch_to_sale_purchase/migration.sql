-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "purchases_tenantId_branchId_idx" ON "purchases"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "sales_tenantId_branchId_idx" ON "sales"("tenantId", "branchId");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
