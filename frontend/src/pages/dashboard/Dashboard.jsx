import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';
import { formatCurrency } from '../../utils/currency';
import {
  FiDollarSign,
  FiTrendingUp,
  FiShoppingBag,
  FiPieChart,
  FiPackage,
  FiUsers,
  FiTruck,
  FiEye,
  FiAlertTriangle,
  FiCalendar,
} from 'react-icons/fi';

const VARIANT_COLORS = {
  primary: { bg: 'rgba(124, 58, 237, 0.12)', fg: '#7c3aed' },
  success: { bg: 'rgba(34, 197, 94, 0.12)', fg: '#16a34a' },
  info: { bg: 'rgba(14, 165, 233, 0.12)', fg: '#0ea5e9' },
  secondary: { bg: 'rgba(100, 116, 139, 0.12)', fg: '#64748b' },
  warning: { bg: 'rgba(245, 158, 11, 0.14)', fg: '#d97706' },
  danger: { bg: 'rgba(239, 68, 68, 0.12)', fg: '#dc2626' },
};

function StatCard({ label, value, sub, variant = 'primary', icon: Icon }) {
  const colors = VARIANT_COLORS[variant] ?? VARIANT_COLORS.primary;
  return (
    <div className="col-sm-6 col-lg-3">
      <div className="stat-card card-body d-flex flex-column gap-2 p-3">
        <div className="d-flex align-items-center justify-content-between">
          <span className="stat-card-label">{label}</span>
          <div className="stat-card-icon" style={{ background: colors.bg, color: colors.fg }}>
            <Icon />
          </div>
        </div>
        <div>
          <div className="stat-card-value">{value}</div>
          {sub && <div className="stat-card-sub">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

function ListCard({ title, count, badgeVariant, items, renderRow, icon: Icon, emptyLabel = 'None' }) {
  return (
    <div className="card h-100">
      <div className="card-header d-flex align-items-center justify-content-between">
        <span>{title}</span>
        <span className={`badge rounded-pill text-bg-${badgeVariant}`}>{count}</span>
      </div>
      <ul className="list-group list-group-flush">
        {items.length === 0 && (
          <li className="list-group-item text-body-secondary d-flex align-items-center gap-2 py-3">
            <Icon className="opacity-50" /> {emptyLabel}
          </li>
        )}
        {items.map(renderRow)}
      </ul>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiClient
      .get('/dashboard')
      .then((res) => setData(res.data))
      .catch((err) => setError(extractErrorMessage(err)));
  }, []);

  if (error) return <ErrorAlert message={error} />;
  if (!data) return <Spinner />;

  return (
    <div>
      <div className="mb-4">
        <h4 className="mb-1">Dashboard</h4>
        <div className="text-body-secondary small">Today's overview of your shop's performance</div>
      </div>

      <div className="row g-3 mb-4">
        <StatCard
          label="Today's Sales"
          value={formatCurrency(data.todaySales.total)}
          sub={`${data.todaySales.count} invoices`}
          icon={FiDollarSign}
          variant="primary"
        />
        <StatCard
          label="This Month's Sales"
          value={formatCurrency(data.monthSales.total)}
          sub={`${data.monthSales.count} invoices`}
          icon={FiTrendingUp}
          variant="success"
        />
        <StatCard
          label="This Month's Purchases"
          value={formatCurrency(data.monthPurchases.total)}
          icon={FiShoppingBag}
          variant="info"
        />
        <StatCard
          label="Est. Gross Profit (Month)"
          value={formatCurrency(data.grossProfitEstimate)}
          icon={FiPieChart}
          variant="secondary"
        />
        <StatCard label="Inventory Value" value={formatCurrency(data.inventoryValue)} icon={FiPackage} variant="primary" />
        <StatCard label="Customers" value={data.customerCount} icon={FiUsers} variant="info" />
        <StatCard label="Suppliers" value={data.supplierCount} icon={FiTruck} variant="secondary" />
        <StatCard
          label="Pending Optical Orders"
          value={data.pendingOpticalOrders}
          icon={FiEye}
          variant="warning"
        />
      </div>

      <div className="row g-3">
        <div className="col-md-6">
          <ListCard
            title="Low Stock Items"
            count={data.lowStockCount}
            badgeVariant="danger"
            items={data.lowStockItems}
            icon={FiAlertTriangle}
            renderRow={(p) => (
              <li key={p.name} className="list-group-item d-flex align-items-center gap-3">
                <div className="list-item-icon" style={{ background: VARIANT_COLORS.danger.bg, color: VARIANT_COLORS.danger.fg }}>
                  <FiAlertTriangle size={14} />
                </div>
                <span className="flex-grow-1">{p.name}</span>
                <span className="badge text-bg-danger-subtle text-danger-emphasis">{Number(p.stockQuantity)} left</span>
              </li>
            )}
          />
        </div>
        <div className="col-md-6">
          <ListCard
            title="Expiring Medicines (30 days)"
            count={data.expiringCount}
            badgeVariant="warning"
            items={data.expiringMedicines}
            icon={FiCalendar}
            renderRow={(p) => (
              <li key={p.name} className="list-group-item d-flex align-items-center gap-3">
                <div className="list-item-icon" style={{ background: VARIANT_COLORS.warning.bg, color: VARIANT_COLORS.warning.fg }}>
                  <FiCalendar size={14} />
                </div>
                <span className="flex-grow-1">{p.name}</span>
                <span className="text-body-secondary small">{new Date(p.expiryDate).toLocaleDateString()}</span>
              </li>
            )}
          />
        </div>
      </div>
    </div>
  );
}
