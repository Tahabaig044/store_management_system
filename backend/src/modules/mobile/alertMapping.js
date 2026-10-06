// Maps the existing AiInsight taxonomy (AiInsightSeverity, free-text
// category) down to the Phase 3 Owner Mobile spec's own vocabulary
// (3-tier priority, 7 named alert categories, a deep-link target). This is
// a pure display-layer mapping - it never changes what's stored on the
// AiInsight row, so the existing web AI Recommendation Center is completely
// unaffected by Phase 3.
const PRIORITY_BY_SEVERITY = {
  URGENT: 'CRITICAL',
  ATTENTION: 'IMPORTANT',
  OPPORTUNITY: 'INFORMATIONAL',
  INFORMATION: 'INFORMATIONAL',
};

// Priority rank, low number = higher priority - used both for sorting and
// for the "minimum priority" preference check (a CRITICAL_ONLY owner only
// wants rank 0).
const PRIORITY_RANK = { CRITICAL: 0, IMPORTANT: 1, INFORMATIONAL: 2 };

const CATEGORY_BY_RAW = {
  inventory: 'INVENTORY',
  receivables: 'RECEIVABLES',
  optical: 'PERFORMANCE',
  discount_anomaly: 'BUSINESS_ANOMALY',
  reversal_anomaly: 'BUSINESS_ANOMALY',
  stock_adjustment_anomaly: 'BUSINESS_ANOMALY',
  duplicate_transaction: 'BUSINESS_ANOMALY',
  expense_anomaly: 'EXPENSES',
  sales_decline: 'SALES',
  branch_performance_anomaly: 'PERFORMANCE',
  job_delay_anomaly: 'PERFORMANCE',
  profit_decline: 'PROFIT',
};

// Which mobile screen a tap on this alert category should open. The Phase 2
// Analytics tab shows Sales/Profit/Receivables/Inventory (with branch/staff
// breakdowns) together on one scrollable screen, so those categories
// deep-link there; Expenses and general Business Anomaly findings have no
// dedicated Analytics section (only compact KPI cards on Home), so those
// deep-link to Home instead - deep-linking to a screen with no relevant
// content would be worse than the Home summary that actually shows the
// figure. Only a screen-level target is given (not a scroll-to-section
// anchor).
const DEEP_LINK_BY_CATEGORY = {
  SALES: 'analytics',
  PROFIT: 'analytics',
  RECEIVABLES: 'analytics',
  INVENTORY: 'analytics',
  EXPENSES: 'home',
  BUSINESS_ANOMALY: 'home',
  PERFORMANCE: 'analytics',
};

// Which UserNotificationPreference boolean gates this category.
const PREFERENCE_FIELD_BY_CATEGORY = {
  SALES: 'salesAlertsEnabled',
  PROFIT: 'profitAlertsEnabled',
  RECEIVABLES: 'receivableAlertsEnabled',
  INVENTORY: 'inventoryAlertsEnabled',
  EXPENSES: 'expenseAnomalyAlertsEnabled',
  BUSINESS_ANOMALY: 'expenseAnomalyAlertsEnabled',
  PERFORMANCE: 'expenseAnomalyAlertsEnabled',
};

function mapPriority(severity) {
  return PRIORITY_BY_SEVERITY[severity] || 'INFORMATIONAL';
}

function mapCategory(rawCategory) {
  return CATEGORY_BY_RAW[rawCategory] || 'PERFORMANCE';
}

function deepLinkFor(category) {
  return DEEP_LINK_BY_CATEGORY[category] || 'analytics';
}

function preferenceFieldFor(category) {
  return PREFERENCE_FIELD_BY_CATEGORY[category] || 'expenseAnomalyAlertsEnabled';
}

// Shapes one AiInsight row into the Owner Mobile Alert Center's contract.
function toAlertDto(insight) {
  const priority = mapPriority(insight.severity);
  const category = mapCategory(insight.category);
  return {
    id: insight.id,
    category,
    priority,
    title: insight.title,
    summary: insight.summary,
    evidence: insight.evidence,
    recommendedAction: insight.recommendedAction,
    isRead: insight.status !== 'NEW',
    isDismissed: insight.status === 'DISMISSED',
    createdAt: insight.createdAt,
    acknowledgedAt: insight.acknowledgedAt,
    dismissedAt: insight.dismissedAt,
    deepLink: deepLinkFor(category),
  };
}

function meetsMinimumPriority(priority, minimumPriority) {
  if (minimumPriority === 'ALL') return true;
  if (minimumPriority === 'CRITICAL_ONLY') return priority === 'CRITICAL';
  if (minimumPriority === 'IMPORTANT_PLUS') return PRIORITY_RANK[priority] <= PRIORITY_RANK.IMPORTANT;
  return true;
}

module.exports = {
  PRIORITY_RANK,
  mapPriority,
  mapCategory,
  deepLinkFor,
  preferenceFieldFor,
  toAlertDto,
  meetsMinimumPriority,
};
