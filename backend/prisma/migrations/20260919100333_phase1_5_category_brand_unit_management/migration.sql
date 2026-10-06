-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "brandId" TEXT,
ADD COLUMN     "unitId" TEXT;

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "baseUnitId" TEXT,
    "conversionFactor" DECIMAL(12,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brands_tenantId_idx" ON "brands"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenantId_name_key" ON "brands"("tenantId", "name");

-- CreateIndex
CREATE INDEX "units_of_measure_tenantId_idx" ON "units_of_measure"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_tenantId_name_key" ON "units_of_measure"("tenantId", "name");

-- CreateIndex
CREATE INDEX "categories_tenantId_parentId_idx" ON "categories"("tenantId", "parentId");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_baseUnitId_fkey" FOREIGN KEY ("baseUnitId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
