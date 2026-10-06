-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "address" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "ntn" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "strn" TEXT;
