-- Phase 0.2: Universal Product Architecture
-- Purely additive migration: no existing column, table, or row is dropped,
-- renamed, or retyped. See docs/phase0-2-architecture-package.md and
-- docs/phase0-2-migration-api-compatibility-plan.md for the approved design
-- this migration implements.
--
-- NOTE: this file was authored by hand and has NOT been applied to any
-- database (including the local test database) in this session, because
-- running `npx prisma migrate dev` / `migrate deploy` was blocked by the
-- sandbox's permission classifier. It is written to match this project's
-- existing Prisma-generated migration style exactly, but must be reviewed
-- and applied (via `npx prisma migrate dev` against a local test database)
-- before it can be trusted to behave identically to a tool-generated one.

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('PHYSICAL_GOOD', 'SERVICE');

-- CreateEnum
CREATE TYPE "OpticalAttributeKind" AS ENUM ('FRAME', 'LENS', 'CONTACT_LENS', 'ACCESSORY');

-- AlterTable
ALTER TABLE "products" ADD COLUMN "productKind" "ProductKind" NOT NULL DEFAULT 'PHYSICAL_GOOD',
                        ADD COLUMN "brand" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "enabledIndustryPacks" TEXT[] NOT NULL DEFAULT ARRAY['OPTICAL','MEDICINE']::TEXT[];

-- CreateTable
CREATE TABLE "product_optical_attributes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "opticalKind" "OpticalAttributeKind" NOT NULL,
    "frameBrand" TEXT,
    "frameModel" TEXT,
    "frameColor" TEXT,
    "frameSize" TEXT,
    "lensType" TEXT,
    "lensMaterial" TEXT,
    "lensCoating" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_optical_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_medicine_attributes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchNumber" TEXT,
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_medicine_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "priceOverride" DECIMAL(12,2),
    "stockQuantity" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_optical_attributes_productId_key" ON "product_optical_attributes"("productId");

-- CreateIndex
CREATE INDEX "product_optical_attributes_tenantId_idx" ON "product_optical_attributes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_medicine_attributes_productId_key" ON "product_medicine_attributes"("productId");

-- CreateIndex
CREATE INDEX "product_medicine_attributes_tenantId_idx" ON "product_medicine_attributes"("tenantId");

-- CreateIndex
CREATE INDEX "product_medicine_attributes_tenantId_expiryDate_idx" ON "product_medicine_attributes"("tenantId", "expiryDate");

-- CreateIndex
CREATE INDEX "product_variants_tenantId_idx" ON "product_variants"("tenantId");

-- CreateIndex
CREATE INDEX "product_variants_tenantId_productId_idx" ON "product_variants"("tenantId", "productId");

-- AddForeignKey
ALTER TABLE "product_optical_attributes" ADD CONSTRAINT "product_optical_attributes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_optical_attributes" ADD CONSTRAINT "product_optical_attributes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_medicine_attributes" ADD CONSTRAINT "product_medicine_attributes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_medicine_attributes" ADD CONSTRAINT "product_medicine_attributes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
