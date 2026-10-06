/*
  Warnings:

  - Added the required column `updatedAt` to the `expense_categories` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- updatedAt backfills existing rows to now() via DEFAULT so this stays additive
-- (no data loss) even though the column is NOT NULL going forward.
ALTER TABLE "expense_categories" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
