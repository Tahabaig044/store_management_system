// Owner Mobile push delivery (Phase 3). Mirrors modules/communication/queue.js's
// getConfig()-then-dispatch shape, but is intentionally much simpler: there
// is no send queue/retry table here (mock delivery is synchronous and
// always resolves immediately) - see the Phase 3 final report for why this
// is an acceptable scope boundary for a mock-provider-only phase.
const prisma = require('../../config/prisma');
const { getProvider } = require('./providers/provider');
const { toAlertDto, preferenceFieldFor, meetsMinimumPriority } = require('../mobile/alertMapping');

async function getPushConfig(tenantId) {
  const existing = await prisma.pushConfig.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.pushConfig.create({ data: { tenantId } });
}

async function getOrCreatePreference(tenantId, userId) {
  const existing = await prisma.userNotificationPreference.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.userNotificationPreference.create({ data: { tenantId, userId } });
}

// Sends one notification to every active device the user has registered.
// Never throws - an unreachable/invalid device token is a normal delivery
// outcome, not an application error (same contract as the WhatsApp provider).
async function sendToUser(tenantId, userId, { title, body, data = {} }) {
  const config = await getPushConfig(tenantId);
  if (!config.isEnabled) return [];

  const tokens = await prisma.deviceToken.findMany({ where: { tenantId, userId, isActive: true } });
  if (tokens.length === 0) return [];

  const provider = getProvider(config.provider);
  const results = [];
  for (const t of tokens) {
    let outcome;
    try {
      outcome = await provider.send({ deviceToken: t.token, title, body, data });
    } catch (err) {
      outcome = { status: 'FAILED', providerMessageId: null, failureReason: err.message || 'Unknown provider error' };
    }
    results.push({ deviceTokenId: t.id, ...outcome });
    if (outcome.status === 'FAILED' && !outcome.notConfigured) {
      // A token that the provider can no longer deliver to (uninstalled app,
      // revoked permission) is deactivated rather than deleted, preserving
      // its history - the app re-registers a fresh token on next launch.
      await prisma.deviceToken.update({ where: { id: t.id }, data: { isActive: false } }).catch(() => {});
    }
  }
  return results;
}

// Users eligible to receive Owner Mobile push at all - i.e. anyone who has
// registered at least one active device.
async function usersWithActiveDevices(tenantId) {
  const rows = await prisma.deviceToken.findMany({
    where: { tenantId, isActive: true },
    select: { userId: true },
    distinct: ['userId'],
  });
  return rows.map((r) => r.userId);
}

// Insights that haven't been pushed yet, or whose severity has escalated
// since the last push - the "don't repeat the same unresolved condition"
// rule from the phase spec, implemented via AiInsight.notifiedAt/
// notifiedSeverity (see schema.prisma). Dismissed insights are excluded -
// the owner has already seen and closed them.
async function findInsightsNeedingPush(tenantId) {
  const rows = await prisma.aiInsight.findMany({
    // BRIEF-type rows (the Daily Business Advice) are excluded here - they
    // already have their own dedicated once-per-day push path
    // (sendDailySummaryIfDue, below), and were never meant to also flow
    // through the generic per-condition alert pipeline. Without this, a
    // scheduled run any time after a brief was generated (but before the
    // owner's configured summary hour, or on a later run the same day)
    // would re-send it a second time as a generic "Business Alert" push -
    // matches the same ANOMALY/RECOMMENDATION-only convention already used
    // by the AI Advisor's own "needs attention" query.
    where: { tenantId, status: { in: ['NEW', 'ACKNOWLEDGED'] }, type: { in: ['ANOMALY', 'RECOMMENDATION'] } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.filter((r) => r.notifiedAt === null || r.notifiedSeverity !== r.severity);
}

const CATEGORY_LABEL = {
  SALES: 'Sales Alert',
  PROFIT: 'Profit Margin Alert',
  RECEIVABLES: 'Receivables Alert',
  INVENTORY: 'Inventory Alert',
  EXPENSES: 'Expense Alert',
  BUSINESS_ANOMALY: 'Business Anomaly',
  PERFORMANCE: 'Performance Alert',
};

const REVIEW_PROMPT_BY_CATEGORY = {
  SALES: 'Tap to review sales performance.',
  PROFIT: 'Tap to review profit performance.',
  RECEIVABLES: 'Tap to review receivables.',
  INVENTORY: 'Tap to review inventory.',
  EXPENSES: 'Tap to review expenses.',
  BUSINESS_ANOMALY: 'Tap to review.',
  PERFORMANCE: 'Tap to review performance.',
};

// Matches the phase spec's own example exactly in shape: "<key fact>. Tap to
// review <area> performance." - the key fact is always insight.summary,
// already a fact-plus-why-it-matters sentence (see recommendations.js).
function alertPushCopy(alert) {
  const prompt = REVIEW_PROMPT_BY_CATEGORY[alert.category] || 'Tap to review.';
  return { title: CATEGORY_LABEL[alert.category] || 'Business Alert', body: `${alert.summary} ${prompt}` };
}

// Runs the "Notification Service" step of the alert pipeline for one
// tenant: finds insights that need a fresh push, checks each eligible
// owner's preferences, sends, then marks the insight as notified so a
// re-run never repeats it for the same severity.
async function dispatchAlertPush(tenantId) {
  const [userIds, insights] = await Promise.all([usersWithActiveDevices(tenantId), findInsightsNeedingPush(tenantId)]);
  if (userIds.length === 0 || insights.length === 0) return { usersConsidered: userIds.length, insightsConsidered: insights.length, sent: 0 };

  const preferences = new Map(await Promise.all(userIds.map(async (id) => [id, await getOrCreatePreference(tenantId, id)])));

  let sentCount = 0;
  for (const insight of insights) {
    const alert = toAlertDto(insight);
    const categoryField = preferenceFieldFor(alert.category);
    let notifiedAnyone = false;

    for (const userId of userIds) {
      const pref = preferences.get(userId);
      if (!pref[categoryField]) continue;
      if (!meetsMinimumPriority(alert.priority, pref.minimumPriority)) continue;

      const { title, body } = alertPushCopy(alert);
      const results = await sendToUser(tenantId, userId, { title, body, data: { alertId: insight.id, deepLink: alert.deepLink } });
      if (results.some((r) => r.status === 'SENT')) {
        notifiedAnyone = true;
        sentCount += 1;
      }
    }

    if (notifiedAnyone) {
      await prisma.aiInsight.update({ where: { id: insight.id }, data: { notifiedAt: new Date(), notifiedSeverity: insight.severity } });
    }
  }

  return { usersConsidered: userIds.length, insightsConsidered: insights.length, sent: sentCount };
}

module.exports = { getPushConfig, getOrCreatePreference, sendToUser, usersWithActiveDevices, findInsightsNeedingPush, dispatchAlertPush };
