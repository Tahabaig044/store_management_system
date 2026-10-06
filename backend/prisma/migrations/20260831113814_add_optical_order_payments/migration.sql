-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "opticalOrderId" TEXT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_opticalOrderId_fkey" FOREIGN KEY ("opticalOrderId") REFERENCES "optical_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
