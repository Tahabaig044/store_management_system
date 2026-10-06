import { useState } from 'react';
import { useSyncStatus } from '../offline/useSyncStatus';
import { useLocalDataStatus, formatAge } from '../offline/useLocalDataStatus';
import { syncAll, OUTBOXES } from '../offline/syncEngine';
import Modal from './Modal';
import QueueEditModal from './QueueEditModal';
import { isEditableTable, editability } from '../offline/editing';
import { formatCurrency } from '../utils/currency';

function formatLastSync(ts) {
  if (!ts) return 'never';
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(ts).toLocaleString();
}

// Each entity's queued payload has a different shape - this renders a short,
// human-readable summary for the sync queue table.
function summarize(item) {
  const p = item.payload;
  switch (item.entityKey) {
    case 'sales':
    case 'purchases': {
      const total = p.items.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unitPrice ?? l.unitCost), 0);
      return `${p.items.length} item(s), ${formatCurrency(total)}`;
    }
    case 'expenses':
      return formatCurrency(p.amount);
    case 'payments':
      return formatCurrency(p.amount);
    case 'customers':
    case 'suppliers':
      return p.name;
    case 'opticalOrders':
      return formatCurrency(p.totalAmount || 0);
    case 'reversals':
      return `Invoice ${p.invoiceNumber}`;
    case 'warehouseStockMoves':
      return `${p.action} ${p.quantity}`;
    default:
      return '';
  }
}

// The one line that says how the queue is doing overall.
const STATE_LABEL = {
  synced: 'All synced',
  syncing: 'Syncing...',
  pending: 'pending',
  'offline-pending': 'pending - offline',
  conflict: 'conflict',
  failed: 'failed',
  blocked: 'waiting',
};
const STATE_TONE = { synced: 'secondary', syncing: 'info', pending: 'warning', 'offline-pending': 'warning', conflict: 'danger', failed: 'danger', blocked: 'warning' };

function StatusBadge({ item }) {
  if (item.status === 'conflict') return <span className="badge text-bg-danger">Conflict</span>;
  if (item.status === 'failed') return <span className="badge text-bg-danger">Failed</span>;
  if (item.status === 'blocked') return <span className="badge text-bg-warning">Waiting</span>;
  if (item.status === 'synced') return <span className="badge text-bg-success">Synced</span>;
  if (item.status === 'syncing') return <span className="badge text-bg-info">Syncing...</span>;
  if (item.nextAttemptAt && item.nextAttemptAt > Date.now()) return <span className="badge text-bg-warning">Retrying at {new Date(item.nextAttemptAt).toLocaleTimeString()}</span>;
  return <span className="badge text-bg-warning">Pending</span>;
}

export default function SyncStatusWidget({ tenantId, online }) {
  const { pendingCount, conflictCount, failedCount, blockedCount, lastSyncAt, items, state } = useSyncStatus(tenantId);
  const data = useLocalDataStatus(tenantId);
  const [showPanel, setShowPanel] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [editing, setEditing] = useState(null);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      await syncAll(tenantId);
    } finally {
      setSyncing(false);
    }
  }

  const hasQueue = items.some((i) => i.status !== 'synced') || items.length > 0;
  const needsAttention = conflictCount + failedCount;
  const parts = [];
  if (state === 'syncing') parts.push('Syncing...');
  else {
    if (pendingCount > 0) parts.push(`${pendingCount} pending`);
    if (conflictCount > 0) parts.push(`${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    if (blockedCount > 0) parts.push(`${blockedCount} waiting`);
    if (parts.length === 0) parts.push(STATE_LABEL.synced);
  }

  return (
    <>
      <div className="d-flex align-items-center gap-2">
        <span className={`status-pill ${online ? 'online' : 'offline'}`}>
          <span className="dot" />
          {online ? 'Online' : 'Offline'}
        </span>
        {data.everSynced && (
          <span
            className={`badge rounded-pill text-bg-${data.stockStale ? 'warning' : 'light'} text-body d-none d-sm-inline-flex`}
            title={data.stockStale ? 'Stock on this terminal may not reflect recent changes made elsewhere' : 'Local stock copy is current'}
            data-testid="stock-freshness"
          >
            {data.stockStale ? 'Stock may be out of date' : 'Stock'} - {formatAge(data.stockCheckedAt)}
          </span>
        )}
        {hasQueue && (
          <button
            type="button"
            className={`badge rounded-pill border-0 text-bg-${STATE_TONE[state] || 'secondary'}`}
            onClick={() => setShowPanel(true)}
            title="View sync queue"
            data-testid="sync-state"
            data-state={state}
          >
            {parts.join(' · ')}
          </button>
        )}
      </div>

      <Modal
        show={showPanel}
        title="Offline Sync Queue"
        onClose={() => setShowPanel(false)}
        size="lg"
        footer={
          <>
            <span className="text-body-secondary small me-auto">Last synced: {formatLastSync(lastSyncAt)}</span>
            <button className="btn btn-secondary" onClick={() => setShowPanel(false)}>
              Close
            </button>
            <button className="btn btn-primary" disabled={!online || syncing} onClick={handleSyncNow}>
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </>
        }
      >
        {!online && (
          <div className="alert alert-warning py-2">
            You're offline. Records created now are saved on this device and will sync automatically once you're back
            online. Nothing is lost if the browser is closed.
          </div>
        )}
        {needsAttention > 0 && (
          <div className="alert alert-danger py-2" role="alert">
            {needsAttention} transaction{needsAttention === 1 ? ' needs' : 's need'} your attention. They have NOT been applied on the server and are kept here until you retry or discard them.
          </div>
        )}
        {items.length === 0 && <p className="text-body-secondary">No queued records.</p>}
        {items.length > 0 && (
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>Type</th>
                <th>Happened</th>
                <th>Summary</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const actionable = item.status === 'conflict' || item.status === 'failed';
                const canEdit = isEditableTable(item.tableName) && ['pending', 'conflict', 'failed', 'blocked'].includes(item.status);
                const needsCheck = canEdit && editability(item.tableName, item).needsCheck;
                const happenedAt = item.payload?.occurredAt ? new Date(item.payload.occurredAt) : new Date(item.createdAt);
                return (
                  <tr key={`${item.entityKey}-${item.clientId}`} data-testid={`queue-row-${item.clientId}`}>
                    <td>{item.entityLabel}</td>
                    <td>{happenedAt.toLocaleTimeString()}</td>
                    <td>{summarize(item)}</td>
                    <td>
                      <StatusBadge item={item} />
                      {actionable && item.guidance && (
                        <div className="small mt-1" data-testid="conflict-detail">
                          <div className="fw-semibold text-danger">{item.guidance.title}</div>
                          <div className="text-danger">{item.guidance.detail}</div>
                          <div className="text-body-secondary">{item.guidance.advice}</div>
                        </div>
                      )}
                      {item.status === 'blocked' && (
                        <div className="small text-body-secondary mt-1" data-testid="blocked-detail">
                          Waiting for {item.blockedOn ? `${item.blockedOn.entityLabel} ${summarize(item.blockedOn)}` : 'another record'} - it needs attention first.
                        </div>
                      )}
                      {item.editedAt && <div className="small text-body-secondary mt-1">Edited {new Date(item.editedAt).toLocaleTimeString()}</div>}
                      {item.managerSeenAt && <div className="small text-body-secondary mt-1" data-testid="manager-seen">A manager has seen this{item.managerNote ? `: ${item.managerNote}` : ''}</div>}
                      {item.status === 'pending' && item.failure?.kind === 'SERVER_ERROR' && (
                        <div className="small text-body-secondary mt-1">
                          Server problem (attempt {item.attempts}) - retrying automatically.
                        </div>
                      )}
                    </td>
                    <td>
                      {(actionable || item.status === 'blocked' || canEdit) && (
                        <div className="d-flex gap-1">
                          {canEdit && (
                            <button className="btn btn-sm btn-outline-secondary" onClick={() => setEditing(item)}>
                              {needsCheck ? 'Check / Edit' : 'Edit'}
                            </button>
                          )}
                          {actionable && (
                            <button className="btn btn-sm btn-outline-primary" onClick={() => OUTBOXES[item.entityKey].retry(tenantId, item.clientId).catch((err) => console.warn('Retry failed:', err))}>
                              Retry
                            </button>
                          )}
                          {confirming === item.clientId ? (
                            <>
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={async () => {
                                  await OUTBOXES[item.entityKey].discard(tenantId, item.clientId);
                                  setConfirming(null);
                                }}
                              >
                                Yes, discard
                              </button>
                              <button className="btn btn-sm btn-outline-secondary" onClick={() => setConfirming(null)}>
                                Keep
                              </button>
                            </>
                          ) : (
                            <button className="btn btn-sm btn-outline-danger" onClick={() => setConfirming(item.clientId)}>
                              Discard
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Modal>
      {editing && <QueueEditModal key={`${editing.clientId}-${editing.editedAt || 0}`} show item={items.find((i) => i.clientId === editing.clientId) || editing} tenantId={tenantId} onClose={() => setEditing(null)} />}
    </>
  );
}
