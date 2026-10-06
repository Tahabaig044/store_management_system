-- CreateEnum
CREATE TYPE "AiConversationScope" AS ENUM ('BUSINESS_ASSISTANT');

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AiInsightType" AS ENUM ('FORECAST', 'ANOMALY', 'RECOMMENDATION', 'BRIEF');

-- CreateEnum
CREATE TYPE "AiInsightSeverity" AS ENUM ('URGENT', 'ATTENTION', 'OPPORTUNITY', 'INFORMATION');

-- CreateEnum
CREATE TYPE "AiInsightStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AiForecastScope" AS ENUM ('TENANT', 'BRANCH', 'CATEGORY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "AiForecastGranularity" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "ai_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "provider" TEXT NOT NULL DEFAULT 'deterministic',
    "credentials" JSONB,
    "dailyRequestLimit" INTEGER NOT NULL DEFAULT 200,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "AiConversationScope" NOT NULL DEFAULT 'BUSINESS_ASSISTANT',
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "grounding" JSONB,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_insights" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "type" "AiInsightType" NOT NULL,
    "category" TEXT NOT NULL,
    "severity" "AiInsightSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "recommendedAction" TEXT,
    "confidence" DOUBLE PRECISION,
    "scopeFrom" TIMESTAMP(3),
    "scopeTo" TIMESTAMP(3),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "status" "AiInsightStatus" NOT NULL DEFAULT 'NEW',
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "dismissedById" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_forecasts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "AiForecastScope" NOT NULL,
    "scopeId" TEXT,
    "granularity" "AiForecastGranularity" NOT NULL,
    "method" TEXT NOT NULL,
    "dataPointsUsed" INTEGER NOT NULL,
    "series" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,

    CONSTRAINT "ai_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "requestTokens" INTEGER,
    "responseTokens" INTEGER,
    "costEstimate" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_feedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "insightId" TEXT,
    "messageId" TEXT,
    "helpful" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_configs_tenantId_key" ON "ai_configs"("tenantId");

-- CreateIndex
CREATE INDEX "ai_conversations_tenantId_userId_idx" ON "ai_conversations"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_idx" ON "ai_messages"("conversationId");

-- CreateIndex
CREATE INDEX "ai_insights_tenantId_status_idx" ON "ai_insights"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ai_insights_tenantId_type_idx" ON "ai_insights"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ai_insights_tenantId_dedupeKey_key" ON "ai_insights"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "ai_forecasts_tenantId_scope_scopeId_idx" ON "ai_forecasts"("tenantId", "scope", "scopeId");

-- CreateIndex
CREATE INDEX "ai_usage_logs_tenantId_createdAt_idx" ON "ai_usage_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_feedback_tenantId_insightId_idx" ON "ai_feedback"("tenantId", "insightId");

-- AddForeignKey
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_forecasts" ADD CONSTRAINT "ai_forecasts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "ai_insights"("id") ON DELETE SET NULL ON UPDATE CASCADE;
