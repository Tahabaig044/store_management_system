import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import DeliveryUnavailableBanner from '../../components/DeliveryUnavailableBanner';

const CAN_EDIT = ['TENANT_ADMIN', 'MANAGER'];

export default function AutomationRules() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    apiClient.get('/communication/automation-rules').then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function toggle(rule) {
    setError('');
    try {
      await apiClient.patch(`/communication/automation-rules/${rule.id}`, { isEnabled: !rule.isEnabled });
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  async function updateDelay(rule, delayMinutes) {
    try {
      await apiClient.patch(`/communication/automation-rules/${rule.id}`, { delayMinutes });
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  return (
    <div>
      <DeliveryUnavailableBanner />
      <h4 className="mb-3">Automation Rules</h4>
      <p className="text-body-secondary small">
        Automatic WhatsApp messages and internal alerts triggered by business events - sales, optical order status
        changes, appointments, purchase approvals, and more. Disable any rule your business doesn&apos;t want to send.
      </p>
      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No automation rules configured." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>Event</th><th>Name</th><th>Action</th><th>Template</th><th>Delay (min)</th><th>Enabled</th></tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className="small text-body-secondary">{r.event}</td>
                    <td>{r.name}</td>
                    <td>{r.actionType === 'WHATSAPP_MESSAGE' ? 'WhatsApp' : 'Internal notification'}</td>
                    <td className="small">{r.template?.name || '-'}</td>
                    <td style={{ width: 120 }}>
                      <input
                        type="number"
                        min={0}
                        className="form-control form-control-sm"
                        defaultValue={r.delayMinutes}
                        disabled={!CAN_EDIT.includes(user?.role)}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v !== r.delayMinutes) updateDelay(r, v);
                        }}
                      />
                    </td>
                    <td>
                      <div className="form-check form-switch">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          checked={r.isEnabled}
                          disabled={!CAN_EDIT.includes(user?.role)}
                          onChange={() => toggle(r)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
