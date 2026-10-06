-- AlterTable
ALTER TABLE "optical_orders" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "appointmentId" TEXT;

-- CreateTable
CREATE TABLE "optical_order_items" (
    "id" TEXT NOT NULL,
    "opticalOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "optical_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "optical_order_items_opticalOrderId_idx" ON "optical_order_items"("opticalOrderId");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optical_orders" ADD CONSTRAINT "optical_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optical_orders" ADD CONSTRAINT "optical_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optical_order_items" ADD CONSTRAINT "optical_order_items_opticalOrderId_fkey" FOREIGN KEY ("opticalOrderId") REFERENCES "optical_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optical_order_items" ADD CONSTRAINT "optical_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
