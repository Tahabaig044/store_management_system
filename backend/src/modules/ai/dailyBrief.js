// Owner Mobile "Daily AI Business Advice" (Phase 4). Wraps the existing,
// unmodified `compileDailyBrief` (brief.js) with a once-per-day cache: the
// compiled brief is stored as an AiInsight row (type: BRIEF - an enum value
// that already existed but nothing wrote to it before this) whose
// `dedupeKey` is the tenant's local calendar date. This gives two things at
// once, for free, via machinery that already exists and is already tested:
//   - caching ("every app open does not trigger a new AI request" - the
//     phase's own cost-control rule): a second call the same day returns the
//     same row instead of recomputing.
//   - history ("AI history is available for previous recommendations"):
//     each day's brief is a permanent, distinct row, automatically included
//     wherever AiInsight rows are already listed/paginated.
const prisma = require('../../config/prisma');
const { compileDailyBrief } = require('./brief');
const { upsertInsight } = require('./recommendations');

const SEVERITY_RANK = { URGENT: 0, ATTENTION: 1, OPPORTUNITY: 2, INFORMATION: 3 };

function dateKeyAt(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC' }).format(date);
}

// The brief's own severity mirrors its highest-priority top action, so a day
// with an urgent issue shows as urgent in the Alert Center / Needs
// Attention list too, not buried as a neutral "informational" row.
function severityForBrief(brief) {
  if (brief.topActions.length === 0) return 'INFORMATION';
  return brief.topActions
    .map((a) => a.severity)
    .sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0];
}

/**
 * Returns today's cached Daily Business Advice, generating and storing it
 * on first request of the day (or when `forceRegenerate` is set - e.g. an
 * owner-triggered refresh, or a meaningfully changed condition later).
 */
async function getOrGenerateDailyBrief(tenantId, { branchId = null, forceRegenerate = false } = {}) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const dateKey = dateKeyAt(new Date(), tenant?.timezone);
  const dedupeKey = branchId ? `daily_brief:${dateKey}:${branchId}` : `daily_brief:${dateKey}`;

  if (!forceRegenerate) {
    const existing = await prisma.aiInsight.findUnique({ where: { tenantId_dedupeKey: { tenantId, dedupeKey } } });
    if (existing) return { insight: existing, brief: existing.evidence, cached: true };
  }

  const brief = await compileDailyBrief(tenantId, { branchId });
  const insight = await upsertInsight(tenantId, {
    branchId,
    type: 'BRIEF',
    category: 'daily_brief',
    severity: severityForBrief(brief),
    title: "Today's Business Advice",
    summary: brief.summaryText,
    evidence: brief,
    recommendedAction: brief.topActions[0]?.recommendedAction || null,
    scopeFrom: brief.period.from,
    scopeTo: brief.period.to,
    sourceType: 'Tenant',
    sourceId: tenantId,
    dedupeKey,
  });

  return { insight, brief, cached: false };
}

module.exports = { getOrGenerateDailyBrief, dateKeyAt };
