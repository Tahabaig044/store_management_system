// Phase 3.3.4: the manager's view across every terminal - who holds unsent work, who has gone quiet while
// holding some, and which refused transactions nobody has looked at yet. Read-only apart from
// "Acknowledge" (a manager saying they have seen an issue); fixing a refused transaction is done on the
// terminal that holds it (Edit / Discard in its sync panel), because only that device has the entry.
import { useCallback, useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { describeFailure } from '../../offline/syncCore';

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
};

export default function SyncMonitor() {
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(0); // the moment of the last load, so ages are stable between renders

  const load = useCallback(() => {
    Promise.all([apiClient.get('/sync/terminals'), apiClient.get('/sync/issues')])
      .then(([t, i]) => {
        setNow(Date.now());
        setData(t.data);
        setIssues(i.data.items);
        setError('');
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function acknowledge(issue) {
    try {
      await apiClient.post(`/sync/issues/${issue.id}/acknowledge`, {});
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  if (loading) return <Spinner />;
  const s = data?.summary;
  return (
    <div>
      <h4 className="mb-1">Terminals &amp; Sync</h4>
      <p className="text-body-secondary small">Each device reports what it still holds unsent and what the server refused. This shows the state as of each terminal's last report.</p>
      <ErrorAlert message={error} />

      {s && (
        <div className="row g-2 mb-3" data-testid="sync-summary">
          {[['Terminals', s.terminals], ['Holding unsent work', s.withUnsyncedWork], ['Quiet with work', s.silentWithWork], ['Waiting to send', s.pending], ['Conflicts', s.conflicts], ['Failed', s.failed]].map(([label, value]) => (
            <div className="col-6 col-md-2" key={label}><div className="border rounded p-2"><div className="small text-body-secondary">{label}</div><div className="fs-5">{value}</div></div></div>
          ))}
        </div>
      )}

      <h6>Terminals</h6>
      {data?.items.length ? (
        <div className="table-responsive mb-4">
          <table className="table table-sm align-middle">
            <thead><tr><th>Terminal</th><th>Last user</th><th>Last heard</th><th>Waiting</th><th>Conflicts</th><th>Failed</th><th>Oldest waiting</th></tr></thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id} className={t.silent ? 'table-warning' : ''}>
                  <td>{t.label || t.terminalId.slice(0, 13)}{t.silent && <span className="badge text-bg-warning ms-2">Quiet with unsent work</span>}</td>
                  <td>{t.userName || '-'}</td>
                  <td>{ago(t.silentForMs)}</td>
                  <td>{t.pendingCount}</td>
                  <td>{t.conflictCount}</td>
                  <td>{t.failedCount}</td>
                  <td>{t.oldestPendingAt ? ago(now - new Date(t.oldestPendingAt).getTime()) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState message="No terminal has reported yet." />}

      <h6>Refused transactions</h6>
      {issues.length ? (
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead><tr><th>What</th><th>Terminal</th><th>Why</th><th>Reported</th><th /></tr></thead>
            <tbody>
              {issues.map((i) => {
                const g = describeFailure({ kind: i.kind, code: i.code, message: i.message });
                return (
                  <tr key={i.id}>
                    <td>{i.entity}</td>
                    <td>{i.terminal.label || i.terminal.terminalId.slice(0, 13)}<div className="small text-body-secondary">{i.terminal.userName}</div></td>
                    <td><div>{g.title}</div><div className="small text-body-secondary">{i.message}</div></td>
                    <td>{ago(now - new Date(i.lastReportedAt).getTime())}</td>
                    <td>{i.status === 'OPEN' ? <button className="btn btn-sm btn-outline-primary" onClick={() => acknowledge(i)}>Acknowledge</button> : <span className="badge text-bg-secondary">Seen</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <EmptyState message="Nothing is waiting for attention." />}
    </div>
  );
}
