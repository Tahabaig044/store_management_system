// Phase 0.5: lets a TENANT_ADMIN see the full Core/Universal/Industry module
// registry and toggle an industry module on/off for this tenant - the UI for
// the capability GET/PATCH /api/modules adds on the backend. Toggling calls
// refreshMe() so the sidebar/routes reflect the change immediately, without
// a re-login.
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

const TYPE_LABELS = { CORE: 'Core', UNIVERSAL: 'Universal Module', INDUSTRY: 'Industry Module' };

export default function Modules() {
  const { hasPermission, refreshMe } = useAuth();
  const canUpdate = hasPermission('MODULE:UPDATE');

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [togglingId, setTogglingId] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get('/modules');
      setItems(data.items);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggle = async (item) => {
    setTogglingId(item.id);
    try {
      await apiClient.patch(`/modules/${item.id}`, { enabled: !item.enabled });
      await Promise.all([load(), refreshMe()]);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setTogglingId(null);
    }
  };

  if (loading) return <Spinner />;

  const byType = { CORE: [], UNIVERSAL: [], INDUSTRY: [] };
  for (const item of items) byType[item.type]?.push(item);

  return (
    <div>
      <div className="mb-4">
        <h4 className="mb-1">Modules</h4>
        <div className="text-body-secondary small">
          Core and Universal modules are always available to every business. Industry modules can be turned on or off for this tenant.
        </div>
      </div>
      {error && <ErrorAlert message={error} />}

      {['CORE', 'UNIVERSAL', 'INDUSTRY'].map((type) => (
        <div className="mb-4" key={type}>
          <h6 className="text-uppercase text-body-secondary small mb-2">{TYPE_LABELS[type]}</h6>
          <div className="list-group">
            {byType[type].map((item) => (
              <div className="list-group-item d-flex justify-content-between align-items-center" key={item.id}>
                <div>
                  <div className="fw-semibold">
                    {item.name}
                    {!item.implemented && <span className="badge bg-secondary ms-2">Not yet implemented</span>}
                  </div>
                  <div className="text-body-secondary small">{item.description}</div>
                  {item.dependencies.length > 0 && (
                    <div className="text-body-secondary small">Depends on: {item.dependencies.join(', ')}</div>
                  )}
                </div>
                {type === 'INDUSTRY' ? (
                  <div className="form-check form-switch mb-0">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      checked={item.enabled}
                      disabled={!canUpdate || !item.implemented || togglingId === item.id}
                      onChange={() => toggle(item)}
                    />
                  </div>
                ) : (
                  <span className="badge bg-success-subtle text-success-emphasis">Always on</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
