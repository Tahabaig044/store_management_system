-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP', 'IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TemplateType" AS ENUM ('INVOICE_RECEIPT', 'PAYMENT_RECEIPT', 'PAYMENT_REMINDER', 'CUSTOMER_STATEMENT', 'OPTICAL_ORDER_CONFIRMATION', 'OPTICAL_ORDER_STATUS_UPDATE', 'OPTICAL_JOB_READY', 'OPTICAL_ORDER_DELIVERED', 'APPOINTMENT_CONFIRMATION', 'APPOINTMENT_REMINDER', 'APPOINTMENT_CANCELLED', 'FOLLOW_UP_REMINDER', 'PRESCRIPTION_SUMMARY', 'PROMOTIONAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AutomationEvent" AS ENUM ('SALE_COMPLETED', 'PAYMENT_RECEIVED', 'INVOICE_OVERDUE', 'OPTICAL_ORDER_CREATED', 'OPTICAL_JOB_READY', 'OPTICAL_ORDER_DELIVERED', 'OPTICAL_JOB_DELAYED', 'APPOINTMENT_BOOKED', 'APPOINTMENT_APPROACHING', 'APPOINTMENT_NO_SHOW', 'STOCK_LOW', 'EXPIRY_APPROACHING', 'PURCHASE_APPROVED', 'TRANSFER_COMPLETED', 'CUSTOMER_INACTIVE', 'DAILY_CLOSE');

-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('WHATSAPP_MESSAGE', 'IN_APP_NOTIFICATION', 'DASHBOARD_ALERT');

-- CreateEnum
CREATE TYPE "AutomationExecutionStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "communication_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "credentials" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "businessHoursStart" INTEGER,
    "businessHoursEnd" INTEGER,
    "maxCampaignMessagesPerCustomerPerDay" INTEGER NOT NULL DEFAULT 1,
    "senderLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "TemplateType" NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'WHATSAPP',
    "body" TEXT NOT NULL,
    "isApproved" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "channel" "MessageChannel" NOT NULL DEFAULT 'WHATSAPP',
    "customerId" TEXT,
    "recipientPhone" TEXT,
    "templateId" TEXT,
    "body" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "sourceEventType" TEXT,
    "sourceId" TEXT,
    "triggeredByUserId" TEXT,
    "automationRuleId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "event" "AutomationEvent" NOT NULL,
    "name" TEXT NOT NULL,
    "conditions" JSONB,
    "actionType" "AutomationActionType" NOT NULL DEFAULT 'WHATSAPP_MESSAGE',
    "templateId" TEXT,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_executions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "automationRuleId" TEXT NOT NULL,
    "event" "AutomationEvent" NOT NULL,
    "sourceId" TEXT,
    "status" "AutomationExecutionStatus" NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_communication_preferences" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "whatsappOptOut" BOOLEAN NOT NULL DEFAULT false,
    "promotionalOptOut" BOOLEAN NOT NULL DEFAULT false,
    "preferences" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_communication_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_portal_accounts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "passwordHash" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_portal_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_portal_otps" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_portal_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "communication_configs_tenantId_key" ON "communication_configs"("tenantId");

-- CreateIndex
CREATE INDEX "message_templates_tenantId_idx" ON "message_templates"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenantId_type_name_key" ON "message_templates"("tenantId", "type", "name");

-- CreateIndex
CREATE INDEX "messages_tenantId_status_idx" ON "messages"("tenantId", "status");

-- CreateIndex
CREATE INDEX "messages_tenantId_customerId_idx" ON "messages"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "messages_tenantId_queuedAt_idx" ON "messages"("tenantId", "queuedAt");

-- CreateIndex
CREATE INDEX "messages_tenantId_branchId_idx" ON "messages"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenantId_idempotencyKey_key" ON "messages"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "automation_rules_tenantId_event_idx" ON "automation_rules"("tenantId", "event");

-- CreateIndex
CREATE INDEX "automation_executions_tenantId_event_idx" ON "automation_executions"("tenantId", "event");

-- CreateIndex
CREATE UNIQUE INDEX "automation_executions_tenantId_automationRuleId_sourceId_key" ON "automation_executions"("tenantId", "automationRuleId", "sourceId");

-- CreateIndex
CREATE INDEX "notifications_tenantId_userId_isRead_idx" ON "notifications"("tenantId", "userId", "isRead");

-- CreateIndex
CREATE UNIQUE INDEX "customer_communication_preferences_customerId_key" ON "customer_communication_preferences"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_portal_accounts_customerId_key" ON "customer_portal_accounts"("customerId");

-- CreateIndex
CREATE INDEX "customer_portal_accounts_tenantId_idx" ON "customer_portal_accounts"("tenantId");

-- CreateIndex
CREATE INDEX "customer_portal_otps_accountId_idx" ON "customer_portal_otps"("accountId");

-- AddForeignKey
ALTER TABLE "communication_configs" ADD CONSTRAINT "communication_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_automationRuleId_fkey" FOREIGN KEY ("automationRuleId") REFERENCES "automation_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_automationRuleId_fkey" FOREIGN KEY ("automationRuleId") REFERENCES "automation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_communication_preferences" ADD CONSTRAINT "customer_communication_preferences_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_portal_accounts" ADD CONSTRAINT "customer_portal_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_portal_accounts" ADD CONSTRAINT "customer_portal_accounts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_portal_otps" ADD CONSTRAINT "customer_portal_otps_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "customer_portal_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
