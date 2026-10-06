-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryTxnType" ADD VALUE 'TRANSFER_DISPATCH';
ALTER TYPE "InventoryTxnType" ADD VALUE 'TRANSFER_RECEIVE';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "code" TEXT,
ADD COLUMN     "isOpen" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "inventory_transactions" ADD COLUMN     "warehouseId" TEXT;

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isCentral" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stocks" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lowStockThreshold" DECIMAL(12,2),
    "reorderLevel" DECIMAL(12,2),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "sourceWarehouseId" TEXT NOT NULL,
    "destinationWarehouseId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT,
    "requestedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_items" (
    "id" TEXT NOT NULL,
    "stockTransferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "receivedQuantity" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shortQuantity" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "damagedQuantity" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_branch_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_branch_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouses_tenantId_idx" ON "warehouses"("tenantId");

-- CreateIndex
CREATE INDEX "warehouse_stocks_productId_idx" ON "warehouse_stocks"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocks_warehouseId_productId_key" ON "warehouse_stocks"("warehouseId", "productId");

-- CreateIndex
CREATE INDEX "stock_transfers_tenantId_idx" ON "stock_transfers"("tenantId");

-- CreateIndex
CREATE INDEX "stock_transfers_tenantId_sourceWarehouseId_idx" ON "stock_transfers"("tenantId", "sourceWarehouseId");

-- CreateIndex
CREATE INDEX "stock_transfers_tenantId_destinationWarehouseId_idx" ON "stock_transfers"("tenantId", "destinationWarehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenantId_transferNumber_key" ON "stock_transfers"("tenantId", "transferNumber");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_tenantId_idempotencyKey_key" ON "stock_transfers"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "stock_transfer_items_stockTransferId_idx" ON "stock_transfer_items"("stockTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "user_branch_access_userId_branchId_key" ON "user_branch_access"("userId", "branchId");

-- CreateIndex
CREATE INDEX "expenses_tenantId_branchId_idx" ON "expenses"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "inventory_transactions_tenantId_warehouseId_idx" ON "inventory_transactions"("tenantId", "warehouseId");

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocks" ADD CONSTRAINT "warehouse_stocks_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocks" ADD CONSTRAINT "warehouse_stocks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sourceWarehouseId_fkey" FOREIGN KEY ("sourceWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_stockTransferId_fkey" FOREIGN KEY ("stockTransferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
