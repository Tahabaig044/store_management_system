// Shared debit/credit line editor used by the Journal Entry form and the
// Opening Balance form. Shows live totals; the caller decides what "balanced"
// means for its form (a journal entry must balance; opening balances are
// balanced by an automatic Opening Balance Equity offset).
import { formatCurrency } from '../../utils/currency';

export const emptyLine = () => ({ accountId: '', debit: '', credit: '', description: '' });

export function lineTotals(lines) {
  const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const debit = round(lines.reduce((s, l) => s + Number(l.debit || 0), 0));
  const credit = round(lines.reduce((s, l) => s + Number(l.credit || 0), 0));
  return { debit, credit, difference: round(debit - credit) };
}

// A line is valid when it names an account and has exactly one positive side.
export function lineIsValid(l) {
  return !!l.accountId && (Number(l.debit || 0) > 0) !== (Number(l.credit || 0) > 0);
}

export function toPayload(lines) {
  return lines.map((l) => ({
    accountId: l.accountId,
    ...(Number(l.debit || 0) > 0 ? { debit: Number(l.debit) } : {}),
    ...(Number(l.credit || 0) > 0 ? { credit: Number(l.credit) } : {}),
    ...(l.description ? { description: l.description } : {}),
  }));
}

export default function JournalLinesEditor({ lines, onChange, accounts, footerNote }) {
  function update(i, patch) {
    onChange(lines.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      // Entering one side clears the other - a line is either a debit or a credit.
      if (patch.debit !== undefined && Number(patch.debit) > 0) next.credit = '';
      if (patch.credit !== undefined && Number(patch.credit) > 0) next.debit = '';
      return next;
    }));
  }
  const totals = lineTotals(lines);

  return (
    <div>
      <div className="table-responsive">
        <table className="table table-sm align-middle mb-2">
          <thead>
            <tr>
              <th style={{ minWidth: 220 }}>Account</th>
              <th style={{ width: 130 }} className="text-end">Debit</th>
              <th style={{ width: 130 }} className="text-end">Credit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="form-select form-select-sm" aria-label={`Account ${i + 1}`} value={l.accountId} onChange={(e) => update(i, { accountId: e.target.value })}>
                    <option value="">Select account...</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="number" min="0" step="0.01" className="form-control form-control-sm text-end" aria-label={`Debit ${i + 1}`} value={l.debit} onChange={(e) => update(i, { debit: e.target.value })} />
                </td>
                <td>
                  <input type="number" min="0" step="0.01" className="form-control form-control-sm text-end" aria-label={`Credit ${i + 1}`} value={l.credit} onChange={(e) => update(i, { credit: e.target.value })} />
                </td>
                <td className="text-end">
                  <button type="button" className="btn btn-sm btn-outline-danger" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 1} onClick={() => onChange(lines.filter((_, idx) => idx !== i))}>
                    &times;
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="fw-semibold">
              <td className="text-end">Totals</td>
              <td className="text-end">{formatCurrency(totals.debit)}</td>
              <td className="text-end">{formatCurrency(totals.credit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onChange([...lines, emptyLine()])}>
        + Add line
      </button>
      {footerNote}
    </div>
  );
}
