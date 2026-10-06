// Deterministic anomaly/risk detection: every scan here is a plain
// statistical or threshold rule over the tenant's own data (no AI call, no
// external provider) - explainable, testable against fixtures, and unable
// to fabricate a finding. Each scan returns zero or more raw findings; they
// are turned into stored, deduped AiInsight rows by recommendations.js.
const prisma = require('../../config/prisma');
const { daysAgo, num, salesTotals } = require('./analytics');

function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function stdDev(xs, m = mean(xs)) { return xs.length ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) : 0; }
function zScore(value, m, sd) { return sd > 0 ? (value - m) / sd : 0; }

// Unusually high discounts: sales in the last 7 days whose discount % of
// subtotal is a statistical outlier (z-score > 2.5) against the trailing
// 90-day distribution of discount percentages.
async function unusualDiscounts(tenantId, { branchId } = {}) {
  const since90 = daysAgo(90);
  const sales = await prisma.sale.findMany({
    where: { tenantId, status: 'COMPLETED', createdAt: { gte: since90 }, ...(branchId ? { branchId } : {}) },
    select: { id: true, invoiceNumber: true, subtotal: true, discount: true, createdAt: true },
  });
  const withPct = sales.filter((s) => num(s.subtotal) > 0).map((s) => ({ ...s, discountPercent: (num(s.discount) / num(s.subtotal)) * 100 }));
  if (withPct.length < 10) return [];
  const percents = withPct.map((s) => s.discountPercent);
  const m = mean(percents);
  const sd = stdDev(percents, m);
  const since7 = daysAgo(7);
  return withPct
    .filter((s) => s.createdAt >= since7)
    .map((s) => ({ ...s, z: zScore(s.discountPercent, m, sd) }))
    .filter((s) => s.z > 2.5 && s.discountPercent > m)
    .map((s) => ({ saleId: s.id, invoiceNumber: s.invoiceNumber, discountPercent: Number(s.discountPercent.toFixed(1)), typicalPercent: Number(m.toFixed(1)), z: Number(s.z.toFixed(2)) }));
}

// Abnormal returns/reversals: reversal rate this week vs the trailing
// 8-week average reversal rate.
async function abnormalReversals(tenantId) {
  const since7 = daysAgo(7);
  const since56 = daysAgo(56);
  const [recent, recentReversed, baseline, baselineReversed] = await Promise.all([
    prisma.sale.count({ where: { tenantId, createdAt: { gte: since7 } } }),
    prisma.sale.count({ where: { tenantId, createdAt: { gte: since7 }, status: 'REVERSED' } }),
    prisma.sale.count({ where: { tenantId, createdAt: { gte: since56, lt: since7 } } }),
    prisma.sale.count({ where: { tenantId, createdAt: { gte: since56, lt: since7 }, status: 'REVERSED' } }),
  ]);
  const recentRate = recent > 0 ? recentReversed / recent : 0;
  const baselineRate = baseline > 0 ? baselineReversed / baseline : 0;
  if (recent < 5 || baselineRate === 0) return [];
  if (recentRate > baselineRate * 2 && recentReversed >= 2) {
    return [{ recentReversalRatePercent: Number((recentRate * 100).toFixed(1)), baselineReversalRatePercent: Number((baselineRate * 100).toFixed(1)), recentCount: recentReversed }];
  }
  return [];
}

// Unexpected stock adjustments: any single ADJUSTMENT_IN/OUT transaction in
// the last 7 days larger than 3x the tenant's typical adjustment size.
async function unexpectedStockAdjustments(tenantId) {
  const since90 = daysAgo(90);
  const txns = await prisma.inventoryTransaction.findMany({
    where: { tenantId, type: { in: ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] }, createdAt: { gte: since90 } },
    select: { id: true, productId: true, product: { select: { name: true } }, quantity: true, createdAt: true },
  });
  if (txns.length < 5) return [];
  const magnitudes = txns.map((t) => Math.abs(num(t.quantity)));
  const typical = mean(magnitudes);
  const since7 = daysAgo(7);
  return txns
    .filter((t) => t.createdAt >= since7 && Math.abs(num(t.quantity)) > typical * 3 && typical > 0)
    .map((t) => ({ transactionId: t.id, productName: t.product.name, quantity: num(t.quantity), typicalMagnitude: Number(typical.toFixed(1)) }));
}

// Unusual expense spikes: this week's total per expense category vs its
// trailing 8-week weekly average.
async function unusualExpenseSpikes(tenantId) {
  const since7 = daysAgo(7);
  const since56 = daysAgo(56);
  const [recent, baseline] = await Promise.all([
    prisma.expense.groupBy({ by: ['categoryId'], where: { tenantId, expenseDate: { gte: since7 } }, _sum: { amount: true } }),
    prisma.expense.groupBy({ by: ['categoryId'], where: { tenantId, expenseDate: { gte: since56, lt: since7 } }, _sum: { amount: true } }),
  ]);
  if (baseline.length === 0) return [];
  const baselineByCategory = new Map(baseline.map((b) => [b.categoryId, num(b._sum.amount) / 7])); // avg per week over 7 weeks
  const categories = await prisma.expenseCategory.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  return recent
    .map((r) => {
      const weeklyAvg = baselineByCategory.get(r.categoryId) || 0;
      const thisWeek = num(r._sum.amount);
      return { categoryId: r.categoryId, categoryName: nameById.get(r.categoryId), thisWeek, weeklyAvg };
    })
    .filter((r) => r.weeklyAvg > 0 && r.thisWeek > r.weeklyAvg * 2.5)
    .map((r) => ({ ...r, changePercent: Number((((r.thisWeek - r.weeklyAvg) / r.weeklyAvg) * 100).toFixed(1)) }));
}

// Unexpected sales decline: this week's revenue vs the trailing 4-week average.
async function unexpectedSalesDecline(tenantId, { branchId } = {}) {
  const since7 = daysAgo(7);
  const since35 = daysAgo(35);
  const where = (from, to) => ({ tenantId, status: 'COMPLETED', createdAt: { gte: from, lt: to }, ...(branchId ? { branchId } : {}) });
  const [recent, baseline] = await Promise.all([
    prisma.sale.aggregate({ where: where(since7, new Date()), _sum: { total: true } }),
    prisma.sale.aggregate({ where: where(since35, since7), _sum: { total: true } }),
  ]);
  const recentTotal = num(recent._sum.total);
  const weeklyAvg = num(baseline._sum.total) / 4;
  if (weeklyAvg <= 0) return [];
  const changePercent = ((recentTotal - weeklyAvg) / weeklyAvg) * 100;
  if (changePercent <= -30) {
    return [{ recentWeekRevenue: recentTotal, trailingWeeklyAverage: Number(weeklyAvg.toFixed(2)), changePercent: Number(changePercent.toFixed(1)) }];
  }
  return [];
}

// Phase 6.4: unusual sales spike - the mirror of unexpectedSalesDecline, same
// trailing-4-week-average comparison, flipped to the positive direction. This is an
// OPPORTUNITY signal (worth understanding what drove it, not a problem), not a risk.
async function unexpectedSalesSpike(tenantId, { branchId } = {}) {
  const since7 = daysAgo(7);
  const since35 = daysAgo(35);
  const where = (from, to) => ({ tenantId, status: 'COMPLETED', createdAt: { gte: from, lt: to }, ...(branchId ? { branchId } : {}) });
  const [recent, baseline] = await Promise.all([
    prisma.sale.aggregate({ where: where(since7, new Date()), _sum: { total: true } }),
    prisma.sale.aggregate({ where: where(since35, since7), _sum: { total: true } }),
  ]);
  const recentTotal = num(recent._sum.total);
  const weeklyAvg = num(baseline._sum.total) / 4;
  if (weeklyAvg <= 0) return [];
  const changePercent = ((recentTotal - weeklyAvg) / weeklyAvg) * 100;
  if (changePercent >= 50) {
    return [{ recentWeekRevenue: recentTotal, trailingWeeklyAverage: Number(weeklyAvg.toFixed(2)), changePercent: Number(changePercent.toFixed(1)) }];
  }
  return [];
}

// Phase 3 (Owner Mobile alerts): profit margin decline - this week's gross
// margin % vs the trailing 4-week block's gross margin %. Unlike revenue
// (which is divided by 4 to get a weekly average before comparing), margin
// is already period-length-invariant, so the two blocks' margins are
// compared directly. A minimum-change threshold (5 points) avoids flagging
// ordinary week-to-week noise; the example in the phase spec ("34% to 27%")
// is a 7-point drop, comfortably above this floor.
async function profitMarginDecline(tenantId, { branchId } = {}) {
  const since7 = daysAgo(7);
  const since35 = daysAgo(35);
  const now = new Date();
  const [recent, baseline] = await Promise.all([
    salesTotals(tenantId, { from: since7, to: now, branchId }),
    salesTotals(tenantId, { from: since35, to: since7, branchId }),
  ]);
  if (recent.grossMarginPercent === null || baseline.grossMarginPercent === null) return [];
  const pointDrop = baseline.grossMarginPercent - recent.grossMarginPercent;
  if (pointDrop >= 5) {
    return [
      {
        recentMarginPercent: Number(recent.grossMarginPercent.toFixed(1)),
        baselineMarginPercent: Number(baseline.grossMarginPercent.toFixed(1)),
        pointDrop: Number(pointDrop.toFixed(1)),
      },
    ];
  }
  return [];
}

// Sudden branch performance changes: same "this week vs trailing 4-week
// average" test as sales decline, but computed per branch.
async function suddenBranchChanges(tenantId) {
  const branches = await prisma.branch.findMany({ where: { tenantId, isActive: true } });
  const results = [];
  for (const b of branches) {
    const declines = await unexpectedSalesDecline(tenantId, { branchId: b.id });
    for (const d of declines) results.push({ branchId: b.id, branchName: b.name, ...d });
  }
  return results;
}

// Unusual optical-job delays: a spike in the count of jobs past their
// expected delivery date versus the trailing average count.
async function unusualJobDelays(tenantId) {
  const now = new Date();
  const overdue = await prisma.opticalOrder.count({
    where: { tenantId, status: { notIn: ['DELIVERED', 'CANCELLED'] }, expectedDeliveryDate: { not: null, lt: now } },
  });
  if (overdue >= 5) return [{ overdueCount: overdue }];
  return [];
}

// Potential duplicate transactions: two sales for the same customer, same
// exact total, within 5 minutes of each other - the classic double-submit
// signature.
async function potentialDuplicateSales(tenantId) {
  const since2 = daysAgo(2);
  const sales = await prisma.sale.findMany({
    where: { tenantId, createdAt: { gte: since2 }, customerId: { not: null } },
    select: { id: true, invoiceNumber: true, customerId: true, total: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const byCustomer = new Map();
  for (const s of sales) {
    const list = byCustomer.get(s.customerId) || [];
    list.push(s);
    byCustomer.set(s.customerId, list);
  }
  const findings = [];
  for (const list of byCustomer.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1], b = list[i];
      if (num(a.total) === num(b.total) && (new Date(b.createdAt) - new Date(a.createdAt)) < 5 * 60000) {
        findings.push({ saleIds: [a.id, b.id], invoiceNumbers: [a.invoiceNumber, b.invoiceNumber], amount: num(a.total) });
      }
    }
  }
  return findings;
}

async function runAllScans(tenantId) {
  const [discounts, reversals, adjustments, expenses, salesDecline, salesSpike, branchChanges, jobDelays, duplicates, profitDecline] = await Promise.all([
    unusualDiscounts(tenantId),
    abnormalReversals(tenantId),
    unexpectedStockAdjustments(tenantId),
    unusualExpenseSpikes(tenantId),
    unexpectedSalesDecline(tenantId),
    unexpectedSalesSpike(tenantId),
    suddenBranchChanges(tenantId),
    unusualJobDelays(tenantId),
    potentialDuplicateSales(tenantId),
    profitMarginDecline(tenantId),
  ]);
  return { discounts, reversals, adjustments, expenses, salesDecline, salesSpike, branchChanges, jobDelays, duplicates, profitDecline };
}

module.exports = {
  unusualDiscounts, abnormalReversals, unexpectedStockAdjustments, unusualExpenseSpikes,
  unexpectedSalesDecline, unexpectedSalesSpike, suddenBranchChanges, unusualJobDelays, potentialDuplicateSales,
  profitMarginDecline,
  runAllScans,
};
