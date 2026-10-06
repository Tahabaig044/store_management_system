// Phase 2.1: controlled opening-balance entry. Enter the starting balance of
// each account as of a go-live date; any difference between the debits and
// credits you enter is posted automatically to "Opening Balance Equity", so the
// resulting journal entry always balances. Only one opening-balance entry can
// be active - to re-enter, reverse the existing entry first (Journal Entries).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../../api/client';
import { Spinner, ErrorAlert, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency } from '../../utils/currency';
import JournalLinesEditor, { emptyLine, lineTotals, lineIsValid, toPayload } from './JournalLinesEditor';

export default function OpeningBalances() {
  const { hasPermission } = useAuth();
  const canPost = hasPermission('OPENING_BALANCE:CREATE');

  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([emptyLine()]);

  function load() {
    setLoading(true);
    Promise.all([apiClient.get('/accounting/opening-balances'), apiClient.get('/accounting/accounts')])
      .then(([s, a]) => {
        setStatus(s.data);
        setAccounts(a.data.items);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  // The system equity account is calculated for you - it can't be entered.
  const selectable = accounts.filter((a) => a.systemKey !== 'OPENING_BALANCE_EQUITY');
  const totals = lineTotals(lines);
  const valid = lines.length >= 1 && lines.every(lineIsValid);
  const equityAccount = accounts.find((a) => a.systemKey === 'OPENING_BALANCE_EQUITY');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/accounting/opening-balances', { asOfDate: new Date(asOfDate).toISOString(), memo: memo || undefined, lines: toPayload(lines) });
      setNotice('Opening balances posted.');
      setLines([emptyLine()]);
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div>
      <h4 className="mb-3">Opening Balances</h4>
      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />

      {status?.posted ? (
        <div className="card">
          <div className="card-body">
            <div className="alert alert-success py-2">
              Opening balances were posted on {new Date(status.active.date).toLocaleDateString()} as entry <strong>{status.active.entryNumber}</strong>.
            </div>
            <table className="table table-sm mb-2">
              <thead><tr><th>Account</th><th className="text-end">Debit</th><th className="text-end">Credit</th></tr></thead>
              <tbody>
                {status.active.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.account.code} - {l.account.name}</td>
                    <td className="text-end">{Number(l.debit) > 0 ? formatCurrency(l.debit) : ''}</td>
                    <td className="text-end">{Number(l.credit) > 0 ? formatCurrency(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="small text-body-secondary">
              Opening balances can only be posted once. To correct them, reverse this entry from <Link to="/accounting/journal-entries">Journal Entries</Link> and enter them again.
            </div>
          </div>
        </div>
      ) : !canPost ? (
        <div className="alert alert-secondary">Opening balances have not been posted yet. Only a tenant administrator can post them.</div>
      ) : (
        <form className="card" onSubmit={submit}>
          <div className="card-body">
            <p className="text-body-secondary small">
              Enter each account's balance at the go-live date. Assets and expenses normally carry a debit balance; liabilities, equity and revenue a credit balance.
              The difference is posted to {equityAccount ? `${equityAccount.code} - ${equityAccount.name}` : 'Opening Balance Equity'} automatically.
            </p>
            <div className="row g-2 mb-3">
              <div className="col-md-4">
                <label className="form-label">As of date</label>
                <input type="date" className="form-control" required value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
              </div>
              <div className="col-md-8">
                <label className="form-label">Description</label>
                <input className="form-control" placeholder="Opening balances" value={memo} onChange={(e) => setMemo(e.target.value)} />
              </div>
            </div>
            <JournalLinesEditor
              lines={lines}
              onChange={setLines}
              accounts={selectable}
              footerNote={
                <div className="mt-2 small" role="status">
                  {totals.difference === 0
                    ? 'Debits equal credits - no equity offset needed.'
                    : `Opening Balance Equity will be ${totals.difference > 0 ? 'credited' : 'debited'} ${formatCurrency(Math.abs(totals.difference))}.`}
                </div>
              }
            />
          </div>
          <div className="card-footer text-end">
            <button className="btn btn-primary" type="submit" disabled={saving || !valid}>{saving ? 'Posting...' : 'Post Opening Balances'}</button>
          </div>
        </form>
      )}
    </div>
  );
}
