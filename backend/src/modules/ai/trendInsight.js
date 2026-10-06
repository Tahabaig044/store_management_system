// Owner Mobile "Trend" insight (Phase 4's 6th insight type - "explain
// sustained increases/decreases rather than isolated daily changes").
// Reuses the existing, unmodified deterministic forecaster (forecast.js) -
// no new statistics are invented here. forecastSales() itself has no
// caching (every call creates a new AiForecast row, by design, for the
// existing on-demand "regenerate forecast" web feature) so this module adds
// its own once-per-day cache on top, exactly like dailyBrief.js, without
// touching forecast.js.
const prisma = require('../../config/prisma');
const { forecastSales } = require('./forecast');
const { dateKeyAt } = require('./dailyBrief');

const MIN_MEANINGFUL_CHANGE_PERCENT = 8;

function num(v) {
  return Number(v || 0);
}

async function getCachedOrFreshForecast(tenantId, { branchId }) {
  const scope = branchId ? 'BRANCH' : 'TENANT';
  const scopeId = branchId || null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const todayKey = dateKeyAt(new Date(), tenant?.timezone);

  const latest = await prisma.aiForecast.findFirst({
    where: { tenantId, scope, scopeId, granularity: 'DAILY' },
    orderBy: { generatedAt: 'desc' },
  });
  if (latest && dateKeyAt(latest.generatedAt, tenant?.timezone) === todayKey) {
    return {
      insufficientData: false,
      id: latest.id,
      scope: latest.scope,
      scopeId: latest.scopeId,
      granularity: latest.granularity,
      method: latest.method,
      dataPointsUsed: latest.dataPointsUsed,
      series: latest.series,
      generatedAt: latest.generatedAt,
      disclaimer: 'This forecast is a statistical estimate based on historical trends, not a guaranteed outcome.',
    };
  }

  return forecastSales(tenantId, { scope, scopeId, granularity: 'DAILY', horizon: 14 });
}

/**
 * A read-only, non-persisted "Trend" insight synthesized from the daily
 * sales forecast's own projected trajectory - never a new stored AiInsight
 * row (unlike the brief/anomaly/recommendation types), since AiForecast
 * already is this data's permanent home and history. Returns null when
 * there isn't enough history to forecast from at all, rather than
 * fabricating a trend.
 */
async function getTrendInsight(tenantId, { branchId = null } = {}) {
  const forecast = await getCachedOrFreshForecast(tenantId, { branchId });
  if (forecast.insufficientData) return null;

  const futurePoints = forecast.series.filter((p) => p.forecast !== null);
  if (futurePoints.length < 2) return null;

  const first = num(futurePoints[0].forecast);
  const last = num(futurePoints[futurePoints.length - 1].forecast);
  if (first <= 0) return null;

  const changePercent = ((last - first) / first) * 100;
  if (Math.abs(changePercent) < MIN_MEANINGFUL_CHANGE_PERCENT) return null;

  const direction = changePercent > 0 ? 'increasing' : 'decreasing';
  const horizonDays = futurePoints.length;

  return {
    type: 'TREND',
    title: `Sales trend: ${direction}`,
    summary: `Based on the last ${forecast.dataPointsUsed} day(s) of history, projected daily sales are ${direction} from ${first.toFixed(2)} to ${last.toFixed(2)} over the next ${horizonDays} days (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}%). ${forecast.disclaimer}`,
    evidence: {
      forecastId: forecast.id,
      dataPointsUsed: forecast.dataPointsUsed,
      method: forecast.method,
      firstProjected: first,
      lastProjected: last,
      changePercent: Number(changePercent.toFixed(1)),
      horizonDays,
    },
    recommendedAction: direction === 'decreasing'
      ? 'Review recent sales activity and consider whether a promotion or outreach is warranted.'
      : 'Review inventory and staffing readiness to support the projected increase.',
    generatedAt: forecast.generatedAt,
  };
}

module.exports = { getTrendInsight };
