-- CreateTable
CREATE TABLE "sequence_counters" (
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_counters_pkey" PRIMARY KEY ("tenantId","key")
);

-- AddForeignKey
ALTER TABLE "sequence_counters" ADD CONSTRAINT "sequence_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
