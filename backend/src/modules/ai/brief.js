// Compiles the Daily Business Brief: deterministic metrics plus a plain-
// language summary. This refreshes the Recommendation Center's stored
// insights (a handful of aggregate queries, not a hot transactional path)
// so "today's top 3 recommended actions" always reflects current data.
const prisma = require('../../config/prisma');
const analytics = require('./analytics');
const { refreshInsights } = require('./recommendations');

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

const SEVERITY_RANK = { URGENT: 0, ATTENTION: 1, OPPORTUNITY: 2, INFORMATION: 3 };

async function compileDailyBrief(tenantId, { branchId } = {}) {
  const today = { from: startOfDay(), to: endOfDay() };

  await refreshInsights(tenantId);

  const [salesToday, cash, lowStock, expiring, delayedJobs, appointmentsToday, pendingPurchaseRequests, pendingPurchaseOrders, topInsights, profitTrend] = await Promise.all([
    analytics.salesComparison(tenantId, { ...today, branchId }),
    analytics.cashSnapshot(tenantId),
    analytics.lowStockRisk(tenantId, { branchId }),
    analytics.expiryRisk(tenantId, { branchId, withinDays: 30 }),
    analytics.delayedOpticalJobs(tenantId, { branchId }),
    prisma.appointment.count({ where: { tenantId, scheduledAt: { gte: today.from, lte: today.to }, ...(branchId ? { branchId } : {}) } }),
    prisma.purchaseRequest.count({ where: { tenantId, status: 'PENDING_APPROVAL' } }),
    prisma.purchaseOrder.count({ where: { tenantId, status: 'PENDING_APPROVAL' } }),
    prisma.aiInsight.findMany({ where: { tenantId, status: 'NEW' }, orderBy: { createdAt: 'desc' }, take: 50 }),
    analytics.profitDeclineAnalysis(tenantId, { from: today.from, to: today.to, branchId }),
  ]);

  const topActions = topInsights
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 3)
    .map((i) => ({ id: i.id, title: i.title, severity: i.severity, recommendedAction: i.recommendedAction }));

  const unusualActivityCount = topInsights.filter((i) => i.type === 'ANOMALY').length;

  const parts = [];
  parts.push(salesToday.current.saleCount > 0
    ? `Today's sales: ${salesToday.current.revenue.toFixed(2)} across ${salesToday.current.saleCount} sale(s).`
    : 'No sales recorded yet today.');
  if (cash.totalReceivables > 0) parts.push(`Outstanding receivables: ${cash.totalReceivables.toFixed(2)}.`);
  if (lowStock.length > 0) parts.push(`${lowStock.length} product(s) are at risk of running out.`);
  if (expiring.length > 0) parts.push(`${expiring.length} product(s) are expiring within 30 days.`);
  if (delayedJobs.length > 0) parts.push(`${delayedJobs.length} optical job(s) are overdue.`);
  if (unusualActivityCount > 0) parts.push(`${unusualActivityCount} unusual pattern(s) were detected.`);
  if (topActions.length > 0) parts.push(`Top priority: ${topActions[0].title}.`);

  // Phase 6.4: the management summary's five required elements, made explicit and
  // separately labeled rather than left implicit in summaryText - every field here
  // points back at data already computed above, nothing new is calculated for it.
  const managementSummary = {
    whatHappened: salesToday.current.saleCount > 0
      ? `${salesToday.current.saleCount} sale(s) totaling ${salesToday.current.revenue.toFixed(2)} recorded today.`
      : 'No sales recorded yet today.',
    whatChanged: salesToday.changePercent === null
      ? 'Not enough data in the prior period to compare.'
      : `Sales are ${salesToday.changePercent >= 0 ? 'up' : 'down'} ${Math.abs(salesToday.changePercent).toFixed(1)}% vs the same period yesterday; net profit ${profitTrend.netProfit.change >= 0 ? 'improved' : 'declined'} by ${Math.abs(profitTrend.netProfit.change).toFixed(2)}.`,
    whyItMatters: topActions.length > 0
      ? `${topActions.length} item(s) need attention, the highest priority being: ${topActions[0].title}.`
      : unusualActivityCount > 0
        ? `${unusualActivityCount} unusual pattern(s) were detected and should be reviewed.`
        : 'No urgent items were found today.',
    whatToReview: topActions.map((a) => a.title),
    supportingFigures: { salesToday, cash, lowStockCount: lowStock.length, expiringCount: expiring.length, delayedJobsCount: delayedJobs.length, unusualActivityCount },
  };

  return {
    generatedAt: new Date(),
    period: today,
    salesPerformance: salesToday,
    cash,
    inventoryRisks: { lowStockCount: lowStock.length, items: lowStock.slice(0, 10) },
    expiryRisks: { count: expiring.length, items: expiring.slice(0, 10) },
    delayedOpticalJobs: { count: delayedJobs.length, items: delayedJobs.slice(0, 10) },
    appointmentsToday,
    pendingApprovals: { purchaseRequests: pendingPurchaseRequests, purchaseOrders: pendingPurchaseOrders },
    unusualActivityCount,
    topActions,
    summaryText: parts.join(' '),
    managementSummary,
    links: {
      sales: '/sales-history',
      inventory: '/products',
      receivables: '/reports',
      opticalOrders: '/optical-orders',
      procurement: '/procurement',
      recommendations: '/ai/recommendations',
    },
  };
}

module.exports = { compileDailyBrief };
