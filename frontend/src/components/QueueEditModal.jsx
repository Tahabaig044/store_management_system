// Phase 3.3: edit a queued (not yet accepted) transaction, or fix a conflicted one by editing it.
// The rules of what may be edited live in offline/editing.js; this is only the form.
import { useMemo, useState } from 'react';
import Modal from './Modal';
import { EDIT_SPECS, editability, suggestEdit, updateQueuedEntry } from '../offline/editing';
import { retryEntry } from '../offline/syncCoordinator';
import { useLiveCustomers, useLiveSuppliers, useLiveProducts } from '../offline/useOfflineData';
import { describeFailure } from '../offline/syncCore';

const clone = (v) => JSON.parse(JSON.stringify(v));

function Field({ def, value, onChange, parties }) {
  const id = `edit-${def.key}`;
  if (def.type === 'boolean') {
    return (
      <div className="form-check mb-2">
        <input id={id} className="form-check-input" type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <label className="form-check-label" htmlFor={id}>{def.label}</label>
      </div>
    );
  }
  return (
    <div className="mb-2">
      <label className="form-label mb-1 small" htmlFor={id}>{def.label}</label>
      {def.type === 'select' && (
        <select id={id} className="form-select form-select-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {def.type === 'party' && (
        <select id={id} className="form-select form-select-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{def.party === 'customers' ? 'Walk-in / none' : 'None'}</option>
          {(parties[def.party] || []).map((p) => <option key={p.id} value={p.id}>{p.name}{p._pendingSync ? ' (not synced yet)' : ''}</option>)}
        </select>
      )}
      {def.type === 'number' && <input id={id} type="number" step="any" className="form-control form-control-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />}
      {def.type === 'text' && <input id={id} className="form-control form-control-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />}
      {def.type === 'textarea' && <textarea id={id} rows={2} className="form-control form-control-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export default function QueueEditModal({ show, item, tenantId, onClose }) {
  const spec = item ? EDIT_SPECS[item.tableName] : null;
  const customers = useLiveCustomers(tenantId);
  const suppliers = useLiveSuppliers(tenantId);
  const products = useLiveProducts(tenantId);
  const [draft, setDraft] = useState(() => (item ? clone(item.payload) : null));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [confirmEventTime, setConfirmEventTime] = useState(false);

  const can = useMemo(() => (item ? editability(item.tableName, item) : { ok: false }), [item]);
  const guidance = item ? describeFailure(item.failure) : null;
  const suggested = useMemo(() => (item ? suggestEdit(item.tableName, item) : null), [item]);
  const nameOf = (line) => products.find((p) => p.id === line.productId)?.name || item?.display?.lines?.[line.saleItemId || line.purchaseItemId] || item?.display?.documents?.[line.documentId] || line.name || line.productId || line.saleItemId || line.purchaseItemId || line.documentId;

  if (!show || !item || !spec) return null;

  const parties = { customers, suppliers };
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const setLine = (i, key, value) => setDraft((d) => ({ ...d, [spec.lines.key]: d[spec.lines.key].map((l, n) => (n === i ? { ...l, [key]: value } : l)) }));
  const removeLine = (i) => setDraft((d) => ({ ...d, [spec.lines.key]: d[spec.lines.key].filter((_, n) => n !== i) }));

  function applySuggestion() {
    if (!suggested || suggested.discard) return;
    setDraft(clone(suggested.payload));
    setSuggestion(suggested);
    setError('');
  }

  async function check() {
    setError('');
    try {
      await retryEntry(tenantId, item.tableName, item.clientId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const changesTime = Boolean(suggestion?.changesEventTime);
      if (changesTime && !confirmEventTime) throw new Error('Confirm that this should be recorded with a different date.');
      await updateQueuedEntry(tenantId, item.tableName, item.clientId, draft, { allowEventTimeChange: changesTime, note: suggestion?.summary });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      show
      title={`Edit ${spec.label}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {can.ok && <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save and retry'}</button>}
        </>
      }
    >
      {guidance && (
        <div className="alert alert-danger py-2 small" data-testid="edit-conflict">
          <div className="fw-semibold">{guidance.title}</div>
          <div>{guidance.detail}</div>
        </div>
      )}
      {!can.ok && (
        <div className="alert alert-warning py-2 small" role="alert" data-testid="edit-blocked">
          {can.reason}
          {can.needsCheck && <div className="mt-2"><button className="btn btn-sm btn-outline-primary" onClick={check}>Check now</button></div>}
        </div>
      )}
      {can.ok && suggested && !suggested.discard && (
        <div className="alert alert-info py-2 small d-flex justify-content-between align-items-center" data-testid="edit-suggestion">
          <span>Suggested fix: {suggested.summary}</span>
          <button className="btn btn-sm btn-outline-primary" onClick={applySuggestion}>Apply suggestion</button>
        </div>
      )}
      {can.ok && suggested?.discard && <div className="alert alert-warning py-2 small">{suggested.summary}</div>}
      {suggestion?.changesEventTime && (
        <div className="form-check mb-2">
          <input id="confirm-time" className="form-check-input" type="checkbox" checked={confirmEventTime} onChange={(e) => setConfirmEventTime(e.target.checked)} />
          <label className="form-check-label small" htmlFor="confirm-time">I confirm this is recorded with today's date instead of the day it happened (this is logged).</label>
        </div>
      )}
      {error && <div className="alert alert-danger py-2 small" role="alert" data-testid="edit-error">{error}</div>}

      {can.ok && draft && (
        <>
          <div className="row g-2">
            {(spec.fields || []).map((f) => (
              <div className="col-md-6" key={f.key}>
                <Field def={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} parties={parties} />
              </div>
            ))}
          </div>
          {spec.lines && (
            <table className="table table-sm align-middle mt-2">
              <thead><tr><th>{spec.lines.label}</th>{spec.lines.columns.map((c) => <th key={c.key}>{c.label}</th>)}<th /></tr></thead>
              <tbody>
                {(draft[spec.lines.key] || []).map((line, i) => (
                  <tr key={i}>
                    <td>{nameOf(line)}</td>
                    {spec.lines.columns.map((c) => (
                      <td key={c.key} style={{ width: 120 }}>
                        <input aria-label={`${c.label} ${i + 1}`} type="number" step="any" className="form-control form-control-sm" value={line[c.key] ?? ''} onChange={(e) => setLine(i, c.key, e.target.value === '' ? '' : Number(e.target.value))} />
                      </td>
                    ))}
                    <td>{draft[spec.lines.key].length > spec.lines.minLines && <button className="btn btn-sm btn-outline-danger" onClick={() => removeLine(i)}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {(item.revisions || []).length > 0 && (
        <div className="small text-body-secondary mt-3" data-testid="edit-history">
          <div className="fw-semibold">Earlier edits</div>
          {item.revisions.map((r) => (
            <div key={r.at}>{new Date(r.at).toLocaleString()} - {r.changes.map((c) => `${c.path}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join('; ')}{r.resolved ? ` (was: ${r.resolved.kind})` : ''}</div>
          ))}
        </div>
      )}
    </Modal>
  );
}
