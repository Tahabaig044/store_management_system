import { useLocalDataStatus, formatAge } from '../offline/useLocalDataStatus';

// Shown where stock quantities drive a decision (POS, purchasing): silent while the local stock copy
// is current, otherwise says how old it is and what that means. Reads only local state - never the
// network - so it can be shown offline.
export default function StockFreshnessNotice({ tenantId }) {
  const { everSynced, stockStale, stockCheckedAt, online } = useLocalDataStatus(tenantId);
  if (!tenantId || !everSynced || !stockStale) return null;
  return (
    <div className="alert alert-warning py-2 small mb-3" role="status" data-testid="stock-stale-notice">
      {online
        ? `Stock figures were last confirmed ${formatAge(stockCheckedAt)} and are being refreshed.`
        : `You are offline. Stock was last confirmed ${formatAge(stockCheckedAt)}; sales made now are checked against the server when you reconnect, and quantities may not include changes made elsewhere since.`}
    </div>
  );
}
