-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ANDROID');

-- CreateEnum
CREATE TYPE "MinimumAlertPriority" AS ENUM ('CRITICAL_ONLY', 'IMPORTANT_PLUS', 'ALL');

-- AlterTable
ALTER TABLE "ai_insights" ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "notifiedSeverity" "AiInsightSeverity";

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL DEFAULT 'ANDROID',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_preferences" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dailySummaryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "dailySummaryTime" TEXT NOT NULL DEFAULT '08:00',
    "salesAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "profitAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "receivableAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "inventoryAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "expenseAnomalyAlertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minimumPriority" "MinimumAlertPriority" NOT NULL DEFAULT 'ALL',
    "lastDailySummarySentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "credentials" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_tokens_tenantId_userId_idx" ON "device_tokens"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_tenantId_token_key" ON "device_tokens"("tenantId", "token");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_preferences_userId_key" ON "user_notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "push_configs_tenantId_key" ON "push_configs"("tenantId");

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_configs" ADD CONSTRAINT "push_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
