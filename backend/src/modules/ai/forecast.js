// Deterministic sales forecasting: ordinary-least-squares linear trend +
// (for daily granularity) day-of-week seasonality, with a confidence band
// derived from the historical fit's own residual spread. No AI provider is
// involved in producing the numbers - forecasting is a well-understood
// statistical problem and the phase's own rules require financial/factual
// figures to stay deterministic. Every forecast is persisted as an
// `AiForecast` row so accuracy can later be checked against real outcomes
// (forecast-vs-actual reporting).
const prisma = require('../../config/prisma');
const { daysAgo, num } = require('./analytics');

const MIN_POINTS = { DAILY: 10, WEEKLY: 6, MONTHLY: 4 };
const HISTORY_DAYS = { DAILY: 90, WEEKLY: 182, MONTHLY: 365 };

function bucketKey(date, granularity) {
  const d = new Date(date);
  if (granularity === 'MONTHLY') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (granularity === 'WEEKLY') {
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}

function bucketDate(key, granularity) {
  if (granularity === 'MONTHLY') return new Date(`${key}-01T00:00:00.000Z`);
  if (granularity === 'WEEKLY') return new Date(key.split('-W')[0], 0, 1 + (Number(key.split('-W')[1]) - 1) * 7);
  return new Date(`${key}T00:00:00.000Z`);
}

function linearRegression(values) {
  const n = values.length;
  const xs = values.map((_, i) => i);
  const xMean = xs.reduce((s, x) => s + x, 0) / n;
  const yMean = values.reduce((s, y) => s + y, 0) / n;
  let num1 = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    num1 += (xs[i] - xMean) * (values[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num1 / den;
  const intercept = yMean - slope * xMean;
  const residuals = values.map((y, i) => y - (intercept + slope * i));
  const variance = residuals.reduce((s, r) => s + r ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  return { slope, intercept, stdDev };
}

// Average ratio of each weekday's value to the overall mean - only
// meaningful (and only applied) for DAILY granularity with enough history.
function weekdaySeasonality(points) {
  const overallMean = points.reduce((s, p) => s + p.value, 0) / points.length;
  if (overallMean === 0) return null;
  const byWeekday = new Map();
  for (const p of points) {
    const wd = p.date.getDay();
    const cur = byWeekday.get(wd) || { sum: 0, count: 0 };
    cur.sum += p.value;
    cur.count += 1;
    byWeekday.set(wd, cur);
  }
  const ratios = new Map();
  for (const [wd, { sum, count }] of byWeekday) {
    ratios.set(wd, (sum / count) / overallMean);
  }
  return ratios;
}

async function fetchHistoricalSeries(tenantId, { scope, scopeId, granularity }) {
  const since = daysAgo(HISTORY_DAYS[granularity]);
  const where = { tenantId, status: 'COMPLETED', createdAt: { gte: since } };
  if (scope === 'BRANCH' && scopeId) where.branchId = scopeId;

  let rows;
  if (scope === 'PRODUCT' || scope === 'CATEGORY') {
    const itemWhere = { sale: where };
    if (scope === 'PRODUCT') itemWhere.productId = scopeId;
    if (scope === 'CATEGORY') itemWhere.product = { categoryId: scopeId };
    rows = await prisma.saleItem.findMany({ where: itemWhere, select: { lineTotal: true, sale: { select: { createdAt: true } } } });
    rows = rows.map((r) => ({ createdAt: r.sale.createdAt, total: r.lineTotal }));
  } else {
    rows = await prisma.sale.findMany({ where, select: { createdAt: true, total: true } });
  }

  const byBucket = new Map();
  for (const r of rows) {
    const key = bucketKey(r.createdAt, granularity);
    byBucket.set(key, (byBucket.get(key) || 0) + num(r.total));
  }
  return byBucket;
}

// Fills gaps between the earliest and latest bucket with zero-value points
// - a day/week/month with no sales is a real data point (zero demand), not
// a missing one, and omitting it would silently overstate the trend.
function toDenseSeries(byBucket, granularity) {
  const keys = [...byBucket.keys()].sort();
  if (keys.length === 0) return [];
  const points = [];
  const cursor = bucketDate(keys[0], granularity);
  const end = bucketDate(keys[keys.length - 1], granularity);
  const step = granularity === 'MONTHLY' ? 'month' : granularity === 'WEEKLY' ? 'week' : 'day';
  while (cursor <= end) {
    const key = bucketKey(cursor, granularity);
    points.push({ date: new Date(cursor), value: byBucket.get(key) || 0 });
    if (step === 'month') cursor.setMonth(cursor.getMonth() + 1);
    else if (step === 'week') cursor.setDate(cursor.getDate() + 7);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return points;
}

function advanceDate(d, granularity) {
  const x = new Date(d);
  if (granularity === 'MONTHLY') x.setMonth(x.getMonth() + 1);
  else if (granularity === 'WEEKLY') x.setDate(x.getDate() + 7);
  else x.setDate(x.getDate() + 1);
  return x;
}

// Forecasts future sales for the given scope/granularity. Returns
// `{ insufficientData: true, reason, minPointsRequired, pointsAvailable }`
// rather than guessing when there isn't enough history - per the phase's
// explicit "gracefully handle insufficient or poor-quality data" requirement.
async function forecastSales(tenantId, { scope = 'TENANT', scopeId = null, granularity = 'DAILY', horizon = 14, generatedById = null } = {}) {
  const byBucket = await fetchHistoricalSeries(tenantId, { scope, scopeId, granularity });
  const points = toDenseSeries(byBucket, granularity);
  const minPoints = MIN_POINTS[granularity];

  if (points.length < minPoints) {
    return {
      insufficientData: true,
      reason: `Only ${points.length} historical data point(s) are available; at least ${minPoints} are needed for a ${granularity.toLowerCase()} forecast.`,
      minPointsRequired: minPoints,
      pointsAvailable: points.length,
    };
  }

  const values = points.map((p) => p.value);
  const { slope, intercept, stdDev } = linearRegression(values);
  const seasonality = granularity === 'DAILY' && points.length >= 21 ? weekdaySeasonality(points) : null;

  const series = points.map((p, i) => ({ date: p.date.toISOString(), actual: p.value, forecast: null, lowerBound: null, upperBound: null }));

  let cursorDate = advanceDate(points[points.length - 1].date, granularity);
  const marginOfError = 1.28 * stdDev; // ~80% interval under a normal-residual assumption
  for (let h = 0; h < horizon; h += 1) {
    const idx = points.length + h;
    let forecast = intercept + slope * idx;
    if (seasonality) {
      const ratio = seasonality.get(cursorDate.getDay());
      if (ratio) forecast *= ratio;
    }
    forecast = Math.max(forecast, 0);
    series.push({
      date: cursorDate.toISOString(),
      actual: null,
      forecast: Number(forecast.toFixed(2)),
      lowerBound: Number(Math.max(forecast - marginOfError, 0).toFixed(2)),
      upperBound: Number((forecast + marginOfError).toFixed(2)),
    });
    cursorDate = advanceDate(cursorDate, granularity);
  }

  const forecastRow = await prisma.aiForecast.create({
    data: {
      tenantId,
      scope,
      scopeId,
      granularity,
      method: seasonality ? 'linear_trend_with_weekday_seasonality' : 'linear_trend',
      dataPointsUsed: points.length,
      series,
      generatedById,
    },
  });

  return {
    insufficientData: false,
    id: forecastRow.id,
    scope,
    scopeId,
    granularity,
    method: forecastRow.method,
    dataPointsUsed: points.length,
    series,
    generatedAt: forecastRow.generatedAt,
    disclaimer: 'This forecast is a statistical estimate based on historical trends, not a guaranteed outcome.',
  };
}

module.exports = { forecastSales, linearRegression, MIN_POINTS };
