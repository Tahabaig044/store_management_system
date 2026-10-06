-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "warehouseId" TEXT;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

