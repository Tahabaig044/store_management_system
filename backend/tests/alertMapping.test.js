// Pure unit tests for the AiInsight -> Owner Mobile alert mapping (Phase 3).
// No database needed - these are plain functions over plain objects.
const {
  mapPriority,
  mapCategory,
  deepLinkFor,
  preferenceFieldFor,
  toAlertDto,
  meetsMinimumPriority,
} = require('../src/modules/mobile/alertMapping');

describe('alertMapping', () => {
  it('maps AiInsightSeverity down to the 3-tier priority scheme', () => {
    expect(mapPriority('URGENT')).toBe('CRITICAL');
    expect(mapPriority('ATTENTION')).toBe('IMPORTANT');
    expect(mapPriority('OPPORTUNITY')).toBe('INFORMATIONAL');
    expect(mapPriority('INFORMATION')).toBe('INFORMATIONAL');
  });

  it('maps every known raw category to one of the 7 named alert categories', () => {
    expect(mapCategory('inventory')).toBe('INVENTORY');
    expect(mapCategory('receivables')).toBe('RECEIVABLES');
    expect(mapCategory('sales_decline')).toBe('SALES');
    expect(mapCategory('profit_decline')).toBe('PROFIT');
    expect(mapCategory('expense_anomaly')).toBe('EXPENSES');
    expect(mapCategory('discount_anomaly')).toBe('BUSINESS_ANOMALY');
    expect(mapCategory('branch_performance_anomaly')).toBe('PERFORMANCE');
  });

  it('falls back to PERFORMANCE for an unrecognized raw category', () => {
    expect(mapCategory('something_new')).toBe('PERFORMANCE');
  });

  it('deep-links a category with no dedicated Analytics section to Home, not a blank screen', () => {
    // Analytics only has Sales/Profit/Receivables/Inventory sections (Phase 2) -
    // Expenses and general anomalies only appear on Home's KPI cards.
    expect(deepLinkFor('EXPENSES')).toBe('home');
    expect(deepLinkFor('BUSINESS_ANOMALY')).toBe('home');
    expect(deepLinkFor('SALES')).toBe('analytics');
    expect(deepLinkFor('PROFIT')).toBe('analytics');
    expect(deepLinkFor('RECEIVABLES')).toBe('analytics');
    expect(deepLinkFor('INVENTORY')).toBe('analytics');
  });

  it('maps each category to the correct notification-preference field', () => {
    expect(preferenceFieldFor('SALES')).toBe('salesAlertsEnabled');
    expect(preferenceFieldFor('PROFIT')).toBe('profitAlertsEnabled');
    expect(preferenceFieldFor('RECEIVABLES')).toBe('receivableAlertsEnabled');
    expect(preferenceFieldFor('INVENTORY')).toBe('inventoryAlertsEnabled');
  });

  it('shapes an AiInsight row into the Alert Center contract', () => {
    const insight = {
      id: 'i1',
      category: 'inventory',
      severity: 'URGENT',
      title: 'Widget may run out soon',
      summary: 'Only 2 days of stock remain.',
      evidence: { productId: 'p1' },
      recommendedAction: 'Reorder now.',
      status: 'NEW',
      createdAt: new Date('2026-01-01'),
      acknowledgedAt: null,
      dismissedAt: null,
    };
    const dto = toAlertDto(insight);
    expect(dto).toMatchObject({
      id: 'i1', category: 'INVENTORY', priority: 'CRITICAL',
      title: insight.title, summary: insight.summary,
      isRead: false, isDismissed: false, deepLink: 'analytics',
    });
  });

  it('a DISMISSED insight is read and dismissed', () => {
    const dto = toAlertDto({ id: 'i1', category: 'inventory', severity: 'ATTENTION', title: 't', summary: 's', status: 'DISMISSED', createdAt: new Date() });
    expect(dto.isRead).toBe(true);
    expect(dto.isDismissed).toBe(true);
  });

  describe('meetsMinimumPriority', () => {
    it('ALL permits every priority', () => {
      expect(meetsMinimumPriority('CRITICAL', 'ALL')).toBe(true);
      expect(meetsMinimumPriority('INFORMATIONAL', 'ALL')).toBe(true);
    });

    it('CRITICAL_ONLY permits only CRITICAL', () => {
      expect(meetsMinimumPriority('CRITICAL', 'CRITICAL_ONLY')).toBe(true);
      expect(meetsMinimumPriority('IMPORTANT', 'CRITICAL_ONLY')).toBe(false);
      expect(meetsMinimumPriority('INFORMATIONAL', 'CRITICAL_ONLY')).toBe(false);
    });

    it('IMPORTANT_PLUS permits CRITICAL and IMPORTANT but not INFORMATIONAL', () => {
      expect(meetsMinimumPriority('CRITICAL', 'IMPORTANT_PLUS')).toBe(true);
      expect(meetsMinimumPriority('IMPORTANT', 'IMPORTANT_PLUS')).toBe(true);
      expect(meetsMinimumPriority('INFORMATIONAL', 'IMPORTANT_PLUS')).toBe(false);
    });
  });
});
