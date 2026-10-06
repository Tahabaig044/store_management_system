// Phase 2.1: Journal Entries - list, create (save as draft or post), edit a
// draft, detail with post / cancel / reverse. A posted entry is immutable; the
// only correction path is reverse-then-re-enter, which the backend enforces.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency } from '../../utils/currency';
import JournalLinesEditor, { emptyLine, lineTotals, lineIsValid, toPayload } from './JournalLinesEditor';

const SOURCE_LABELS = { MANUAL: 'Manual', OPENING_BALANCE: 'Opening balance', ADJUSTMENT: 'Adjustment' };
const today = () => new Date().toISOString().slice(0, 10);

export default function JournalEntries() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('JOURNAL:CREATE');
  const canUpdate = hasPermission('JOURNAL:UPDATE');
  const canPost = hasPermission('JOURNAL:APPROVE');
  const canReverse = hasPermission('JOURNAL:REVERSE');

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filters, setFilters] = useState({ status: '', sourceType: '', search: '', from: '', to: '' });
  const [accounts, setAccounts] = useState([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ date: today(), memo: '', reference: '', lines: [emptyLine(), emptyLine()] });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);

  const pageSize = 20;

  function load() {
    setLoading(true);
    const params = { page, pageSize };
    if (filters.status) params.status = filters.status;
    if (filters.sourceType) params.sourceType = filters.sourceType;
    if (filters.search) params.search = filters.search;
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = new Date(`${filters.to}T23:59:59`).toISOString();
    apiClient
      .get('/accounting/journal', { params })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }
  useEffect(load, [page, filters.status, filters.sourceType, filters.search, filters.from, filters.to]);

  useEffect(() => {
    apiClient.get('/accounting/accounts').then((res) => setAccounts(res.data.items)).catch(() => {});
  }, []);

  function openCreate() {
    setEditingId(null);
    setFormError('');
    setForm({ date: today(), memo: '', reference: '', lines: [emptyLine(), emptyLine()] });
    setFormOpen(true);
  }

  function openEditDraft(entry) {
    setEditingId(entry.id);
    setFormError('');
    setForm({
      date: entry.date.slice(0, 10),
      memo: entry.memo || '',
      reference: entry.reference || '',
      lines: entry.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit) > 0 ? String(Number(l.debit)) : '', credit: Number(l.credit) > 0 ? String(Number(l.credit)) : '', description: l.description || '' })),
    });
    setDetail(null);
    setFormOpen(true);
  }

  const totals = lineTotals(form.lines);
  const linesValid = form.lines.length >= 2 && form.lines.every(lineIsValid);
  const balanced = linesValid && totals.difference === 0 && totals.debit > 0;

  async function save(asDraft) {
    setSaving(true);
    setFormError('');
    try {
      const body = { date: new Date(form.date).toISOString(), memo: form.memo || undefined, reference: form.reference || undefined, lines: toPayload(form.lines) };
      if (editingId) {
        await apiClient.patch(`/accounting/journal/${editingId}`, { ...body, reference: form.reference || null });
        if (!asDraft) await apiClient.post(`/accounting/journal/${editingId}/post`);
      } else {
        await apiClient.post('/accounting/journal', { ...body, draft: asDraft || undefined });
      }
      setFormOpen(false);
      setNotice(asDraft ? 'Draft saved.' : 'Journal entry posted.');
      load();
    } catch (err) {
      setFormError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(entry) {
    setError('');
    try {
      const res = await apiClient.get(`/accounting/journal/${entry.id}`);
      setDetail({ ...res.data.item, sourceEntity: res.data.sourceEntity });
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function act(path, successMessage, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError('');
    try {
      await apiClient.post(`/accounting/journal/${detail.id}/${path}`);
      setNotice(successMessage);
      setDetail(null);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const reversible = detail && detail.status === 'POSTED' && !detail.reversalOfId && Object.keys(SOURCE_LABELS).includes(detail.sourceType);

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Journal Entries</h4>
        {canCreate && (
          <button className="btn btn-primary" onClick={openCreate}>+ New Journal Entry</button>
        )}
      </div>

      <div className="row g-2 mb-3">
        <div className="col-auto">
          <select className="form-select form-select-sm" aria-label="Status filter" value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }}>
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="POSTED">Posted</option>
            <option value="VOID">Void (reversed)</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <div className="col-auto">
          <select className="form-select form-select-sm" aria-label="Source filter" value={filters.sourceType} onChange={(e) => { setPage(1); setFilters({ ...filters, sourceType: e.target.value }); }}>
            <option value="">All sources</option>
            <option value="MANUAL">Manual</option>
            <option value="OPENING_BALANCE">Opening balance</option>
            <option value="SALE">Sale</option>
            <option value="PURCHASE">Purchase</option>
            <option value="PAYMENT">Payment</option>
            <option value="EXPENSE">Expense</option>
          </select>
        </div>
        <div className="col-auto">
          <input className="form-control form-control-sm" placeholder="Search number / memo / reference..." value={filters.search} onChange={(e) => { setPage(1); setFilters({ ...filters, search: e.target.value }); }} />
        </div>
        <div className="col-auto"><input type="date" className="form-control form-control-sm" aria-label="From date" value={filters.from} onChange={(e) => { setPage(1); setFilters({ ...filters, from: e.target.value }); }} /></div>
        <div className="col-auto"><input type="date" className="form-control form-control-sm" aria-label="To date" value={filters.to} onChange={(e) => { setPage(1); setFilters({ ...filters, to: e.target.value }); }} /></div>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No journal entries found." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr><th>#</th><th>Date</th><th>Description</th><th>Source</th><th>Status</th><th className="text-end">Amount</th></tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} role="button" onClick={() => openDetail(e)}>
                    <td>{e.entryNumber}</td>
                    <td>{new Date(e.date).toLocaleDateString()}</td>
                    <td>{e.memo || e.reference || '-'}</td>
                    <td>{SOURCE_LABELS[e.sourceType] || e.sourceType}</td>
                    <td><StatusBadge status={e.status} /></td>
                    <td className="text-end">{formatCurrency(e.lines.reduce((s, l) => s + Number(l.debit), 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-footer">
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </div>
        </div>
      )}

      <Modal
        show={formOpen}
        size="lg"
        title={editingId ? 'Edit Draft Journal Entry' : 'New Journal Entry'}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setFormOpen(false)}>Cancel</button>
            <button className="btn btn-outline-primary" disabled={saving || !form.lines.some((l) => l.accountId)} onClick={() => save(true)}>Save as Draft</button>
            {(editingId ? canPost : true) && (
              <button className="btn btn-primary" disabled={saving || !balanced} onClick={() => save(false)}>{saving ? 'Saving...' : 'Post Entry'}</button>
            )}
          </>
        }
      >
        <ErrorAlert message={formError} />
        <div className="row g-2 mb-3">
          <div className="col-md-4">
            <label className="form-label">Date</label>
            <input type="date" className="form-control" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div className="col-md-8">
            <label className="form-label">Reference</label>
            <input className="form-control" placeholder="Voucher / document number (optional)" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </div>
          <div className="col-12">
            <label className="form-label">Description</label>
            <input className="form-control" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </div>
        </div>
        <JournalLinesEditor
          lines={form.lines}
          onChange={(lines) => setForm({ ...form, lines })}
          accounts={accounts}
          footerNote={
            <div className={`mt-2 small ${balanced ? 'text-success' : 'text-danger'}`} role="status">
              {balanced ? 'Balanced - ready to post.' : linesValid ? `Out of balance by ${formatCurrency(Math.abs(totals.difference))} (debits ${totals.difference > 0 ? 'exceed' : 'are below'} credits).` : 'Each line needs an account and either a debit or a credit.'}
            </div>
          }
        />
      </Modal>

      <Modal
        show={!!detail}
        size="lg"
        title={detail ? `Journal Entry ${detail.entryNumber}` : ''}
        onClose={() => setDetail(null)}
        footer={
          detail && (
            <>
              {detail.status === 'DRAFT' && canUpdate && <button className="btn btn-outline-primary" onClick={() => openEditDraft(detail)}>Edit</button>}
              {detail.status === 'DRAFT' && canUpdate && <button className="btn btn-outline-secondary" disabled={busy} onClick={() => act('cancel', 'Draft cancelled.', 'Cancel this draft?')}>Cancel Draft</button>}
              {detail.status === 'DRAFT' && canPost && <button className="btn btn-primary" disabled={busy} onClick={() => act('post', 'Journal entry posted.')}>Post</button>}
              {reversible && canReverse && <button className="btn btn-outline-danger" disabled={busy} onClick={() => act('reverse', 'Entry reversed.', `Reverse ${detail.entryNumber}? This posts an exact mirror entry.`)}>Reverse</button>}
            </>
          )
        }
      >
        {detail && (
          <div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Status</span><StatusBadge status={detail.status} /></div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Date</span><span>{new Date(detail.date).toLocaleDateString()}</span></div>
            <div className="d-flex justify-content-between"><span className="text-body-secondary">Source</span><span>{SOURCE_LABELS[detail.sourceType] || detail.sourceType}{detail.sourceEntity ? ` (${detail.sourceEntity})` : ''}</span></div>
            {detail.reference && <div className="d-flex justify-content-between"><span className="text-body-secondary">Reference</span><span>{detail.reference}</span></div>}
            {detail.memo && <div className="d-flex justify-content-between"><span className="text-body-secondary">Description</span><span>{detail.memo}</span></div>}
            {detail.reversalOf && <div className="alert alert-secondary py-2 small mt-2 mb-0">Reversal of {detail.reversalOf.entryNumber}.</div>}
            {detail.reversedBy && <div className="alert alert-warning py-2 small mt-2 mb-0">Reversed by {detail.reversedBy.entryNumber}.</div>}
            <table className="table table-sm mt-3 mb-1">
              <thead><tr><th>Account</th><th className="text-end">Debit</th><th className="text-end">Credit</th></tr></thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.account ? `${l.account.code} - ${l.account.name}` : l.accountId}</td>
                    <td className="text-end">{Number(l.debit) > 0 ? formatCurrency(l.debit) : ''}</td>
                    <td className="text-end">{Number(l.credit) > 0 ? formatCurrency(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.status === 'POSTED' && !reversible && detail.sourceType !== 'MANUAL' && (
              <div className="small text-body-secondary mt-2">
                This entry was created by a business transaction ({SOURCE_LABELS[detail.sourceType] || detail.sourceType}); reverse it from that transaction, not here.
              </div>
            )}
            <div className="small mt-2"><Link to="/accounting/opening-balances">Opening balances</Link></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
