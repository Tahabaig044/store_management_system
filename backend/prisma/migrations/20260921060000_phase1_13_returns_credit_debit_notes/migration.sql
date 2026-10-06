-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('COMPLETED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DebitNoteStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSourceType" ADD VALUE 'SALES_RETURN';
ALTER TYPE "JournalSourceType" ADD VALUE 'SALES_RETURN_REVERSAL';
ALTER TYPE "JournalSourceType" ADD VALUE 'PURCHASE_RETURN_REVERSAL';
ALTER TYPE "JournalSourceType" ADD VALUE 'CREDIT_NOTE';
ALTER TYPE "JournalSourceType" ADD VALUE 'CREDIT_NOTE_CANCEL';
ALTER TYPE "JournalSourceType" ADD VALUE 'CREDIT_NOTE_REFUND';
ALTER TYPE "JournalSourceType" ADD VALUE 'DEBIT_NOTE';
ALTER TYPE "JournalSourceType" ADD VALUE 'DEBIT_NOTE_CANCEL';
ALTER TYPE "JournalSourceType" ADD VALUE 'DEBIT_NOTE_REFUND';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "creditNoteId" TEXT,
ADD COLUMN     "debitNoteId" TEXT;

-- AlterTable
ALTER TABLE "purchase_items" ADD COLUMN     "returnedQuantity" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "returnedQuantity" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sales_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnNumber" TEXT,
    "saleId" TEXT NOT NULL,
    "customerId" TEXT,
    "branchId" TEXT,
    "warehouseId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'COMPLETED',
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_items" (
    "id" TEXT NOT NULL,
    "salesReturnId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "sales_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnNumber" TEXT,
    "purchaseId" TEXT NOT NULL,
    "supplierId" TEXT,
    "branchId" TEXT,
    "warehouseId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'COMPLETED',
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_items" (
    "id" TEXT NOT NULL,
    "purchaseReturnId" TEXT NOT NULL,
    "purchaseItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "purchase_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "creditNoteNumber" TEXT,
    "customerId" TEXT NOT NULL,
    "salesReturnId" TEXT,
    "branchId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "notes" TEXT,
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'ISSUED',
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "debitNoteNumber" TEXT,
    "supplierId" TEXT NOT NULL,
    "purchaseReturnId" TEXT,
    "branchId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "notes" TEXT,
    "status" "DebitNoteStatus" NOT NULL DEFAULT 'ISSUED',
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_returns_tenantId_idx" ON "sales_returns"("tenantId");

-- CreateIndex
CREATE INDEX "sales_returns_tenantId_saleId_idx" ON "sales_returns"("tenantId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_tenantId_returnNumber_key" ON "sales_returns"("tenantId", "returnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_tenantId_idempotencyKey_key" ON "sales_returns"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sales_return_items_salesReturnId_idx" ON "sales_return_items"("salesReturnId");

-- CreateIndex
CREATE INDEX "sales_return_items_saleItemId_idx" ON "sales_return_items"("saleItemId");

-- CreateIndex
CREATE INDEX "purchase_returns_tenantId_idx" ON "purchase_returns"("tenantId");

-- CreateIndex
CREATE INDEX "purchase_returns_tenantId_purchaseId_idx" ON "purchase_returns"("tenantId", "purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_tenantId_returnNumber_key" ON "purchase_returns"("tenantId", "returnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_tenantId_idempotencyKey_key" ON "purchase_returns"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "purchase_return_items_purchaseReturnId_idx" ON "purchase_return_items"("purchaseReturnId");

-- CreateIndex
CREATE INDEX "purchase_return_items_purchaseItemId_idx" ON "purchase_return_items"("purchaseItemId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_salesReturnId_key" ON "credit_notes"("salesReturnId");

-- CreateIndex
CREATE INDEX "credit_notes_tenantId_idx" ON "credit_notes"("tenantId");

-- CreateIndex
CREATE INDEX "credit_notes_tenantId_customerId_idx" ON "credit_notes"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_tenantId_creditNoteNumber_key" ON "credit_notes"("tenantId", "creditNoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_tenantId_idempotencyKey_key" ON "credit_notes"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_purchaseReturnId_key" ON "debit_notes"("purchaseReturnId");

-- CreateIndex
CREATE INDEX "debit_notes_tenantId_idx" ON "debit_notes"("tenantId");

-- CreateIndex
CREATE INDEX "debit_notes_tenantId_supplierId_idx" ON "debit_notes"("tenantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_tenantId_debitNoteNumber_key" ON "debit_notes"("tenantId", "debitNoteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_tenantId_idempotencyKey_key" ON "debit_notes"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_debitNoteId_fkey" FOREIGN KEY ("debitNoteId") REFERENCES "debit_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_salesReturnId_fkey" FOREIGN KEY ("salesReturnId") REFERENCES "sales_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "purchase_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "purchase_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_salesReturnId_fkey" FOREIGN KEY ("salesReturnId") REFERENCES "sales_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "purchase_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- AlterEnum
ALTER TYPE "InventoryTxnType" ADD VALUE 'SALES_RETURN';

-- AlterEnum
ALTER TYPE "PermissionAction" ADD VALUE 'REFUND';
