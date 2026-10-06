import { useEffect, useState } from 'react';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/StatusBadge';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';

export default function StockTransfers() {
  const { hasPermission } = useAuth();
  const canApprove = hasPermission('STOCK_TRANSFER:APPROVE');

  const [items, setItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [sourceWarehouseId, setSourceWarehouseId] = useState('');
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [saving, setSaving] = useState(false);

  const [receivingId, setReceivingId] = useState(null);
  const [receiveQty, setReceiveQty] = useState({ received: '', short: '', damaged: '' });

  function load() {
    setLoading(true);
    apiClient.get('/stock-transfers').then((res) => setItems(res.data.items)).catch((e) => setError(extractErrorMessage(e))).finally(() => setLoading(false));
  }
  useEffect(load, []);
  useEffect(() => {
    apiClient.get('/warehouses').then((res) => setWarehouses(res.data.items || []));
    apiClient.get('/products', { params: { pageSize: 200 } }).then((res) => setProducts(res.data.items || []));
  }, []);

  async function create() {
    setSaving(true);
    setError('');
    try {
      await apiClient.post('/stock-transfers', {
        sourceWarehouseId,
        destinationWarehouseId,
        items: [{ productId, quantity: Number(quantity) }],
        idempotencyKey: crypto.randomUUID(),
      });
      setShowModal(false);
      setSourceWarehouseId(''); setDestinationWarehouseId(''); setProductId(''); setQuantity(1);
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function act(id, action, body) {
    setError('');
    try {
      await apiClient.post(`/stock-transfers/${id}/${action}`, body || {});
      setNotice(`Transfer ${action}ed.`);
      load();
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  }

  async function submitReceive(transfer) {
    const line = transfer.items[0];
    await act(transfer.id, 'receive', {
      items: [{
        productId: line.productId,
        receivedQuantity: Number(receiveQty.received || 0),
        shortQuantity: Number(receiveQty.short || 0),
        damagedQuantity: Number(receiveQty.damaged || 0),
      }],
    });
    setReceivingId(null);
    setReceiveQty({ received: '', short: '', damaged: '' });
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h4 className="mb-1">Stock Transfers</h4>
          <div className="text-body-secondary small">Request &rarr; Approval &rarr; Dispatch &rarr; In Transit &rarr; Receive &rarr; Completed.</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowModal(true)}>+ New Transfer</button>
      </div>

      {notice && <div className="alert alert-info py-2">{notice}</div>}
      <ErrorAlert message={error} />
      {loading ? <Spinner /> : items.length === 0 ? <EmptyState message="No stock transfers yet." /> : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead><tr><th>#</th><th>From</th><th>To</th><th>Items</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td>{t.transferNumber}</td>
                    <td>{t.sourceWarehouse?.name}</td>
                    <td>{t.destinationWarehouse?.name}</td>
                    <td className="small">{t.items.map((i) => `${i.product.name} x${Number(i.quantity)}`).join(', ')}</td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="d-flex gap-1 flex-wrap">
                      {canApprove && t.status === 'PENDING_APPROVAL' && (
                        <>
                          <button className="btn btn-sm btn-outline-success" onClick={() => act(t.id, 'approve')}>Approve</button>
                          <button className="btn btn-sm btn-outline-danger" onClick={() => act(t.id, 'reject', { reason: 'Not approved' })}>Reject</button>
                        </>
                      )}
                      {t.status === 'APPROVED' && (
                        <button className="btn btn-sm btn-outline-primary" onClick={() => act(t.id, 'dispatch')}>Dispatch</button>
                      )}
                      {t.status === 'IN_TRANSIT' && receivingId !== t.id && (
                        <button className="btn btn-sm btn-outline-primary" onClick={() => setReceivingId(t.id)}>Receive</button>
                      )}
                      {['REQUESTED', 'PENDING_APPROVAL', 'APPROVED'].includes(t.status) && (
                        <button className="btn btn-sm btn-outline-secondary" onClick={() => act(t.id, 'cancel')}>Cancel</button>
                      )}
                      {receivingId === t.id && (
                        <div className="d-flex gap-1 align-items-center mt-1">
                          <input type="number" placeholder="Received" className="form-control form-control-sm" style={{ width: 90 }} value={receiveQty.received} onChange={(e) => setReceiveQty({ ...receiveQty, received: e.target.value })} />
                          <input type="number" placeholder="Short" className="form-control form-control-sm" style={{ width: 80 }} value={receiveQty.short} onChange={(e) => setReceiveQty({ ...receiveQty, short: e.target.value })} />
                          <input type="number" placeholder="Damaged" className="form-control form-control-sm" style={{ width: 80 }} value={receiveQty.damaged} onChange={(e) => setReceiveQty({ ...receiveQty, damaged: e.target.value })} />
                          <button className="btn btn-sm btn-primary" onClick={() => submitReceive(t)}>Confirm</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        show={showModal}
        title="New Stock Transfer"
        onClose={() => setShowModal(false)}
        footer={<button className="btn btn-primary" disabled={!sourceWarehouseId || !destinationWarehouseId || !productId || saving} onClick={create}>{saving ? 'Saving...' : 'Submit'}</button>}
      >
        <div className="mb-3">
          <label className="form-label">Source Warehouse</label>
          <select className="form-select" value={sourceWarehouseId} onChange={(e) => setSourceWarehouseId(e.target.value)}>
            <option value="">Select</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Destination Warehouse</label>
          <select className="form-select" value={destinationWarehouseId} onChange={(e) => setDestinationWarehouseId(e.target.value)}>
            <option value="">Select</option>
            {warehouses.filter((w) => w.id !== sourceWarehouseId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Product</label>
          <select className="form-select" value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Select</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label">Quantity</label>
          <input type="number" min="1" className="form-control" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
      </Modal>
    </div>
  );
}
