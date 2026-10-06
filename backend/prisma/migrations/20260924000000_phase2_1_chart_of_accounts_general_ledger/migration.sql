-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalStatus" ADD VALUE 'DRAFT';
ALTER TYPE "JournalStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "postedAt" TIMESTAMP(3),
ADD COLUMN     "reference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_tenantId_idempotencyKey_key" ON "journal_entries"("tenantId", "idempotencyKey");


-- Backfill: every pre-existing entry was posted at creation time.
UPDATE "journal_entries" SET "postedAt" = "createdAt" WHERE "postedAt" IS NULL;
