import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';
import { FiDownload, FiPrinter } from 'react-icons/fi';
import { formatCurrency } from '../../utils/currency';
import { downloadCsv } from '../../utils/csv';

// Builds the CSV rows for a given report - shaped independently per report
// key since each report's API response has a different structure.
function buildReportRows(reportKey, data) {
  switch (reportKey) {
    case 'sales/daily':
      return [
        ['Invoice', 'Customer', 'Subtotal', 'Discount', 'Total', 'Amount Paid', 'Created At'],
        ...data.sales.map((s) => [
          s.invoiceNumber,
          s.customer?.name || 'Walk-in',
          Number(s.subtotal).toFixed(2),
          Number(s.discount).toFixed(2),
          Number(s.total).toFixed(2),
          Number(s.amountPaid).toFixed(2),
          new Date(s.createdAt).toLocaleString(),
        ]),
        [],
        ['Total', '', '', '', Number(data.totals.total).toFixed(2), Number(data.totals.amountPaid).toFixed(2), `${data.count} transactions`],
      ];
    case 'sales/monthly':
      return [
        ['Date', 'Total'],
        ...Object.entries(data.byDay).map(([day, total]) => [day, Number(total).toFixed(2)]),
        [],
        ['Grand Total', Number(data.total).toFixed(2)],
      ];
    case 'inventory':
      return [
        ['Name', 'SKU', 'Category', 'Type', 'Stock Qty', 'Purchase Price', 'Selling Price', 'Stock Value', 'Low Stock'],
        ...data.rows.map((r) => [r.name, r.sku, r.category, r.type, r.stockQuantity, r.purchasePrice.toFixed(2), r.sellingPrice.toFixed(2), r.stockValue.toFixed(2), r.lowStock ? 'Yes' : 'No']),
        [],
        ['Total Stock Value', '', '', '', '', '', '', data.totalStockValue.toFixed(2)],
      ];
    case 'stock-movement':
      return [
        ['Date', 'Product', 'SKU', 'Type', 'Quantity', 'Balance After'],
        ...data.transactions.map((t) => [new Date(t.createdAt).toLocaleString(), t.product?.name, t.product?.sku, t.type, Number(t.quantity), Number(t.balanceAfter)]),
      ];
    case 'expenses':
      return [
        ['Date', 'Category', 'Amount', 'Description'],
        ...data.expenses.map((e) => [new Date(e.expenseDate).toLocaleDateString(), e.category?.name, Number(e.amount).toFixed(2), e.description || '']),
        [],
        ['Total', '', data.total.toFixed(2)],
      ];
    case 'profit-loss':
      return [
        ['Metric', 'Value'],
        ['Revenue', data.revenue.toFixed(2)],
        ['Cost of Goods Sold', data.cogs.toFixed(2)],
        ['Gross Profit', data.grossProfit.toFixed(2)],
        ['Expenses', data.totalExpenses.toFixed(2)],
        ['Net Profit', data.netProfit.toFixed(2)],
      ];
    case 'optical-orders':
      return [
        ['Order #', 'Customer', 'Status', 'Total Amount', 'Amount Paid', 'Created At'],
        ...data.orders.map((o) => [o.orderNumber, o.customer?.name, o.status, Number(o.totalAmount).toFixed(2), Number(o.amountPaid).toFixed(2), new Date(o.createdAt).toLocaleString()]),
      ];
    case 'medicine-expiry':
      return [
        ['Name', 'Batch', 'Expiry', 'Stock'],
        ...data.products.map((p) => [p.name, p.batchNumber, new Date(p.expiryDate).toLocaleDateString(), Number(p.stockQuantity)]),
      ];
    default:
      return [];
  }
}

const TABS = [
  { key: 'sales/daily', label: 'Daily Sales' },
  { key: 'sales/monthly', label: 'Monthly Sales' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'stock-movement', label: 'Stock Movement' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'profit-loss', label: 'Profit & Loss' },
  { key: 'optical-orders', label: 'Optical Orders' },
  { key: 'medicine-expiry', label: 'Medicine Expiry' },
];

export default function Reports() {
  const [active, setActive] = useState(TABS[0].key);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function runReport(key) {
    setActive(key);
    setLoading(true);
    setError('');
    apiClient
      .get(`/reports/${key}`)
      .then((res) => setData(res.data))
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => runReport(TABS[0].key), []);

  function handleExportCsv() {
    if (!data) return;
    const rows = buildReportRows(active, data);
    const filename = `${active.replace('/', '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadCsv(filename, rows);
  }

  const activeLabel = TABS.find((t) => t.key === active)?.label || 'Report';

  return (
    <div>
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3 report-toolbar">
        <h4 className="mb-0">Reports</h4>
        <div className="d-flex gap-2">
          <button className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1" onClick={() => window.print()} disabled={!data}>
            <FiPrinter size={14} /> Print / Save as PDF
          </button>
          <button className="btn btn-sm btn-primary d-flex align-items-center gap-1" onClick={handleExportCsv} disabled={!data}>
            <FiDownload size={14} /> Export CSV
          </button>
        </div>
      </div>

      <ul className="nav nav-pills mb-3 flex-wrap report-tabs">
        {TABS.map((t) => (
          <li className="nav-item" key={t.key}>
            <button className={`nav-link ${active === t.key ? 'active' : ''}`} onClick={() => runReport(t.key)}>
              {t.label}
            </button>
          </li>
        ))}
      </ul>

      <ErrorAlert message={error} />
      <div className="report-print-area">
        <h5 className="d-none d-print-block mb-3">{activeLabel}</h5>
        {loading ? <Spinner /> : <ReportBody reportKey={active} data={data} />}
      </div>
    </div>
  );
}

function ReportBody({ reportKey, data }) {
  if (!data) return null;

  if (reportKey === 'sales/daily' || reportKey === 'sales/monthly') {
    return (
      <div className="card">
        <div className="card-body">
          <p>Total: <strong>{formatCurrency(data.total ?? data.totals?.total ?? 0)}</strong> ({data.count} transactions)</p>
        </div>
      </div>
    );
  }

  if (reportKey === 'inventory') {
    return (
      <div className="card">
        <div className="card-body">
          <p>Total Stock Value: <strong>{formatCurrency(data.totalStockValue)}</strong></p>
        </div>
        <div className="table-responsive">
          <table className="table table-sm mb-0">
            <thead><tr><th>Name</th><th>Type</th><th className="text-end">Stock</th><th className="text-end">Value</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className={r.lowStock ? 'table-warning' : ''}>
                  <td>{r.name}</td><td>{r.type}</td>
                  <td className="text-end">{r.stockQuantity}</td>
                  <td className="text-end">{formatCurrency(r.stockValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (reportKey === 'stock-movement') {
    return (
      <div className="table-responsive">
        <table className="table table-sm">
          <thead><tr><th>Date</th><th>Product</th><th>Type</th><th className="text-end">Qty</th><th className="text-end">Balance After</th></tr></thead>
          <tbody>
            {data.transactions.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
                <td>{t.product?.name}</td>
                <td>{t.type}</td>
                <td className="text-end">{Number(t.quantity)}</td>
                <td className="text-end">{Number(t.balanceAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (reportKey === 'expenses') {
    return (
      <div>
        <div className="card mb-3">
          <div className="card-body">
            <p>Total: <strong>{formatCurrency(data.total)}</strong></p>
            {Object.entries(data.byCategory).map(([k, v]) => (
              <div key={k} className="d-flex justify-content-between"><span>{k}</span><span>{formatCurrency(v)}</span></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (reportKey === 'profit-loss') {
    return (
      <div className="card">
        <div className="card-body">
          <div className="d-flex justify-content-between"><span>Revenue</span><span>{formatCurrency(data.revenue)}</span></div>
          <div className="d-flex justify-content-between"><span>Cost of Goods Sold</span><span>{formatCurrency(data.cogs)}</span></div>
          <div className="d-flex justify-content-between fw-bold"><span>Gross Profit</span><span>{formatCurrency(data.grossProfit)}</span></div>
          <div className="d-flex justify-content-between"><span>Expenses</span><span>{formatCurrency(data.totalExpenses)}</span></div>
          <hr />
          <div className="d-flex justify-content-between fs-5 fw-bold"><span>Net Profit</span><span>{formatCurrency(data.netProfit)}</span></div>
        </div>
      </div>
    );
  }

  if (reportKey === 'optical-orders') {
    return (
      <div>
        <p>Total orders: {data.count}</p>
        {Object.entries(data.byStatus).map(([k, v]) => (
          <span key={k} className="badge text-bg-secondary me-2">{k}: {v}</span>
        ))}
      </div>
    );
  }

  if (reportKey === 'medicine-expiry') {
    return (
      <div>
        <div className="mb-2">
          <span className="badge text-bg-danger me-2">Expired: {data.expiredCount}</span>
          <span className="badge text-bg-warning">Near Expiry: {data.nearExpiryCount}</span>
        </div>
        <div className="table-responsive">
          <table className="table table-sm">
            <thead><tr><th>Name</th><th>Batch</th><th>Expiry</th><th className="text-end">Stock</th><th>Status</th></tr></thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.batchNumber}</td>
                  <td>{new Date(p.expiryDate).toLocaleDateString()}</td>
                  <td className="text-end">{Number(p.stockQuantity)}</td>
                  <td>
                    <span className={`badge text-bg-${p.isExpired ? 'danger' : 'warning'}`}>
                      {p.isExpired ? 'Expired' : 'Near Expiry'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return null;
}
