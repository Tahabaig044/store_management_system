// Maps the existing AiInsight taxonomy down to the Phase 4 spec's 6 insight
// types (Performance/Anomaly/Risk/Opportunity/Trend/Recommendation) - a
// second, display-layer-only mapping over the *same* AiInsight rows Phase
// 3's alertMapping.js already maps to its own (Critical/Important/
// Informational, 7-category) vocabulary. Neither mapping changes what's
// stored; they're two different lenses over one shared table, exactly as
// Phase 3's completion criterion 10 ("ready for Phase 4 to consume the same
// business intelligence and alert signals") intended.
const SEVERITY_RANK = { URGENT: 0, ATTENTION: 1, OPPORTUNITY: 2, INFORMATION: 3 };

// - ANOMALY rows map 1:1.
// - BRIEF rows (the daily advice) are inherently a "what happened today"
//   performance summary.
// - RECOMMENDATION rows split by severity: URGENT is framed as a Risk
//   (prompt attention needed - matches the phase doc's own Risk examples:
//   low stock, overdue receivables, delayed jobs at their most severe);
//   OPPORTUNITY is framed as an Opportunity (the only recommendation
//   severity that's upside-framed today - slow-moving stock); ATTENTION
//   (the middle tier - worth reviewing soon, not urgent) is framed as a
//   plain Recommendation.
function mapInsightType(insight) {
  if (insight.type === 'ANOMALY') return 'ANOMALY';
  if (insight.type === 'BRIEF') return 'PERFORMANCE';
  if (insight.type === 'RECOMMENDATION') {
    if (insight.severity === 'OPPORTUNITY') return 'OPPORTUNITY';
    if (insight.severity === 'URGENT') return 'RISK';
    return 'RECOMMENDATION';
  }
  return 'RECOMMENDATION';
}

function toInsightDto(insight) {
  return {
    id: insight.id,
    insightType: mapInsightType(insight),
    severity: insight.severity,
    title: insight.title,
    summary: insight.summary,
    evidence: insight.evidence,
    recommendedAction: insight.recommendedAction,
    confidence: insight.confidence,
    scopeFrom: insight.scopeFrom,
    scopeTo: insight.scopeTo,
    status: insight.status,
    isRead: insight.status !== 'NEW',
    isDismissed: insight.status === 'DISMISSED',
    createdAt: insight.createdAt,
  };
}

/** A synthesized (non-persisted) Trend insight, shaped the same as a stored one so the UI can treat both uniformly. */
function trendToInsightDto(trend) {
  if (!trend) return null;
  return {
    id: null,
    insightType: 'TREND',
    severity: null,
    title: trend.title,
    summary: trend.summary,
    evidence: trend.evidence,
    recommendedAction: trend.recommendedAction,
    confidence: null,
    scopeFrom: null,
    scopeTo: null,
    status: null,
    isRead: true,
    isDismissed: false,
    createdAt: trend.generatedAt,
  };
}

module.exports = { SEVERITY_RANK, mapInsightType, toInsightDto, trendToInsightDto };
