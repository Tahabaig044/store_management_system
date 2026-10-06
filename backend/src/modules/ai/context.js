// Natural-language business query intent matching + deterministic fact
// retrieval. Deliberately keyword/pattern-based rather than a call to an
// external LLM for *understanding* the question - the set of questions
// this Business Assistant must answer is bounded (Phase 9 section 5) and a
// small, auditable matcher means every question maps to an exact,
// explainable analytics function with no risk of the matcher itself
// fabricating data. The chosen intent's facts are then handed to the
// active AI provider only for *phrasing* the answer (see providers/).
const analytics = require('./analytics');

function startOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

// Default "this period" = month-to-date, which is what every example
// question in the phase document implicitly means ("this month's sales").
function defaultPeriod() {
  return { from: startOfMonth(), to: new Date() };
}

const INTENT_MATCHERS = [
  // Phase 6.3: broadened to also catch a plain "what were my sales [this month]?" -
  // not just an explicit "compare" phrasing. It still answers with the same
  // current-vs-previous-period comparison, which is a strict superset of "what were my
  // sales" (real current numbers plus honest context), never less informative.
  { intent: 'sales_comparison', test: (q) => /sales|revenue/.test(q) && (/compar/.test(q) || /(this month|this week|today|how much|what were)/.test(q)) },
  // Phase 6.3: broadened to also catch "which branch performed best?" - not just an
  // explicit "profit" phrasing.
  { intent: 'branch_profitability', test: (q) => /branch/.test(q) && (/profit/.test(q) || /(performed|performing|best)/.test(q)) },
  { intent: 'product_margin', test: (q) => /margin/.test(q) || (/product/.test(q) && /profit/.test(q)) },
  // Phase 6.3: "which products are selling fastest" - distinct from product_margin
  // (velocity, not profitability); ordered after product_margin so an explicit
  // margin/profit question is never shadowed by this broader one.
  { intent: 'top_selling_products', test: (q) => /product/.test(q) && /(sell|selling|fastest)/.test(q) },
  { intent: 'receivables_overdue', test: (q) => /overdue/.test(q) && (/customer|payment|receivable/.test(q)) },
  // Phase 6.3: "which customers owe us the most" - a balance question, not specifically
  // an overdue-aging one (ordered after receivables_overdue so an explicit "overdue"
  // question keeps its more specific 60+-day framing).
  { intent: 'top_debtors', test: (q) => /customer/.test(q) && /(owe|owing|balance)/.test(q) },
  { intent: 'low_stock_risk', test: (q) => /(run\s*out|low\s*stock|reorder)/.test(q) },
  { intent: 'slow_moving_stock', test: (q) => /slow.?moving/.test(q) || (/stock/.test(q) && /tied up/.test(q)) },
  { intent: 'profit_decline', test: (q) => /why/.test(q) && /profit/.test(q) },
  { intent: 'delayed_optical_jobs', test: (q) => /(optical|job)/.test(q) && /(pending|delay|overdue|late)/.test(q) },
  { intent: 'supplier_price_changes', test: (q) => /supplier/.test(q) && /(price|cost)/.test(q) },
  // Phase 6.3: "what are the biggest expense categories" - distinct from profit_decline
  // (a plain breakdown, not a "why did X happen" investigation).
  { intent: 'expense_breakdown', test: (q) => /expense/.test(q) && /(categor|biggest|breakdown)/.test(q) },
  { intent: 'daily_brief', test: (q) => /pay attention|today|brief|summary/.test(q) },
];

function matchIntent(question) {
  const q = (question || '').toLowerCase();
  for (const m of INTENT_MATCHERS) {
    if (m.test(q)) return m.intent;
  }
  return 'unrecognized';
}

// Every branch below only ever queries data already scoped to `tenantId`
// (and `branchId` when the caller supplied/is restricted to one) - there is
// no code path here that can read another tenant's rows, since every
// analytics.js function takes tenantId as its first, mandatory argument.
async function buildFacts(intent, { tenantId, branchId }) {
  const { from, to } = defaultPeriod();
  switch (intent) {
    case 'sales_comparison':
      return analytics.salesComparison(tenantId, { from, to, branchId });
    case 'branch_profitability':
      return { branches: await analytics.branchProfitability(tenantId, { from, to }) };
    case 'product_margin':
      return analytics.productMargins(tenantId, { from, to, branchId });
    case 'receivables_overdue': {
      const minDaysOverdue = 60;
      return { minDaysOverdue, rows: await analytics.receivablesAging(tenantId, { minDaysOverdue, branchId }) };
    }
    case 'low_stock_risk':
      return { rows: await analytics.lowStockRisk(tenantId, { branchId }) };
    case 'slow_moving_stock':
      return analytics.slowMovingStock(tenantId, { branchId });
    case 'profit_decline':
      return analytics.profitDeclineAnalysis(tenantId, { from, to, branchId });
    case 'delayed_optical_jobs':
      return { rows: await analytics.delayedOpticalJobs(tenantId, { branchId }) };
    case 'supplier_price_changes':
      return { rows: await analytics.supplierPriceChanges(tenantId, {}) };
    case 'top_selling_products':
      return analytics.productMargins(tenantId, { from, to, branchId });
    case 'top_debtors':
      return { rows: await analytics.topDebtors(tenantId, { branchId }) };
    case 'expense_breakdown':
      return { rows: await analytics.expenseBreakdown(tenantId, { from, to, branchId }) };
    case 'daily_brief': {
      const { compileDailyBrief } = require('./brief');
      const brief = await compileDailyBrief(tenantId, { branchId });
      return { summaryText: brief.summaryText, brief };
    }
    default:
      return { period: { from, to } };
  }
}

const SUGGESTED_QUESTIONS = [
  "Show me this month's sales compared with last month.",
  'Which branch is most profitable?',
  'Which products have the best gross margin?',
  'Which customers have overdue payments over 60 days?',
  'Which products may run out soon?',
  'What are my slow-moving products?',
  'Why did profit decline this month?',
  'Show me pending optical jobs older than the expected delivery date.',
  'Which supplier prices increased the most?',
  'What should I pay attention to today?',
  'Which products are selling fastest?',
  'Which customers owe us the most?',
  'What are the biggest expense categories?',
];

module.exports = { matchIntent, buildFacts, defaultPeriod, SUGGESTED_QUESTIONS };
