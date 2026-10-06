// Turns the deterministic analytics/anomaly findings into stored,
// deduplicated AiInsight rows - the AI Recommendation Center's data. A
// re-run never creates a duplicate for the same underlying issue (the
// `dedupeKey` unique constraint) and never resets a status a user already
// set (acknowledged/dismissed) back to NEW - refreshing only updates the
// evidence on an existing row, which is what "store recommendation history
// so repeated noise can be reduced" means in practice.
const prisma = require('../../config/prisma');
const analytics = require('./analytics');
const anomaly = require('./anomaly');

async function upsertInsight(tenantId, { branchId = null, type, category, severity, title, summary, evidence, recommendedAction = null, confidence = null, scopeFrom = null, scopeTo = null, sourceType = null, sourceId = null, dedupeKey }) {
  const existing = await prisma.aiInsight.findUnique({ where: { tenantId_dedupeKey: { tenantId, dedupeKey } } });
  if (existing) {
    return prisma.aiInsight.update({
      where: { id: existing.id },
      data: { title, summary, evidence, recommendedAction, confidence, scopeFrom, scopeTo, severity },
    });
  }
  return prisma.aiInsight.create({
    data: { tenantId, branchId, type, category, severity, title, summary, evidence, recommendedAction, confidence, scopeFrom, scopeTo, sourceType, sourceId, dedupeKey },
  });
}

async function generateRiskRecommendations(tenantId) {
  const now = new Date();
  const [lowStock, overdue, slowMoving, delayedJobs, expiring, overduePayables, cash, overstock, priceChanges, delayedProcurement] = await Promise.all([
    analytics.lowStockRisk(tenantId, {}),
    analytics.receivablesAging(tenantId, { minDaysOverdue: 60 }),
    analytics.slowMovingStock(tenantId, {}),
    analytics.delayedOpticalJobs(tenantId, {}),
    analytics.expiryRisk(tenantId, { withinDays: 30 }),
    // Phase 6.4: the AP-side mirror of the receivables-overdue recommendation below.
    analytics.payablesSummary(tenantId, {}).then((rows) => rows.filter((r) => r.daysOutstanding >= 60)),
    analytics.cashSnapshot(tenantId),
    analytics.overstockRisk(tenantId, {}),
    // Phase 6.4: this was already computed by analytics.js (and used by the AI Assistant's
    // "which supplier prices increased" question) but never turned into a stored,
    // dedupe-tracked insight - closing that gap here.
    analytics.supplierPriceChanges(tenantId, {}),
    prisma.purchaseRequest.findMany({ where: { tenantId, status: 'PENDING_APPROVAL', createdAt: { lt: analytics.daysAgo(7) } }, select: { id: true, requestNumber: true, createdAt: true } }),
  ]);

  const created = [];
  for (const p of lowStock.slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'inventory',
      severity: p.daysOfStockRemaining !== null && p.daysOfStockRemaining <= 3 ? 'URGENT' : 'ATTENTION',
      title: `${p.name} may run out soon`,
      summary: p.daysOfStockRemaining !== null
        ? `Only ${p.daysOfStockRemaining} day(s) of stock remain at the current sales rate.`
        : `Stock (${p.stockQuantity}) is at or below the reorder threshold (${p.lowStockThreshold}).`,
      evidence: p,
      recommendedAction: p.suggestedReorderQuantity ? `Consider reordering approximately ${p.suggestedReorderQuantity} units.` : 'Review stock levels for this product.',
      sourceType: 'Product', sourceId: p.productId,
      dedupeKey: `low_stock:${p.productId}`,
    }));
  }

  for (const r of overdue.slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'receivables',
      severity: r.daysOverdue >= 90 ? 'URGENT' : 'ATTENTION',
      title: `${r.customerName} is ${r.daysOverdue} days overdue`,
      summary: `Invoice ${r.invoiceNumber} has an outstanding balance of ${r.amountDue.toFixed(2)}.`,
      evidence: r,
      recommendedAction: 'Consider sending a payment reminder or following up directly.',
      sourceType: 'Sale', sourceId: r.saleId,
      dedupeKey: `receivable_overdue:${r.saleId}`,
    }));
  }

  if (slowMoving.items.length > 0) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'inventory',
      severity: 'OPPORTUNITY',
      title: `${slowMoving.items.length} product(s) are slow-moving`,
      summary: `${slowMoving.totalCapitalTiedUp.toFixed(2)} in capital is tied up in stock that hasn't sold in ${slowMoving.windowDays}+ days.`,
      evidence: slowMoving,
      recommendedAction: 'Consider a promotion, bundle, or discount to move this stock.',
      sourceType: 'Tenant', sourceId: tenantId,
      dedupeKey: 'slow_moving_stock',
    }));
  }

  for (const j of delayedJobs.slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'optical',
      severity: j.daysOverdue >= 7 ? 'URGENT' : 'ATTENTION',
      title: `Optical order ${j.orderNumber} is overdue`,
      summary: `Expected delivery was ${j.daysOverdue} day(s) ago for ${j.customerName || 'this customer'}.`,
      evidence: j,
      recommendedAction: 'Follow up with the lab or customer on this job.',
      sourceType: 'OpticalOrder', sourceId: j.orderId,
      dedupeKey: `delayed_job:${j.orderId}`,
    }));
  }

  for (const p of expiring.slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'inventory',
      severity: p.daysUntilExpiry <= 7 ? 'URGENT' : 'ATTENTION',
      title: `${p.name} expires in ${p.daysUntilExpiry} day(s)`,
      summary: `${p.stockQuantity} unit(s) of batch ${p.batchNumber || 'N/A'} are still in stock.`,
      evidence: p,
      recommendedAction: 'Prioritize selling this batch or arrange a return/disposal.',
      sourceType: 'Product', sourceId: p.id,
      dedupeKey: `expiry:${p.id}`,
    }));
  }

  // Phase 6.4: overdue payables - the AP-side mirror of the overdue-receivables loop above.
  for (const p of overduePayables.slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'payables',
      severity: p.daysOutstanding >= 90 ? 'URGENT' : 'ATTENTION',
      title: `${p.supplierName || 'A supplier'} payment is ${p.daysOutstanding} days outstanding`,
      summary: `Purchase ${p.purchaseId} has an unpaid balance of ${p.amountDue.toFixed(2)}.`,
      evidence: p,
      recommendedAction: 'Review and schedule payment to avoid strained supplier relationships.',
      sourceType: 'Purchase', sourceId: p.purchaseId,
      dedupeKey: `payable_overdue:${p.purchaseId}`,
    }));
  }

  // Phase 6.4: cash-flow pressure - a simple, honestly-labeled deterministic signal
  // (payables currently exceed receivables), not a literal bank-balance check (that
  // lives in the accounting ledger, not this read-only analytics layer).
  if (cash.totalPayables > cash.totalReceivables && cash.totalPayables > 0) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'cash_flow',
      severity: cash.totalPayables > cash.totalReceivables * 1.5 ? 'URGENT' : 'ATTENTION',
      title: 'Payables currently exceed receivables',
      summary: `Outstanding payables (${cash.totalPayables.toFixed(2)}) are higher than outstanding receivables (${cash.totalReceivables.toFixed(2)}).`,
      evidence: cash,
      recommendedAction: 'Review upcoming supplier payments against expected customer collections.',
      sourceType: 'Tenant', sourceId: tenantId,
      dedupeKey: 'cash_flow_pressure',
    }));
  }

  // Phase 6.4: overstock - the inverse of the low-stock loop above.
  for (const p of overstock.slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'inventory',
      severity: 'OPPORTUNITY',
      title: `${p.name} may be overstocked`,
      summary: `At the current sales rate, this stock would last roughly ${p.daysOfStockRemaining} days - ${p.capitalTiedUp.toFixed(2)} in capital may be tied up longer than necessary.`,
      evidence: p,
      recommendedAction: 'Consider reducing future reorder quantities or running a promotion.',
      sourceType: 'Product', sourceId: p.productId,
      dedupeKey: `overstock:${p.productId}`,
    }));
  }

  // Phase 6.4: supplier price increases, stored as a proper insight (previously only
  // computed on-demand for the AI Assistant's "which supplier prices increased" answer).
  for (const s of priceChanges.filter((r) => r.changePercent > 0).slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'procurement',
      severity: s.changePercent >= 20 ? 'URGENT' : 'ATTENTION',
      title: `${s.supplierName}'s price for ${s.productName} increased`,
      summary: `Cost rose ${s.changePercent.toFixed(1)}% (from ${s.firstCost.toFixed(2)} to ${s.lastCost.toFixed(2)}) over the last 90 days.`,
      evidence: s,
      recommendedAction: 'Consider renegotiating or comparing quotes from alternative suppliers.',
      sourceType: 'Supplier', sourceId: s.supplierId,
      dedupeKey: `supplier_price_increase:${s.supplierId}:${s.productId}`,
    }));
  }

  // Phase 6.4: delayed procurement - a purchase request that's been waiting for
  // approval for over a week.
  for (const pr of delayedProcurement.slice(0, 10)) {
    created.push(await upsertInsight(tenantId, {
      type: 'RECOMMENDATION',
      category: 'procurement',
      severity: 'ATTENTION',
      title: `Purchase request ${pr.requestNumber} is awaiting approval`,
      summary: `This request has been pending approval for ${Math.floor((now - pr.createdAt) / 86400000)} day(s).`,
      evidence: pr,
      recommendedAction: 'Review and approve or reject this request to avoid procurement delays.',
      sourceType: 'PurchaseRequest', sourceId: pr.id,
      dedupeKey: `delayed_procurement:${pr.id}`,
    }));
  }

  return created;
}

const SEVERITY_BY_ANOMALY = { discounts: 'ATTENTION', reversals: 'ATTENTION', adjustments: 'ATTENTION', expenses: 'ATTENTION', salesDecline: 'URGENT', salesSpike: 'OPPORTUNITY', branchChanges: 'URGENT', jobDelays: 'ATTENTION', duplicates: 'URGENT' };
// Phase 3 (Owner Mobile alerts): a >=10-point margin drop is treated as
// urgent (severe profit deterioration); 5-9 points is worth reviewing soon.
function profitDeclineSeverity(pointDrop) {
  return pointDrop >= 10 ? 'URGENT' : 'ATTENTION';
}

async function generateAnomalyInsights(tenantId) {
  const scans = await anomaly.runAllScans(tenantId);
  const created = [];

  for (const d of scans.discounts) {
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'discount_anomaly', severity: SEVERITY_BY_ANOMALY.discounts,
      title: `Unusually high discount on invoice ${d.invoiceNumber}`,
      summary: `Discount of ${d.discountPercent}% is well above the typical ${d.typicalPercent}%.`,
      evidence: d, sourceType: 'Sale', sourceId: d.saleId, dedupeKey: `anomaly_discount:${d.saleId}`,
    }));
  }
  for (const r of scans.reversals) {
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'reversal_anomaly', severity: SEVERITY_BY_ANOMALY.reversals,
      title: 'Unusually high rate of sale reversals this week',
      summary: `${r.recentReversalRatePercent}% of sales were reversed this week, vs a typical ${r.baselineReversalRatePercent}%.`,
      evidence: r, sourceType: 'Tenant', sourceId: tenantId, dedupeKey: 'anomaly_reversals_weekly',
    }));
  }
  for (const a of scans.adjustments) {
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'stock_adjustment_anomaly', severity: SEVERITY_BY_ANOMALY.adjustments,
      title: `Large stock adjustment on ${a.productName}`,
      summary: `A quantity of ${a.quantity} is far larger than the typical adjustment size (${a.typicalMagnitude}).`,
      evidence: a, sourceType: 'InventoryTransaction', sourceId: a.transactionId, dedupeKey: `anomaly_adjustment:${a.transactionId}`,
    }));
  }
  for (const e of scans.expenses) {
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'expense_anomaly', severity: SEVERITY_BY_ANOMALY.expenses,
      title: `Unusual expense spike in ${e.categoryName}`,
      summary: `This week's spend (${e.thisWeek.toFixed(2)}) is ${e.changePercent}% above the typical weekly average (${e.weeklyAvg.toFixed(2)}).`,
      evidence: e, sourceType: 'ExpenseCategory', sourceId: e.categoryId, dedupeKey: `anomaly_expense:${e.categoryId}:weekly`,
    }));
  }
  if (scans.salesDecline.length > 0) {
    const s = scans.salesDecline[0];
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'sales_decline', severity: SEVERITY_BY_ANOMALY.salesDecline,
      title: 'Unexpected sales decline this week',
      summary: `Revenue (${s.recentWeekRevenue.toFixed(2)}) is ${Math.abs(s.changePercent)}% below the trailing weekly average (${s.trailingWeeklyAverage.toFixed(2)}).`,
      evidence: s, sourceType: 'Tenant', sourceId: tenantId, dedupeKey: 'anomaly_sales_decline_weekly',
    }));
  }
  if (scans.salesSpike.length > 0) {
    const s = scans.salesSpike[0];
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'sales_spike', severity: SEVERITY_BY_ANOMALY.salesSpike,
      title: 'Unusual sales spike this week',
      summary: `Revenue (${s.recentWeekRevenue.toFixed(2)}) is ${s.changePercent}% above the trailing weekly average (${s.trailingWeeklyAverage.toFixed(2)}).`,
      evidence: s, sourceType: 'Tenant', sourceId: tenantId, dedupeKey: 'anomaly_sales_spike_weekly',
    }));
  }
  for (const b of scans.branchChanges) {
    created.push(await upsertInsight(tenantId, {
      branchId: b.branchId,
      type: 'ANOMALY', category: 'branch_performance_anomaly', severity: SEVERITY_BY_ANOMALY.branchChanges,
      title: `Sudden performance drop at ${b.branchName}`,
      summary: `Revenue is ${Math.abs(b.changePercent)}% below its trailing weekly average.`,
      evidence: b, sourceType: 'Branch', sourceId: b.branchId, dedupeKey: `anomaly_branch:${b.branchId}:weekly`,
    }));
  }
  if (scans.jobDelays.length > 0) {
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'job_delay_anomaly', severity: SEVERITY_BY_ANOMALY.jobDelays,
      title: 'Elevated number of overdue optical jobs',
      summary: `${scans.jobDelays[0].overdueCount} jobs are currently past their expected delivery date.`,
      evidence: scans.jobDelays[0], sourceType: 'Tenant', sourceId: tenantId, dedupeKey: 'anomaly_job_delays',
    }));
  }
  if (scans.profitDecline.length > 0) {
    const p = scans.profitDecline[0];
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'profit_decline', severity: profitDeclineSeverity(p.pointDrop),
      title: 'Profit margin declining',
      summary: `Gross margin fell from ${p.baselineMarginPercent}% to ${p.recentMarginPercent}% this week.`,
      evidence: p, sourceType: 'Tenant', sourceId: tenantId, dedupeKey: 'anomaly_profit_decline_weekly',
    }));
  }
  for (const d of scans.duplicates) {
    created.push(await upsertInsight(tenantId, {
      type: 'ANOMALY', category: 'duplicate_transaction', severity: SEVERITY_BY_ANOMALY.duplicates,
      title: 'Potential duplicate sale detected',
      summary: `Two sales of ${d.amount.toFixed(2)} for the same customer were recorded within 5 minutes (${d.invoiceNumbers.join(', ')}).`,
      evidence: d, sourceType: 'Sale', sourceId: d.saleIds[1], dedupeKey: `anomaly_duplicate:${d.saleIds.join('_')}`,
    }));
  }

  return created;
}

async function refreshInsights(tenantId) {
  const [risk, anomalies] = await Promise.all([generateRiskRecommendations(tenantId), generateAnomalyInsights(tenantId)]);
  return { generated: risk.length + anomalies.length, risk: risk.length, anomalies: anomalies.length };
}

module.exports = { refreshInsights, generateRiskRecommendations, generateAnomalyInsights, upsertInsight };
