-- CreateEnum
CREATE TYPE "SyncIssueStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "sync_terminals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "label" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "oldestPendingAt" TIMESTAMP(3),
    "lastReportSentAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_terminals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_issues" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "terminalRecordId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "status" "SyncIssueStatus" NOT NULL DEFAULT 'OPEN',
    "firstReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgeNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "sync_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_terminals_tenantId_idx" ON "sync_terminals"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_terminals_tenantId_terminalId_key" ON "sync_terminals"("tenantId", "terminalId");

-- CreateIndex
CREATE INDEX "sync_issues_tenantId_status_idx" ON "sync_issues"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sync_issues_terminalRecordId_clientId_key" ON "sync_issues"("terminalRecordId", "clientId");

-- AddForeignKey
ALTER TABLE "sync_terminals" ADD CONSTRAINT "sync_terminals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_terminalRecordId_fkey" FOREIGN KEY ("terminalRecordId") REFERENCES "sync_terminals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

