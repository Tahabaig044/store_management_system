-- CreateIndex
CREATE INDEX "customers_tenantId_phone_idx" ON "customers"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "customers_tenantId_email_idx" ON "customers"("tenantId", "email");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_phone_idx" ON "suppliers"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "suppliers_tenantId_email_idx" ON "suppliers"("tenantId", "email");

