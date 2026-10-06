-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "purchase_requests" ADD COLUMN     "requiredDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rfqs" ADD COLUMN     "expectedDeliveryDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "supplier_quotations" ADD COLUMN     "notes" TEXT;
