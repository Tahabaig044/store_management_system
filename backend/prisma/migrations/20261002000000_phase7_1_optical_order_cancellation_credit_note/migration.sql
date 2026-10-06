-- Phase 7.1: CreditNote.reversedOpticalOrderId - the identical pattern as the
-- existing reversedSaleId, for an Optical Order cancelled after money was
-- already collected against it. Purely additive: a new nullable, unique column.
ALTER TABLE "credit_notes" ADD COLUMN "reversedOpticalOrderId" TEXT;

CREATE UNIQUE INDEX "credit_notes_reversedOpticalOrderId_key" ON "credit_notes"("reversedOpticalOrderId");
