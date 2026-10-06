// Phase 1.2: read-only viewer for the existing Phase 0.4 Permission/
// RolePermission catalog (GET /api/permissions, already implemented and
// tested since Phase 0.4 - this page only newly surfaces it in the UI).
// TENANT_ADMIN-only, matching the backend endpoint's own requireRole gate
// exactly (that endpoint deliberately uses requireRole, not
// requirePermission, since it exposes the permission catalog itself) - see
// App.jsx/Layout.jsx, which gate this page/nav item by role for the same
// reason rather than by a permission key.
import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';

const ROLE_COLUMNS = ['TENANT_ADMIN', 'MANAGER', 'CASHIER', 'STORE_KEEPER', 'RECEPTIONIST', 'ACCOUNTANT', 'DOCTOR'];

export default function RolesPermissions() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiClient
      .get('/permissions')
      .then((res) => setItems(res.data.items))
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;

  const byResource = {};
  for (const p of items) {
    if (!byResource[p.resource]) byResource[p.resource] = [];
    byResource[p.resource].push(p);
  }

  return (
    <div>
      <div className="mb-4">
        <h4 className="mb-1">Roles &amp; Permissions</h4>
        <div className="text-body-secondary small">
          What each role can do, across every resource. This is read-only - roles and their permissions are defined by
          the application, not editable per-tenant.
        </div>
      </div>

      {error && <ErrorAlert message={error} />}

      <div className="table-responsive">
        <table className="table table-sm table-bordered align-middle">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Action</th>
              {ROLE_COLUMNS.map((r) => (
                <th key={r} className="text-center">{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.keys(byResource).sort().map((resource) =>
              byResource[resource].map((p, idx) => (
                <tr key={p.id}>
                  {idx === 0 && <td rowSpan={byResource[resource].length} className="fw-semibold align-middle">{resource}</td>}
                  <td>{p.action}</td>
                  {ROLE_COLUMNS.map((r) => (
                    <td key={r} className="text-center">
                      {p.roles.includes(r) ? <span className="text-success">✓</span> : ''}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
