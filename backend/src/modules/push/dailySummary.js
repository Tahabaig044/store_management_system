// Daily push notification (Phase 3 spec section 5, Phase 4 spec section 9:
// "Phase 3 provides the notification infrastructure. Phase 4 supplies the
// intelligence behind the daily advice."). The title/body now come from the
// Phase 4 AI Advisor's cached Daily Business Advice (dailyBrief.js) - a
// real, evidence-based summary, not just a KPI readout - falling back to
// the plain Phase 2 dashboard figures only if brief generation ever fails,
// so a daily notification is still sent either way (never blocks the core
// "send something useful once a day" behavior on the AI layer working).
const prisma = require('../../config/prisma');
const dashboardService = require('../mobile/dashboardService');
const { getOrGenerateDailyBrief } = require('../ai/dailyBrief');
const { sendToUser, usersWithActiveDevices, getOrCreatePreference } = require('./pushService');

function dateKeyAndHourAt(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  };
}

function pct(value) {
  if (value === null || value === undefined) return null;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(0)}%`;
}

// Fallback composer - the pre-Phase-4 KPI-only summary, used only if the AI
// brief can't be generated for some reason.
function composeSummaryText(summary) {
  const parts = [];
  const salesPct = pct(summary.sales.today.changePercent);
  if (salesPct) parts.push(`Sales ${salesPct}`);
  parts.push(`Profit ${summary.profit.netProfit >= 0 ? '+' : ''}${summary.profit.netProfit.toFixed(0)}`);
  if (summary.receivables.totalOutstanding > 0) parts.push(`Receivables ${summary.receivables.totalOutstanding.toFixed(0)} outstanding`);
  if (summary.inventory.lowStockCount > 0) parts.push(`${summary.inventory.lowStockCount} low-stock item(s)`);

  const concerns = [
    { label: 'sales', severity: summary.sales.today.changePercent ?? 0 },
    { label: 'receivables', severity: summary.receivables.overdueAmount > 0 ? -100 : 0 },
    { label: 'inventory', severity: summary.inventory.lowStockCount > 0 ? -50 : 0 },
  ].sort((a, b) => a.severity - b.severity);
  const worst = concerns[0];
  const attentionLine = worst.severity < 0 ? `Your ${worst.label} require${worst.label === 'sales' ? 's' : ''} the most attention today.` : null;

  return [parts.join(' • '), attentionLine].filter(Boolean).join(' ');
}

async function composeDailyAdviceCopy(tenantId) {
  try {
    const { insight } = await getOrGenerateDailyBrief(tenantId, {});
    return { title: insight.title, body: insight.summary, deepLink: 'ai_advisor' };
  } catch (err) {
    console.error('[push] daily brief generation failed, falling back to KPI summary:', err.message);
    const summary = await dashboardService.getSummary(tenantId, { range: 'today' });
    return { title: 'Daily Business Summary', body: composeSummaryText(summary), deepLink: 'home' };
  }
}

// Sends the daily summary to every eligible owner device whose configured
// local time has arrived and who hasn't already received one today -
// enforces "once per day" (Phase 3 completion criterion 4 / Phase 4
// completion criterion 6) independent of how often this is invoked.
async function sendDailySummaryIfDue(tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const { dateKey, hour } = dateKeyAndHourAt(new Date(), tenant?.timezone);

  const userIds = await usersWithActiveDevices(tenantId);
  let sentCount = 0;
  let copy = null; // computed at most once per call, only if at least one user is actually due

  for (const userId of userIds) {
    const pref = await getOrCreatePreference(tenantId, userId);
    if (!pref.dailySummaryEnabled) continue;

    const configuredHour = Number((pref.dailySummaryTime || '08:00').split(':')[0]);
    if (configuredHour !== hour) continue;

    const lastSentDateKey = pref.lastDailySummarySentAt ? dateKeyAndHourAt(pref.lastDailySummarySentAt, tenant?.timezone).dateKey : null;
    if (lastSentDateKey === dateKey) continue;

    if (!copy) copy = await composeDailyAdviceCopy(tenantId);

    const results = await sendToUser(tenantId, userId, { title: copy.title, body: copy.body, data: { deepLink: copy.deepLink } });
    if (results.some((r) => r.status === 'SENT')) {
      sentCount += 1;
      await prisma.userNotificationPreference.update({ where: { id: pref.id }, data: { lastDailySummarySentAt: new Date() } });
    }
  }

  return { usersConsidered: userIds.length, sent: sentCount };
}

module.exports = { sendDailySummaryIfDue, composeSummaryText };
