-- AlterTable
ALTER TABLE "goods_receipts" ADD COLUMN     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "purchase_items" ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "purchase_requests" ADD COLUMN     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "warehouseId" TEXT;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

