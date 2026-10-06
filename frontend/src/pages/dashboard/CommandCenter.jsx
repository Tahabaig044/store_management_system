import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import {
  FiDollarSign,
  FiTrendingUp,
  FiTrendingDown,
  FiShoppingBag,
  FiCreditCard,
  FiBriefcase,
  FiPackage,
  FiUsers,
  FiTruck,
  FiEye,
  FiSettings,
  FiSave,
  FiArrowUp,
  FiArrowDown,
  FiRefreshCw,
  FiZap,
  FiAlertTriangle,
} from 'react-icons/fi';
import { formatCurrency as money } from '../../utils/currency';

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

// Every widget the Command Center can show. Order here is the default
// layout; a signed-in manager/admin can hide/reorder and save their own
// layout (persisted per-user, per-tenant - see dashboard.routes.js).
const DEFAULT_WIDGETS = [
  { id: 'trends', label: 'Sales & Profit Trend' },
  { id: 'topProducts', label: 'Top-Selling Products' },
  { id: 'mostProfitable', label: 'Most Profitable Products' },
  { id: 'stock', label: 'Stock Alerts (Low / Slow / Dead / Expiring)' },
  { id: 'opticalJobs', label: 'Optical Jobs' },
  { id: 'customers', label: 'New vs Returning Customers' },
  { id: 'outstanding', label: 'Outstanding Payments' },
  { id: 'branchPerformance', label: 'Branch Performance' },
  { id: 'staffPerformance', label: 'Staff Performance' },
  { id: 'topSuppliers', label: 'Top Suppliers' },
  { id: 'topDebtors', label: 'Top Debtors' },
  { id: 'salesByCategory', label: 'Sales by Category' },
  { id: 'salesByPaymentMethod', label: 'Sales by Payment Method' },
  { id: 'overstock', label: 'Overstocked Products' },
];

const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'Last 7 Days' },
  { value: 'month', label: 'This Month' },
  { value: 'custom', label: 'Custom Range' },
];

function mergeWidgetPrefs(saved) {
  const savedMap = new Map((saved?.widgets || []).map((w) => [w.id, w]));
  return DEFAULT_WIDGETS
    .map((d, i) => {
      const s = savedMap.get(d.id);
      return { ...d, visible: s ? s.visible : true, order: s ? s.order : i };
    })
    .sort((a, b) => a.order - b.order);
}

const SEVERITY_BADGE = { URGENT: 'danger', ATTENTION: 'warning', OPPORTUNITY: 'info', INFORMATION: 'secondary' };

// AI Business Summary card - Phase 9. Reads the `ai` block already included
// in the command-center response (a fast read of previously-generated
// insights, never a live AI call), so it never slows or blocks the rest of
// this dashboard. Every figure and item shown here is clearly an AI-derived
// recommendation/alert, distinguished from the deterministic KPIs above,
// and links out to the full Recommendation Center / Assistant for
// drill-down and follow-up questions.
function AiSummaryCard({ ai }) {
  if (!ai) return null;
  if (!ai.isEnabled) {
    return (
      <div className="card p-3 mb-4">
        <div className="d-flex align-items-center gap-2 text-body-secondary">
          <FiZap /> AI insights are disabled for this account. <Link to="/ai-assistant" className="ms-1">Enable in settings</Link>
        </div>
      </div>
    );
  }
  const items = [...ai.topRisks, ...ai.topOpportunities, ...ai.anomalyAlerts].slice(0, 5);
  return (
    <div className="card p-3 mb-4">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <div className="d-flex align-items-center gap-2">
          <FiZap className="text-primary" />
          <strong>AI Business Summary</strong>
          <span className="badge text-bg-light border">AI-generated</span>
        </div>
        <div className="d-flex gap-2">
          <Link to="/ai-assistant" className="btn btn-sm btn-outline-primary">Ask AI</Link>
          <Link to="/recommendations" className="btn btn-sm btn-outline-secondary">View all ({ai.totalNewInsights})</Link>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="text-body-secondary small">No new risks, opportunities, or anomalies detected right now.</div>
      ) : (
        <ul className="list-unstyled mb-0 d-flex flex-column gap-2">
          {items.map((i) => (
            <li key={i.id} className="d-flex align-items-start gap-2">
              {i.type === 'ANOMALY' ? <FiAlertTriangle className="text-danger mt-1" size={14} /> : <FiZap className="text-body-secondary mt-1" size={14} />}
              <div>
                <span className={`badge text-bg-${SEVERITY_BADGE[i.severity]} me-2`}>{i.severity}</span>
                <span className="small">{i.title}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KpiCard({ label, value, icon: Icon, tone = 'primary' }) {
  return (
    <div className="col-6 col-md-4 col-xl-3">
      <div className="stat-card card-body d-flex flex-column gap-2 p-3 h-100">
        <div className="d-flex align-items-center justify-content-between">
          <span className="stat-card-label">{label}</span>
          <div className={`stat-card-icon`} style={{ background: `var(--bs-${tone}-bg-subtle, rgba(124,58,237,.12))` }}>
            <Icon />
          </div>
        </div>
        <div className="stat-card-value">{value}</div>
      </div>
    </div>
  );
}

// Minimal dependency-free bar/line trend visual - no charting library is
// installed in this project, and pulling one in for two small trend widgets
// was judged not worth the added bundle weight.
function TrendChart({ points, valueKey, color }) {
  if (!points || points.length === 0) return <EmptyState message="No data in this range." />;
  const max = Math.max(...points.map((p) => p[valueKey]), 0.01);
  const min = Math.min(...points.map((p) => p[valueKey]), 0);
  const range = max - min || 1;
  const w = 100 / points.length;
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: '100%', height: 90 }}>
        {points.map((p, i) => {
          const h = ((p[valueKey] - Math.min(min, 0)) / (range + Math.max(-min, 0))) * 38;
          return (
            <rect
              key={p.date}
              x={i * w + w * 0.15}
              y={40 - h}
              width={w * 0.7}
              height={Math.max(h, 0.5)}
              fill={color}
              opacity={0.85}
            >
              <title>{`${p.date}: ${money(p[valueKey])}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="d-flex justify-content-between text-body-secondary" style={{ fontSize: '0.7rem' }}>
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export default function CommandCenter() {
  const navigate = useNavigate();

  const [range, setRange] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [branchId, setBranchId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [productId, setProductId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [orderStatus, setOrderStatus] = useState('');

  const [branches, setBranches] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [customers, setCustomers] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  const [widgets, setWidgets] = useState(() => mergeWidgetPrefs(null));
  const [customizing, setCustomizing] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  // Filter dropdown option lists. These reuse endpoints every MANAGEMENT
  // user can already read (Users list is TENANT_ADMIN-only, so the Staff
  // filter is populated from the command-center response itself instead -
  // see the effect below).
  useEffect(() => {
    apiClient.get('/branches').then((res) => setBranches(res.data.items || [])).catch(() => {});
    apiClient.get('/companies').then((res) => setCompanies(res.data.items || [])).catch(() => {});
    apiClient.get('/warehouses').then((res) => setWarehouses(res.data.items || [])).catch(() => {});
    apiClient.get('/categories', { params: { pageSize: 100 } }).then((res) => setCategories(res.data.items || [])).catch(() => {});
    apiClient.get('/products', { params: { pageSize: 200 } }).then((res) => setProducts(res.data.items || [])).catch(() => {});
    apiClient.get('/suppliers', { params: { pageSize: 200 } }).then((res) => setSuppliers(res.data.items || [])).catch(() => {});
    apiClient.get('/customers', { params: { pageSize: 200 } }).then((res) => setCustomers(res.data.items || [])).catch(() => {});
    apiClient
      .get('/dashboard/preferences')
      .then((res) => setWidgets(mergeWidgetPrefs(res.data.preferences)))
      .catch(() => {});
  }, []);

  function load() {
    setLoading(true);
    setError('');
    apiClient
      .get('/dashboard/command-center', {
        params: {
          range,
          from: range === 'custom' ? customFrom || undefined : undefined,
          to: range === 'custom' ? customTo || undefined : undefined,
          branchId: branchId || undefined,
          companyId: companyId || undefined,
          warehouseId: warehouseId || undefined,
          categoryId: categoryId || undefined,
          productId: productId || undefined,
          supplierId: supplierId || undefined,
          customerId: customerId || undefined,
          staffId: staffId || undefined,
          paymentStatus: paymentStatus || undefined,
          orderStatus: orderStatus || undefined,
        },
      })
      .then((res) => {
        setData(res.data);
        setLastUpdated(new Date());
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [range, customFrom, customTo, branchId, companyId, warehouseId, categoryId, productId, supplierId, customerId, staffId, paymentStatus, orderStatus]);

  const visibleWidgets = useMemo(() => widgets.filter((w) => w.visible).sort((a, b) => a.order - b.order), [widgets]);

  function moveWidget(id, dir) {
    setWidgets((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((w) => w.id === id);
      const swapWith = idx + dir;
      if (swapWith < 0 || swapWith >= sorted.length) return prev;
      const a = sorted[idx], b = sorted[swapWith];
      [a.order, b.order] = [b.order, a.order];
      return sorted.map((w) => ({ ...w }));
    });
  }

  function toggleWidget(id) {
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)));
  }

  function savePreferences() {
    setSavingPrefs(true);
    apiClient
      .put('/dashboard/preferences', { widgets: widgets.map(({ id, visible, order }) => ({ id, visible, order })) })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setSavingPrefs(false));
  }

  if (error && !data) return <ErrorAlert message={error} />;

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
        <div>
          <h4 className="mb-1">Business Command Center</h4>
          <div className="text-body-secondary small">
            Consolidated owner/admin view across sales, inventory, payments and optical jobs.
            {lastUpdated && <> &middot; Last updated {lastUpdated.toLocaleTimeString()}</>}
          </div>
        </div>
        <div className="d-flex gap-2">
          <button className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1" onClick={load} disabled={loading}>
            <FiRefreshCw className={loading ? 'spin' : ''} /> Refresh
          </button>
          <button
            className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1"
            onClick={() => setCustomizing((v) => !v)}
          >
            <FiSettings /> {customizing ? 'Done Customizing' : 'Customize'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-3">
        <div className="card-body d-flex flex-wrap gap-2 align-items-end">
          <div>
            <label className="form-label small mb-1">Range</label>
            <select className="form-select form-select-sm" value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          {range === 'custom' && (
            <>
              <div>
                <label className="form-label small mb-1">From</label>
                <input type="date" className="form-control form-control-sm" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </div>
              <div>
                <label className="form-label small mb-1">To</label>
                <input type="date" className="form-control form-control-sm" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            </>
          )}
          <div>
            <label className="form-label small mb-1">Company</label>
            <select className="form-select form-select-sm" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Branch</label>
            <select className="form-select form-select-sm" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Warehouse</label>
            <select className="form-select form-select-sm" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">All warehouses</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Category</label>
            <select className="form-select form-select-sm" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Product</label>
            <select className="form-select form-select-sm" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">All products</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Supplier</label>
            <select className="form-select form-select-sm" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">All suppliers</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Customer</label>
            <select className="form-select form-select-sm" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">All customers</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Staff</label>
            <select className="form-select form-select-sm" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">All staff</option>
              {(data?.staffPerformance || [])
                .filter((s) => s.staffId)
                .map((s) => <option key={s.staffId} value={s.staffId}>{s.staffName}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Payment Status</label>
            <select className="form-select form-select-sm" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="PAID">Paid</option>
              <option value="PARTIAL">Partial</option>
              <option value="UNPAID">Unpaid</option>
            </select>
          </div>
          <div>
            <label className="form-label small mb-1">Order Status</label>
            <select className="form-select form-select-sm" value={orderStatus} onChange={(e) => setOrderStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="PENDING">Pending</option>
              <option value="IN_LAB">In Lab</option>
              <option value="READY">Ready</option>
              <option value="DELIVERED">Delivered</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
        </div>
      </div>

      <ErrorAlert message={error} />

      {customizing && (
        <div className="card mb-3">
          <div className="card-header d-flex justify-content-between align-items-center">
            <span>Customize Widgets</span>
            <button className="btn btn-sm btn-primary d-flex align-items-center gap-1" onClick={savePreferences} disabled={savingPrefs}>
              <FiSave /> {savingPrefs ? 'Saving...' : 'Save Layout'}
            </button>
          </div>
          <ul className="list-group list-group-flush">
            {[...widgets].sort((a, b) => a.order - b.order).map((w) => (
              <li key={w.id} className="list-group-item d-flex align-items-center gap-3">
                <input type="checkbox" className="form-check-input" checked={w.visible} onChange={() => toggleWidget(w.id)} />
                <span className="flex-grow-1">{w.label}</span>
                <button className="btn btn-sm btn-outline-secondary" onClick={() => moveWidget(w.id, -1)} aria-label="Move up">
                  <FiArrowUp />
                </button>
                <button className="btn btn-sm btn-outline-secondary" onClick={() => moveWidget(w.id, 1)} aria-label="Move down">
                  <FiArrowDown />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && !data ? (
        <Spinner />
      ) : !data ? (
        <EmptyState message="No data available." />
      ) : (
        <>
          {/* KPI row - always visible, not part of the hide/reorder set since
              these are the headline figures the rest of the screen supports. */}
          <div className="row g-3 mb-4">
            <KpiCard label="Sales" value={money(data.kpis.sales)} icon={FiDollarSign} />
            <KpiCard label="Sales Growth" value={pct(data.kpis.salesGrowthPercent)} icon={data.kpis.salesGrowthPercent >= 0 ? FiTrendingUp : FiTrendingDown} />
            <KpiCard label="Avg Invoice Value" value={data.kpis.averageInvoiceValue == null ? 'n/a' : money(data.kpis.averageInvoiceValue)} icon={FiDollarSign} />
            <KpiCard label="Gross Profit" value={money(data.kpis.grossProfit)} icon={FiTrendingUp} />
            <KpiCard label="Net Profit" value={money(data.kpis.netProfit)} icon={data.kpis.netProfit >= 0 ? FiTrendingUp : FiTrendingDown} />
            <KpiCard label="Purchases" value={money(data.kpis.purchases)} icon={FiShoppingBag} />
            <KpiCard label="Purchase Growth" value={pct(data.kpis.purchaseGrowthPercent)} icon={data.kpis.purchaseGrowthPercent >= 0 ? FiTrendingUp : FiTrendingDown} />
            <KpiCard label="Expenses" value={money(data.kpis.expenses)} icon={FiCreditCard} />
            <KpiCard label="Cash" value={money(data.kpis.cash)} icon={FiDollarSign} />
            <KpiCard label="Bank" value={money(data.kpis.bank)} icon={FiBriefcase} />
            <KpiCard
              label="Receivables"
              value={money(data.kpis.receivables)}
              icon={FiUsers}
            />
            <KpiCard label="Payables" value={money(data.kpis.payables)} icon={FiTruck} />
            <KpiCard label="Inventory Value" value={money(data.kpis.inventoryValue)} icon={FiPackage} />
          </div>

          {data.accounting?.ledger && (
            <>
              <div className="small text-body-secondary mb-2" data-testid="ledger-kpis-heading">From the ledger (same figures as the financial statements)</div>
              <div className="row g-3 mb-4">
                <KpiCard label="Ledger Revenue" value={money(data.accounting.ledger.revenue)} icon={FiDollarSign} />
                <KpiCard label="Ledger Gross Profit" value={money(data.accounting.ledger.grossProfit)} icon={FiTrendingUp} />
                <KpiCard label="Ledger Net Profit" value={money(data.accounting.ledger.netProfit)} icon={data.accounting.ledger.netProfit >= 0 ? FiTrendingUp : FiTrendingDown} />
                <KpiCard label="Cash & Bank Position" value={money(data.accounting.ledger.cashAndBank)} icon={FiBriefcase} />
                <KpiCard label="Ledger Receivables" value={money(data.accounting.ledger.receivables)} icon={FiUsers} />
                <KpiCard label="Ledger Payables" value={money(data.accounting.ledger.payables)} icon={FiTruck} />
              </div>
            </>
          )}

          <AiSummaryCard ai={data.ai} />

          {visibleWidgets.map((w) => {
            switch (w.id) {
              case 'trends':
                return (
                  <div className="row g-3 mb-3" key={w.id}>
                    <div className="col-md-6">
                      <div className="card h-100">
                        <div className="card-header">Sales Trend</div>
                        <div className="card-body">
                          <TrendChart points={data.trends.sales} valueKey="total" color="#7c3aed" />
                        </div>
                      </div>
                    </div>
                    <div className="col-md-6">
                      <div className="card h-100">
                        <div className="card-header">Profit Trend</div>
                        <div className="card-body">
                          <TrendChart points={data.trends.profit} valueKey="profit" color="#16a34a" />
                        </div>
                      </div>
                    </div>
                  </div>
                );

              case 'topProducts':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Top-Selling Products</div>
                    {data.topProducts.length === 0 ? (
                      <div className="card-body"><EmptyState message="No sales in this range." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.topProducts.map((p) => (
                          <li key={p.productId} className="list-group-item d-flex justify-content-between">
                            <span>{p.name}</span>
                            <span className="text-body-secondary small">{p.quantity} sold &middot; {money(p.revenue)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'mostProfitable':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Most Profitable Products</div>
                    {data.mostProfitableProducts.length === 0 ? (
                      <div className="card-body"><EmptyState message="No sales in this range." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.mostProfitableProducts.map((p) => (
                          <li key={p.productId} className="list-group-item d-flex justify-content-between">
                            <span>{p.name}</span>
                            <span className="text-body-secondary small">{money(p.profit)} profit</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'stock':
                return (
                  <div className="row g-3 mb-3" key={w.id}>
                    {[
                      { title: 'Low Stock', items: data.stock.lowStock, count: data.stock.lowStockCount, to: '/products?lowStock=1' },
                      { title: 'Slow-Moving Stock', items: data.stock.slowMoving, count: data.stock.slowMovingCount, to: '/products' },
                      { title: 'Dead Stock', items: data.stock.deadStock, count: data.stock.deadStockCount, to: '/products' },
                      { title: 'Expiring Medicines (30 days)', items: data.stock.expiringMedicines, count: data.stock.expiringCount, to: '/products?type=MEDICINE' },
                    ].map((box) => (
                      <div className="col-md-6 col-xl-3" key={box.title}>
                        <div className="card h-100" role="button" onClick={() => navigate(box.to)}>
                          <div className="card-header d-flex justify-content-between">
                            <span>{box.title}</span>
                            <span className="badge text-bg-secondary">{box.count}</span>
                          </div>
                          <ul className="list-group list-group-flush">
                            {box.items.length === 0 && <li className="list-group-item text-body-secondary small">None</li>}
                            {box.items.slice(0, 5).map((p) => (
                              <li key={p.id || p.name} className="list-group-item small">{p.name}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ))}
                  </div>
                );

              case 'opticalJobs':
                return (
                  <div className="row g-3 mb-3" key={w.id}>
                    {[
                      { label: 'Pending', value: data.opticalJobs.pending, to: '/optical-orders?status=PENDING' },
                      { label: 'Ready', value: data.opticalJobs.ready, to: '/optical-orders?status=READY' },
                      { label: 'Delayed', value: data.opticalJobs.delayed, to: '/optical-orders' },
                    ].map((j) => (
                      <div className="col-md-4" key={j.label}>
                        <div className="card h-100" role="button" onClick={() => navigate(j.to)}>
                          <div className="card-body d-flex align-items-center gap-3">
                            <div className="stat-card-icon" style={{ background: 'rgba(124,58,237,.12)', color: '#7c3aed' }}>
                              <FiEye />
                            </div>
                            <div>
                              <div className="stat-card-value">{j.value}</div>
                              <div className="stat-card-label">{j.label} Jobs</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );

              case 'customers':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">New vs Returning Customers</div>
                    <div className="card-body d-flex gap-4">
                      <div>
                        <div className="stat-card-value">{data.customers.new}</div>
                        <div className="stat-card-label">New</div>
                      </div>
                      <div>
                        <div className="stat-card-value">{data.customers.returning}</div>
                        <div className="stat-card-label">Returning</div>
                      </div>
                    </div>
                  </div>
                );

              case 'outstanding':
                return (
                  <div className="row g-3 mb-3" key={w.id}>
                    <div className="col-md-6">
                      <div className="card h-100">
                        <div className="card-header">Top Receivables (Customers Owing)</div>
                        {data.outstandingPayments.topReceivables.length === 0 ? (
                          <div className="card-body"><EmptyState message="Nothing outstanding." /></div>
                        ) : (
                          <ul className="list-group list-group-flush">
                            {data.outstandingPayments.topReceivables.map((r) => (
                              <li
                                key={r.id}
                                className="list-group-item d-flex justify-content-between"
                                role="button"
                                onClick={() => navigate(`/customers?search=${encodeURIComponent(r.name)}`)}
                              >
                                <span>{r.name}</span>
                                <span className="text-danger fw-semibold">{money(r.amountDue)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                    <div className="col-md-6">
                      <div className="card h-100">
                        <div className="card-header">Top Payables (Owed to Suppliers)</div>
                        {data.outstandingPayments.topPayables.length === 0 ? (
                          <div className="card-body"><EmptyState message="Nothing outstanding." /></div>
                        ) : (
                          <ul className="list-group list-group-flush">
                            {data.outstandingPayments.topPayables.map((p) => (
                              <li
                                key={p.id}
                                className="list-group-item d-flex justify-content-between"
                                role="button"
                                onClick={() => navigate(`/suppliers?search=${encodeURIComponent(p.name)}`)}
                              >
                                <span>{p.name}</span>
                                <span className="text-danger fw-semibold">{money(p.amountDue)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                );

              case 'branchPerformance':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Branch Performance</div>
                    {data.branchPerformance.length === 0 ? (
                      <div className="card-body"><EmptyState message="No sales in this range." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.branchPerformance.map((b) => (
                          <li key={b.branchId || 'unassigned'} className="list-group-item d-flex justify-content-between">
                            <span>{b.branchName}</span>
                            <span className="text-body-secondary small">{b.count} sales &middot; {money(b.total)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'staffPerformance':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Staff Performance</div>
                    {data.staffPerformance.length === 0 ? (
                      <div className="card-body"><EmptyState message="No sales in this range." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.staffPerformance.map((s) => (
                          <li key={s.staffId || 'unassigned'} className="list-group-item d-flex justify-content-between">
                            <span>{s.staffName}</span>
                            <span className="text-body-secondary small">{s.count} sales &middot; {money(s.total)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'topSuppliers':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Top Suppliers</div>
                    {(data.topSuppliers || []).length === 0 ? (
                      <div className="card-body"><EmptyState message="No purchases in this range." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.topSuppliers.map((s) => (
                          <li
                            key={s.supplierId}
                            className="list-group-item d-flex justify-content-between"
                            role="button"
                            onClick={() => navigate(`/suppliers?search=${encodeURIComponent(s.supplierName || '')}`)}
                          >
                            <span>{s.supplierName}</span>
                            <span className="text-body-secondary small">{s.purchaseCount} purchase(s) &middot; {money(s.totalPurchased)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'topDebtors':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Top Debtors (Customers Who Owe the Most)</div>
                    {(data.topDebtors || []).length === 0 ? (
                      <div className="card-body"><EmptyState message="No outstanding customer balances." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.topDebtors.map((d) => (
                          <li
                            key={d.customerId || 'walk-in'}
                            className="list-group-item d-flex justify-content-between"
                            role="button"
                            onClick={() => navigate(`/customers?search=${encodeURIComponent(d.customerName || '')}`)}
                          >
                            <span>{d.customerName || 'Walk-in'}</span>
                            <span className="text-danger fw-semibold small">{money(d.amountDue)} ({d.oldestDaysOverdue}d)</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'salesByCategory':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Sales by Category</div>
                    {(data.salesByCategory || []).length === 0 ? (
                      <div className="card-body"><EmptyState message="No sales in this range." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.salesByCategory.map((c) => (
                          <li key={c.categoryId || 'uncategorized'} className="list-group-item d-flex justify-content-between">
                            <span>{c.categoryName}</span>
                            <span className="text-body-secondary small">{c.quantitySold} sold &middot; {money(c.revenue)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'salesByPaymentMethod':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Sales by Payment Method</div>
                    {(data.salesByPaymentMethod || []).length === 0 ? (
                      <div className="card-body"><EmptyState message="No sales in this range." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.salesByPaymentMethod.map((m) => (
                          <li key={m.paymentMethod} className="list-group-item d-flex justify-content-between">
                            <span className="text-capitalize">{m.paymentMethod}</span>
                            <span className="text-body-secondary small">{m.saleCount} sale(s) &middot; {money(m.total)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              case 'overstock':
                return (
                  <div className="card mb-3" key={w.id}>
                    <div className="card-header">Overstocked Products ({(data.overstock || {}).count || 0})</div>
                    {(data.overstock?.items || []).length === 0 ? (
                      <div className="card-body"><EmptyState message="No products are overstocked relative to demand." /></div>
                    ) : (
                      <ul className="list-group list-group-flush">
                        {data.overstock.items.map((p) => (
                          <li
                            key={p.productId}
                            className="list-group-item d-flex justify-content-between"
                            role="button"
                            onClick={() => navigate(`/products?search=${encodeURIComponent(p.name)}`)}
                          >
                            <span>{p.name}</span>
                            <span className="text-body-secondary small">{p.daysOfStockRemaining}d of stock &middot; {money(p.capitalTiedUp)} tied up</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );

              default:
                return null;
            }
          })}
        </>
      )}
    </div>
  );
}
