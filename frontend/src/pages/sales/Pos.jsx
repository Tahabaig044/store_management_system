import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Modal from '../../components/Modal';
import { ErrorAlert, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { refreshCaches, OUTBOXES } from '../../offline/syncEngine';
import { useLiveProducts, useLiveCustomers } from '../../offline/useOfflineData';
import StockFreshnessNotice from '../../components/StockFreshnessNotice';
import { PAYMENT_METHODS } from '../../constants/paymentMethods';
import { formatCurrency } from '../../utils/currency';
import {
  FiSearch,
  FiShoppingCart,
  FiTrash2,
  FiUser,
  FiTag,
  FiPercent,
  FiCreditCard,
  FiPackage,
} from 'react-icons/fi';

export default function Pos() {
  const { user } = useAuth();
  const tenantId = user?.tenantId;

  // Live-reads from the local cache - automatically reflects optimistic
  // stock changes, completed syncs, and cache refreshes without any manual
  // re-fetch wiring, whether they happen from this tab or the sync engine
  // running in the background.
  const products = useLiveProducts(tenantId);
  const customers = useLiveCustomers(tenantId);

  // Phase 5.2: arriving from Appointments' "Bill Visit" link (?appointmentId=&customerId=)
  // pre-selects the customer and tags the sale as billing that clinical visit -
  // otherwise this screen behaves exactly as the plain retail POS it always was.
  const [searchParams] = useSearchParams();
  const appointmentId = searchParams.get('appointmentId') || undefined;

  const [search, setSearch] = useState('');
  const searchInputRef = useRef(null);
  const [cart, setCart] = useState([]); // { productId, name, unitPrice, quantity, discount, maxStock }
  const [customerId, setCustomerId] = useState(searchParams.get('customerId') || '');
  const [discount, setDiscount] = useState(0);
  const [tax, setTax] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [amountPaid, setAmountPaid] = useState('');
  const [error, setError] = useState('');
  const [checkingOut, setCheckingOut] = useState(false);
  const [receipt, setReceipt] = useState(null);

  // Refresh the local cache from the server whenever we're online and this
  // screen mounts - this is what lets the same POS screen work identically
  // online or offline (it always renders from the cache via the hooks above).
  useEffect(() => {
    if (!tenantId || !navigator.onLine) return;
    refreshCaches(tenantId).catch((err) => {
      console.warn('Could not refresh offline cache, using last known data:', err);
    });
  }, [tenantId]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.barcode?.toLowerCase().includes(q)
    );
  }, [products, search]);

  // USB/Bluetooth barcode scanners behave like a keyboard: they type the
  // barcode into whatever input is focused and send Enter at the end. The
  // search box doubles as the scan target - an exact barcode match on Enter
  // adds straight to cart; anything else (a partial/name/SKU search) is left
  // alone so normal searching keeps working exactly as before.
  function handleSearchKeyDown(e) {
    if (e.key !== 'Enter') return;
    const term = search.trim();
    if (!term) return;

    const match = products.find((p) => p.barcode && p.barcode.trim() === term);
    if (!match) return;

    if (Number(match.stockQuantity) <= 0) {
      setError(`${match.name} is out of stock.`);
      return;
    }

    setError('');
    addToCart(match);
    setSearch('');
    searchInputRef.current?.focus();
  }

  function addToCart(product) {
    setCart((c) => {
      const existing = c.find((l) => l.productId === product.id);
      if (existing) {
        return c.map((l) => (l.productId === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...c,
        {
          productId: product.id,
          name: product.name,
          unitPrice: Number(product.sellingPrice),
          quantity: 1,
          discount: 0,
          maxStock: Number(product.stockQuantity),
        },
      ];
    });
  }

  function updateLine(productId, field, value) {
    setCart((c) => c.map((l) => (l.productId === productId ? { ...l, [field]: value } : l)));
  }
  function removeLine(productId) {
    setCart((c) => c.filter((l) => l.productId !== productId));
  }

  const subtotal = useMemo(
    () => cart.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(l.unitPrice || 0) - Number(l.discount || 0), 0),
    [cart]
  );
  const total = Math.max(subtotal - Number(discount || 0) + Number(tax || 0), 0);

  // A cart line may exceed what this device last saw in stock (another
  // device could have sold it since, or stock simply ran low). We still let
  // the sale be queued - the server is the sole authority on whether it's
  // actually allowed - but the cashier gets a heads-up either way.
  const overStock = cart.some((l) => Number(l.quantity) > l.maxStock);

  async function checkout() {
    setError('');
    if (cart.length === 0) return;
    setCheckingOut(true);
    try {
      const payload = {
        customerId: customerId || undefined,
        appointmentId,
        items: cart.map((l) => ({
          productId: l.productId,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          discount: Number(l.discount || 0),
        })),
        discount: Number(discount || 0),
        tax: Number(tax || 0),
        amountPaid: amountPaid === '' ? undefined : Number(amountPaid),
        paymentMethod,
      };

      const finalEntry = await OUTBOXES.sales.submit(tenantId, payload);

      if (finalEntry.status === 'conflict' || finalEntry.status === 'failed') {
        setError(`Sale could not be completed: ${finalEntry.lastError}`);
      } else {
        setReceipt(finalEntry);
        setCart([]);
        setCustomerId('');
        setDiscount(0);
        setTax(0);
        setAmountPaid('');
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setCheckingOut(false);
    }
  }

  return (
    <div className="row g-3">
      <div className="col-lg-7">
        <div className="mb-3">
          <h4 className="mb-1">Point of Sale</h4>
          <div className="text-body-secondary small">Tap a product to add it to the cart</div>
        </div>
        <StockFreshnessNotice tenantId={tenantId} />
        <div className="search-input-wrap mb-3">
          <FiSearch size={15} />
          <input
            ref={searchInputRef}
            className="form-control"
            placeholder="Search or scan product by name, SKU, barcode..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            autoFocus
          />
        </div>
        <div className="row g-2" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
          {filteredProducts.map((p) => {
            const outOfStock = Number(p.stockQuantity) <= 0;
            const lowStock = !outOfStock && Number(p.stockQuantity) <= Number(p.lowStockThreshold ?? 0);
            return (
              <div className="col-md-4" key={p.id}>
                <button type="button" className="product-card" disabled={outOfStock} onClick={() => addToCart(p)}>
                  <div className="d-flex align-items-start justify-content-between">
                    <div className="product-card-icon">
                      <FiPackage />
                    </div>
                    <span className={`badge rounded-pill text-bg-${outOfStock ? 'secondary' : lowStock ? 'warning' : 'light'} text-body`}>
                      {outOfStock ? 'Out of stock' : `${Number(p.stockQuantity)} in stock`}
                    </span>
                  </div>
                  <div className="product-card-name">{p.name}</div>
                  <div className="product-card-price">{formatCurrency(p.sellingPrice)}</div>
                </button>
              </div>
            );
          })}
          {filteredProducts.length === 0 && (
            <p className="text-body-secondary">No cached products match. Connect to the internet at least once to load the catalog.</p>
          )}
        </div>
      </div>

      <div className="col-lg-5">
        <div className="card cart-panel">
          <div className="card-header d-flex align-items-center gap-2">
            <FiShoppingCart /> Cart {cart.length > 0 && <span className="badge rounded-pill text-bg-primary">{cart.length}</span>}
          </div>
          <div className="card-body d-flex flex-column gap-2" style={{ maxHeight: '40vh', overflowY: 'auto' }}>
            <ErrorAlert message={error} />
            {overStock && (
              <div className="alert alert-warning py-2 small">
                One or more items exceed the last known stock on this device. The sale can still be completed, but may be
                flagged as a conflict if stock has genuinely run out.
              </div>
            )}
            {cart.length === 0 && (
              <div className="cart-empty">
                <FiShoppingCart size={28} className="opacity-50" />
                <span>Cart is empty</span>
              </div>
            )}
            {cart.map((l) => {
              const lineTotal = Number(l.quantity || 0) * Number(l.unitPrice || 0) - Number(l.discount || 0);
              return (
                <div key={l.productId} className="cart-line">
                  <div className="d-flex align-items-start justify-content-between mb-2">
                    <div className="small fw-semibold">{l.name}</div>
                    <div className="d-flex align-items-center gap-2">
                      <span className="small fw-semibold">{formatCurrency(lineTotal)}</span>
                      <button className="btn btn-sm btn-outline-danger d-flex align-items-center" onClick={() => removeLine(l.productId)} title="Remove">
                        <FiTrash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="d-flex gap-2">
                    <div className="cart-line-field" style={{ width: 70 }}>
                      <label>Qty</label>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        className="form-control form-control-sm"
                        value={l.quantity}
                        onChange={(e) => updateLine(l.productId, 'quantity', e.target.value)}
                      />
                    </div>
                    <div className="cart-line-field" style={{ width: 90 }}>
                      <label>Price</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="form-control form-control-sm"
                        value={l.unitPrice}
                        onChange={(e) => updateLine(l.productId, 'unitPrice', e.target.value)}
                      />
                    </div>
                    <div className="cart-line-field" style={{ width: 80 }}>
                      <label>Discount</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="form-control form-control-sm"
                        value={l.discount}
                        onChange={(e) => updateLine(l.productId, 'discount', e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="card-footer">
            {appointmentId && (
              <div className="alert alert-info py-1 px-2 small mb-2">Billing clinical visit - this sale will be linked to that appointment.</div>
            )}
            <div className="mb-2">
              <label className="form-label small mb-0 d-flex align-items-center gap-1">
                <FiUser size={12} /> Customer (optional)
              </label>
              <select className="form-select form-select-sm" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Walk-in</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="row g-2 mb-2">
              <div className="col-4">
                <label className="form-label small mb-0 d-flex align-items-center gap-1">
                  <FiTag size={12} /> Discount
                </label>
                <input type="number" min="0" step="0.01" className="form-control form-control-sm" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </div>
              <div className="col-4">
                <label className="form-label small mb-0 d-flex align-items-center gap-1">
                  <FiPercent size={12} /> Tax
                </label>
                <input type="number" min="0" step="0.01" className="form-control form-control-sm" value={tax} onChange={(e) => setTax(e.target.value)} />
              </div>
              <div className="col-4">
                <label className="form-label small mb-0 d-flex align-items-center gap-1">
                  <FiCreditCard size={12} /> Method
                </label>
                <select className="form-select form-select-sm" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mb-3">
              <label className="form-label small mb-0">Amount Paid (blank = full)</label>
              <input type="number" min="0" step="0.01" className="form-control form-control-sm" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
            </div>
            <div className="total-box d-flex justify-content-between align-items-center mb-3">
              <span className="fw-semibold">Total</span>
              <span className="fs-4 fw-bold" style={{ color: 'var(--akvf-primary)' }}>{formatCurrency(total)}</span>
            </div>
            <button className="btn btn-primary w-100 py-2" disabled={cart.length === 0 || checkingOut} onClick={checkout}>
              {checkingOut ? 'Processing...' : 'Complete Sale'}
            </button>
          </div>
        </div>
      </div>

      <Modal
        show={!!receipt}
        title={receipt?.status === 'synced' ? 'Sale Completed' : 'Sale Queued'}
        onClose={() => setReceipt(null)}
        footer={
          <button className="btn btn-primary" onClick={() => setReceipt(null)}>
            Close
          </button>
        }
      >
        {receipt && (
          <div>
            {receipt.status === 'synced' ? (
              <>
                <p className="fw-bold">Invoice: {receipt.serverResult.invoiceNumber}</p>
                <ul className="list-unstyled">
                  {receipt.serverResult.items.map((i) => (
                    <li key={i.id} className="d-flex justify-content-between">
                      <span>Qty {Number(i.quantity)}</span>
                      <span>{formatCurrency(i.lineTotal)}</span>
                    </li>
                  ))}
                </ul>
                <hr />
                <div className="d-flex justify-content-between fw-bold">
                  <span>Total</span>
                  <span>{formatCurrency(receipt.serverResult.total)}</span>
                </div>
              </>
            ) : (
              <>
                <div className="alert alert-info mb-3">
                  This sale is saved on this device and will sync automatically once you're back online. You can check
                  its status any time from the sync badge in the top bar.
                </div>
                <ul className="list-unstyled">
                  {receipt.payload.items.map((i, idx) => (
                    <li key={idx} className="d-flex justify-content-between">
                      <span>Qty {i.quantity}</span>
                      <span>{formatCurrency(i.quantity * i.unitPrice - (i.discount || 0))}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
