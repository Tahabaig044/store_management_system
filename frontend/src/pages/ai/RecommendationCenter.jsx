import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';

const SEVERITY_BADGE = { URGENT: 'danger', ATTENTION: 'warning', OPPORTUNITY: 'info', INFORMATION: 'secondary' };
const SEVERITY_LABEL = { URGENT: 'Urgent - may prevent a loss', ATTENTION: 'Attention - meaningful issue', OPPORTUNITY: 'Opportunity', INFORMATION: 'Information' };

export default function RecommendationCenter() {
  const [items, setItems] = useState([]);
  const [filters, setFilters] = useState({ status: 'NEW', type: '', severity: '' });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    apiClient.get('/ai/insights', { params }).then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, [filters.status, filters.type, filters.severity]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      await apiClient.post('/ai/insights/refresh');
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function act(id, action) {
    setError('');
    try {
      await apiClient.post(`/ai/insights/${id}/${action}`);
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  async function sendFeedback(id, helpful) {
    try {
      await apiClient.post(`/ai/insights/${id}/feedback`, { helpful });
    } catch {
      // Feedback is best-effort and never blocks the main recommendation workflow.
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h4 className="mb-1">AI Recommendation Center</h4>
          <p className="text-body-secondary small mb-0">
            AI-generated recommendations and anomaly alerts, each with the evidence behind it. Nothing here changes
            your data automatically - review and act on what's relevant.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh Insights'}</button>
      </div>

      <div className="d-flex gap-2 mb-3 flex-wrap">
        <select className="form-select form-select-sm w-auto" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="NEW">New</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="DISMISSED">Dismissed</option>
        </select>
        <select className="form-select form-select-sm w-auto" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="">All types</option>
          <option value="RECOMMENDATION">Recommendation</option>
          <option value="ANOMALY">Anomaly</option>
        </select>
        <select className="form-select form-select-sm w-auto" value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value })}>
          <option value="">All severities</option>
          {Object.keys(SEVERITY_BADGE).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No insights match these filters." /> : (
        <div className="d-flex flex-column gap-2">
          {items.map((i) => (
            <div key={i.id} className="card p-3">
              <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
                <div>
                  <span className={`badge text-bg-${SEVERITY_BADGE[i.severity]} me-2`} title={SEVERITY_LABEL[i.severity]}>{i.severity}</span>
                  <span className="badge text-bg-light border me-2">{i.type}</span>
                  <strong>{i.title}</strong>
                  <div className="small text-body-secondary mt-1">{i.summary}</div>
                  {i.recommendedAction && <div className="small mt-1"><strong>Recommended:</strong> {i.recommendedAction}</div>}
                  <details className="small mt-1">
                    <summary className="text-body-secondary" style={{ cursor: 'pointer' }}>Evidence</summary>
                    <pre className="mb-0 mt-1" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(i.evidence, null, 2)}</pre>
                  </details>
                </div>
                <div className="d-flex flex-column gap-1" style={{ minWidth: 160 }}>
                  {i.status === 'NEW' && (
                    <>
                      <button className="btn btn-sm btn-outline-secondary" onClick={() => act(i.id, 'acknowledge')}>Acknowledge</button>
                      <button className="btn btn-sm btn-outline-danger" onClick={() => act(i.id, 'dismiss')}>Dismiss</button>
                    </>
                  )}
                  {i.status !== 'NEW' && <span className="badge text-bg-light border">{i.status}</span>}
                  <div className="d-flex gap-1 mt-1">
                    <button className="btn btn-sm btn-link p-0" title="Helpful" onClick={() => sendFeedback(i.id, true)}>👍</button>
                    <button className="btn btn-sm btn-link p-0" title="Not helpful" onClick={() => sendFeedback(i.id, false)}>👎</button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
