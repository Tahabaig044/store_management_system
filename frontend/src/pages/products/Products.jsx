import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import JsBarcode from 'jsbarcode';
import apiClient from '../../api/client';
import Modal from '../../components/Modal';
import Pagination from '../../components/Pagination';
import { Spinner, ErrorAlert, EmptyState, extractErrorMessage } from '../../components/Feedback';
import { useAuth } from '../../context/AuthContext';
import { formatCurrency } from '../../utils/currency';

// Internal-use barcode value derived from the product's own (already-unique)
// database id - deterministic and collision-free without needing a random
// value or a separate sequence counter. The "20" prefix follows the GS1
// convention for in-store/internal-use barcodes, so it's never mistaken for
// a real manufacturer EAN/UPC code. Always a numeric string; never parsed
// back to a Number anywhere, so leading zeros from the padStart survive.
function generateBarcodeValue(product) {
  const hex = product.id.replace(/-/g, '').slice(0, 8);
  const digits = parseInt(hex, 16).toString().padStart(10, '0');
  return `20${digits}`;
}

const emptyForm = {
  categoryId: '',
  type: 'GENERAL',
  // Phase 0.2: universal fields - see docs/phase0-2-frontend-ui-architecture.md.
  productKind: 'PHYSICAL_GOOD',
  brand: '',
  // Phase 1.5: optional structured references to the Brand/Unit catalogs,
  // alongside the free-text brand/unit fields above.
  brandId: '',
  unitId: '',
  name: '',
  sku: '',
  barcode: '',
  purchasePrice: 0,
  sellingPrice: 0,
  openingStock: 0,
  lowStockThreshold: 0,
  unit: 'pcs',
  frameBrand: '',
  frameColor: '',
  lensType: '',
  lensMaterial: '',
  batchNumber: '',
  expiryDate: '',
};

// Phase 0.2: default assumed for sessions/localStorage predating the tenant
// object being available, so existing Optical/Medical tenants see no change
// in behavior. See docs/phase0-2-architecture-package.md ADR-4.
const DEFAULT_INDUSTRY_PACKS = ['OPTICAL', 'MEDICINE'];

export default function Products() {
  const { tenant, hasPermission } = useAuth();
  // Phase 0.4: driven by effective permissions (PRODUCT:CREATE/UPDATE/
  // DELETE), not a hardcoded role list - see docs/phase0-4-authorization-architecture.md.
  // Behaviorally identical today (the seeded catalog grants all three to
  // the same roles CAN_MANAGE used to name), but now sourced from the
  // centralized model instead of a page-local constant.
  const canCreate = hasPermission('PRODUCT:CREATE');
  const canManage = canCreate || hasPermission('PRODUCT:UPDATE') || hasPermission('PRODUCT:DELETE');
  // Phase 0.2: which industry-specific field sets to show - see
  // docs/phase0-2-frontend-ui-architecture.md.
  const enabledIndustryPacks = tenant?.enabledIndustryPacks || DEFAULT_INDUSTRY_PACKS;
  const hasOptical = enabledIndustryPacks.includes('OPTICAL');
  const hasMedicine = enabledIndustryPacks.includes('MEDICINE');

  // Lets other pages (e.g. the Business Command Center's Low Stock / Expiring
  // Medicines widgets) deep-link here pre-filtered, via ?lowStock=1 / ?type=MEDICINE.
  const [searchParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [type, setType] = useState(searchParams.get('type') || '');
  const [lowStockOnly, setLowStockOnly] = useState(searchParams.get('lowStock') === '1');
  const [showInactive, setShowInactive] = useState(false);
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  const [adjustProduct, setAdjustProduct] = useState(null);
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustNote, setAdjustNote] = useState('');

  const [productKind, setProductKind] = useState('');
  const [variantsProduct, setVariantsProduct] = useState(null);
  const [variants, setVariants] = useState([]);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [variantsError, setVariantsError] = useState('');
  const [variantForm, setVariantForm] = useState({ name: '', sku: '', barcode: '', priceOverride: '', stockQuantity: '' });

  const barcodePreviewRef = useRef(null);

  const pageSize = 20;

  function load() {
    setLoading(true);
    apiClient
      .get('/products', {
        params: {
          page,
          pageSize,
          search: search || undefined,
          type: type || undefined,
          productKind: productKind || undefined,
          lowStockOnly: lowStockOnly || undefined,
          includeInactive: showInactive || undefined,
        },
      })
      .then((res) => {
        setItems(res.data.items);
        setTotal(res.data.total);
      })
      .catch((err) => setError(extractErrorMessage(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, [page, search, type, productKind, lowStockOnly, showInactive]);
  useEffect(() => {
    apiClient.get('/categories', { params: { pageSize: 100 } }).then((res) => setCategories(res.data.items));
    apiClient.get('/brands', { params: { pageSize: 100 } }).then((res) => setBrands(res.data.items));
    apiClient.get('/units', { params: { pageSize: 100 } }).then((res) => setUnits(res.data.items));
  }, []);

  function openCreate() {
    setEditingProduct(null);
    setForm(emptyForm);
    setShowModal(true);
  }

  function openEdit(p) {
    setEditingProduct(p);
    setForm({
      categoryId: p.categoryId || '',
      type: p.type,
      productKind: p.productKind || 'PHYSICAL_GOOD',
      brand: p.brand || '',
      brandId: p.brandId || '',
      unitId: p.unitId || '',
      name: p.name || '',
      sku: p.sku || '',
      barcode: p.barcode || '',
      purchasePrice: Number(p.purchasePrice),
      sellingPrice: Number(p.sellingPrice),
      openingStock: 0,
      lowStockThreshold: Number(p.lowStockThreshold),
      unit: p.unit || 'pcs',
      frameBrand: p.frameBrand || '',
      frameColor: p.frameColor || '',
      lensType: p.lensType || '',
      lensMaterial: p.lensMaterial || '',
      batchNumber: p.batchNumber || '',
      expiryDate: p.expiryDate ? p.expiryDate.slice(0, 10) : '',
    });
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingProduct(null);
    setForm(emptyForm);
  }

  // Keeps the on-screen barcode preview in sync with the form's barcode
  // value (typed, generated, or loaded from an existing product).
  useEffect(() => {
    if (!showModal || !form.barcode || !barcodePreviewRef.current) return;
    try {
      JsBarcode(barcodePreviewRef.current, form.barcode, {
        format: 'CODE128',
        displayValue: false,
        width: 2,
        height: 50,
        margin: 4,
      });
    } catch {
      // A manually-typed barcode can contain characters CODE128 can't encode -
      // leave the previous preview rather than crashing the form.
    }
  }, [showModal, form.barcode]);

  function handleGenerateBarcode() {
    if (!editingProduct) return;
    if (form.barcode) {
      const confirmed = window.confirm(
        `This product already has a barcode (${form.barcode}). Generating a new one will replace it once you save - anything already printed with the old code will stop matching. Continue?`
      );
      if (!confirmed) return;
    }
    setForm((f) => ({ ...f, barcode: generateBarcodeValue(editingProduct) }));
  }

  function handlePrintBarcode() {
    if (!form.barcode || !barcodePreviewRef.current) return;
    const svgMarkup = barcodePreviewRef.current.outerHTML;

    const printWindow = window.open('', '_blank', 'width=420,height=320');
    if (!printWindow) {
      setError("Could not open the print window - check your browser's popup blocker.");
      return;
    }
    const doc = printWindow.document;
    doc.title = `Barcode - ${form.name}`;

    const style = doc.createElement('style');
    style.textContent = `
      body { font-family: sans-serif; text-align: center; padding: 16px; margin: 0; }
      .label { display: inline-block; border: 1px solid #ccc; border-radius: 6px; padding: 14px 18px; margin-top: 16px; }
      .name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
      .code { font-size: 12px; letter-spacing: 1px; margin-top: 4px; }
      .sku { font-size: 11px; color: #666; margin-top: 2px; }
    `;
    doc.head.appendChild(style);

    const label = doc.createElement('div');
    label.className = 'label';

    const nameEl = doc.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = form.name;
    label.appendChild(nameEl);

    const svgWrap = doc.createElement('div');
    svgWrap.innerHTML = svgMarkup; // trusted markup generated by JsBarcode, not user input
    label.appendChild(svgWrap);

    const codeEl = doc.createElement('div');
    codeEl.className = 'code';
    codeEl.textContent = form.barcode;
    label.appendChild(codeEl);

    if (form.sku) {
      const skuEl = doc.createElement('div');
      skuEl.className = 'sku';
      skuEl.textContent = `SKU: ${form.sku}`;
      label.appendChild(skuEl);
    }

    doc.body.appendChild(label);
    printWindow.focus();
    setTimeout(() => printWindow.print(), 150);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { openingStock, ...rest } = form;
      const payload = {
        ...rest,
        categoryId: form.categoryId || undefined,
        purchasePrice: Number(form.purchasePrice),
        sellingPrice: Number(form.sellingPrice),
        lowStockThreshold: Number(form.lowStockThreshold),
        expiryDate: form.expiryDate || undefined,
        brandId: form.brandId || undefined,
        unitId: form.unitId || undefined,
      };
      if (editingProduct) {
        await apiClient.patch(`/products/${editingProduct.id}`, payload);
        closeModal();
        load();
      } else {
        await apiClient.post('/products', { ...payload, openingStock: Number(openingStock) });
        closeModal();
        setPage(1);
        load();
      }
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(p) {
    setError('');
    try {
      if (p.isActive) {
        await apiClient.delete(`/products/${p.id}`);
      } else {
        await apiClient.patch(`/products/${p.id}`, { isActive: true });
      }
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  function openVariants(p) {
    setVariantsProduct(p);
    setVariantsError('');
    setVariantForm({ name: '', sku: '', barcode: '', priceOverride: '', stockQuantity: '' });
    loadVariants(p.id);
  }

  function loadVariants(productId) {
    setVariantsLoading(true);
    apiClient
      .get(`/products/${productId}/variants`)
      .then((res) => setVariants(res.data.items))
      .catch((err) => setVariantsError(extractErrorMessage(err)))
      .finally(() => setVariantsLoading(false));
  }

  async function addVariant(e) {
    e.preventDefault();
    setVariantsError('');
    try {
      await apiClient.post(`/products/${variantsProduct.id}/variants`, {
        name: variantForm.name,
        sku: variantForm.sku || undefined,
        barcode: variantForm.barcode || undefined,
        priceOverride: variantForm.priceOverride ? Number(variantForm.priceOverride) : undefined,
        stockQuantity: variantForm.stockQuantity ? Number(variantForm.stockQuantity) : undefined,
      });
      setVariantForm({ name: '', sku: '', barcode: '', priceOverride: '', stockQuantity: '' });
      loadVariants(variantsProduct.id);
    } catch (err) {
      setVariantsError(extractErrorMessage(err));
    }
  }

  async function toggleVariantActive(v) {
    setVariantsError('');
    try {
      if (v.isActive) {
        await apiClient.delete(`/products/${variantsProduct.id}/variants/${v.id}`);
      } else {
        await apiClient.patch(`/products/${variantsProduct.id}/variants/${v.id}`, { isActive: true });
      }
      loadVariants(variantsProduct.id);
    } catch (err) {
      setVariantsError(extractErrorMessage(err));
    }
  }

  async function handleAdjust(e) {
    e.preventDefault();
    if (!adjustProduct) return;
    setError('');
    try {
      await apiClient.post(`/products/${adjustProduct.id}/adjust-stock`, {
        quantity: Number(adjustQty),
        note: adjustNote || undefined,
      });
      setAdjustProduct(null);
      setAdjustQty('');
      setAdjustNote('');
      load();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Products</h4>
        {canCreate && (
          <button className="btn btn-primary" onClick={openCreate}>
            + New Product
          </button>
        )}
      </div>

      <div className="d-flex flex-wrap gap-2 mb-3">
        <input
          className="form-control"
          style={{ maxWidth: 260 }}
          placeholder="Search name, SKU, barcode..."
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
        <select
          className="form-select"
          style={{ maxWidth: 180 }}
          value={type}
          onChange={(e) => {
            setPage(1);
            setType(e.target.value);
          }}
        >
          <option value="">All Types</option>
          <option value="GENERAL">General</option>
          {hasMedicine && <option value="MEDICINE">Medicine</option>}
          {hasOptical && <option value="FRAME">Frame</option>}
          {hasOptical && <option value="LENS">Lens</option>}
        </select>
        <select
          className="form-select"
          style={{ maxWidth: 160 }}
          value={productKind}
          onChange={(e) => {
            setPage(1);
            setProductKind(e.target.value);
          }}
        >
          <option value="">All Kinds</option>
          <option value="PHYSICAL_GOOD">Physical Goods</option>
          <option value="SERVICE">Services</option>
        </select>
        <div className="form-check align-self-center">
          <input
            className="form-check-input"
            type="checkbox"
            id="lowStockOnly"
            checked={lowStockOnly}
            onChange={(e) => {
              setPage(1);
              setLowStockOnly(e.target.checked);
            }}
          />
          <label className="form-check-label" htmlFor="lowStockOnly">
            Low stock only
          </label>
        </div>
        {canManage && (
          <div className="form-check align-self-center">
            <input
              className="form-check-input"
              type="checkbox"
              id="showInactive"
              checked={showInactive}
              onChange={(e) => {
                setPage(1);
                setShowInactive(e.target.checked);
              }}
            />
            <label className="form-check-label" htmlFor="showInactive">
              Show deactivated
            </label>
          </div>
        )}
      </div>

      <ErrorAlert message={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState message="No products found." />
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Category</th>
                  <th>SKU</th>
                  <th className="text-end">Stock</th>
                  <th className="text-end">Purchase</th>
                  <th className="text-end">Selling</th>
                  {showInactive && <th>Status</th>}
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const low = Number(p.stockQuantity) <= Number(p.lowStockThreshold);
                  return (
                    <tr key={p.id} className={!p.isActive ? 'opacity-50' : ''}>
                      <td>{p.name}</td>
                      <td>{p.type}</td>
                      <td>{p.category?.name || '-'}</td>
                      <td>{p.sku || '-'}</td>
                      <td className={`text-end ${low ? 'text-danger fw-semibold' : ''}`}>{Number(p.stockQuantity)}</td>
                      <td className="text-end">{formatCurrency(p.purchasePrice)}</td>
                      <td className="text-end">{formatCurrency(p.sellingPrice)}</td>
                      {showInactive && (
                        <td>
                          <span className={`badge text-bg-${p.isActive ? 'success' : 'secondary'}`}>
                            {p.isActive ? 'Active' : 'Deactivated'}
                          </span>
                        </td>
                      )}
                      {canManage && (
                        <td className="d-flex gap-1">
                          <button className="btn btn-sm btn-outline-primary" onClick={() => openEdit(p)}>
                            Edit
                          </button>
                          <button className="btn btn-sm btn-outline-secondary" onClick={() => setAdjustProduct(p)}>
                            Adjust Stock
                          </button>
                          <button className="btn btn-sm btn-outline-secondary" onClick={() => openVariants(p)}>
                            Variants
                          </button>
                          <button
                            className={`btn btn-sm btn-outline-${p.isActive ? 'danger' : 'success'}`}
                            onClick={() => toggleActive(p)}
                          >
                            {p.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-footer">
            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />
          </div>
        </div>
      )}

      <Modal
        show={showModal}
        title={editingProduct ? 'Edit Product' : 'New Product'}
        size="lg"
        onClose={closeModal}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeModal}>
              Cancel
            </button>
            <button type="submit" form="product-form" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSave} id="product-form">
          <div className="row g-2">
            <div className="col-md-6">
              <label className="form-label">Name</label>
              <input className="form-control" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="col-md-3">
              <label className="form-label" htmlFor="product-kind">Kind</label>
              <select
                id="product-kind"
                className="form-select"
                value={form.productKind}
                onChange={(e) => setForm({ ...form, productKind: e.target.value })}
              >
                <option value="PHYSICAL_GOOD">Physical Good</option>
                <option value="SERVICE">Service</option>
              </select>
            </div>
            <div className="col-md-3">
              <label className="form-label" htmlFor="product-brand">Brand</label>
              <input id="product-brand" className="form-control mb-1" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
              {brands.length > 0 && (
                <select
                  className="form-select form-select-sm"
                  aria-label="Brand catalog"
                  value={form.brandId}
                  onChange={(e) => {
                    const selected = brands.find((b) => b.id === e.target.value);
                    setForm({ ...form, brandId: e.target.value, brand: selected ? selected.name : form.brand });
                  }}
                >
                  <option value="">Or choose from catalog...</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {(hasOptical || hasMedicine) && (
              <div className="col-md-3">
                <label className="form-label" htmlFor="product-industry-type">Industry Type</label>
                <select id="product-industry-type" className="form-select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  <option value="GENERAL">General</option>
                  {hasMedicine && <option value="MEDICINE">Medicine</option>}
                  {hasOptical && <option value="FRAME">Frame</option>}
                  {hasOptical && <option value="LENS">Lens</option>}
                </select>
              </div>
            )}
            <div className="col-md-3">
              <label className="form-label">Category</label>
              <select className="form-select" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-md-4">
              <label className="form-label">SKU</label>
              <input className="form-control" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </div>
            <div className="col-md-4">
              <label className="form-label">Barcode</label>
              <div className="d-flex gap-1">
                <input
                  className="form-control"
                  value={form.barcode}
                  onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                  placeholder="Scan, type, or generate"
                />
                {editingProduct && (
                  <button type="button" className="btn btn-outline-secondary text-nowrap" onClick={handleGenerateBarcode}>
                    Generate
                  </button>
                )}
              </div>
              {editingProduct && form.barcode && (
                <div className="mt-2 d-flex align-items-center gap-2 flex-wrap">
                  <svg ref={barcodePreviewRef} />
                  <button type="button" className="btn btn-sm btn-outline-primary" onClick={handlePrintBarcode}>
                    Print Barcode
                  </button>
                </div>
              )}
            </div>
            <div className="col-md-4">
              <label className="form-label">Unit</label>
              <input className="form-control mb-1" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
              {units.length > 0 && (
                <select
                  className="form-select form-select-sm"
                  aria-label="Unit catalog"
                  value={form.unitId}
                  onChange={(e) => {
                    const selected = units.find((u) => u.id === e.target.value);
                    setForm({ ...form, unitId: e.target.value, unit: selected ? selected.name : form.unit });
                  }}
                >
                  <option value="">Or choose from catalog...</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="col-md-3">
              <label className="form-label">Purchase Price</label>
              <input type="number" step="0.01" min="0" className="form-control" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Selling Price</label>
              <input type="number" step="0.01" min="0" className="form-control" value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} />
            </div>
            {form.productKind !== 'SERVICE' && !editingProduct && (
              <div className="col-md-3">
                <label className="form-label" htmlFor="product-opening-stock">Opening Stock</label>
                <input id="product-opening-stock" type="number" step="0.01" min="0" className="form-control" value={form.openingStock} onChange={(e) => setForm({ ...form, openingStock: e.target.value })} />
              </div>
            )}
            {form.productKind !== 'SERVICE' && (
              <div className="col-md-3">
                <label className="form-label" htmlFor="product-low-stock-threshold">Low Stock Threshold</label>
                <input id="product-low-stock-threshold" type="number" step="0.01" min="0" className="form-control" value={form.lowStockThreshold} onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })} />
              </div>
            )}

            {hasOptical && form.type === 'FRAME' && (
              <>
                <div className="col-md-6">
                  <label className="form-label">Frame Brand</label>
                  <input className="form-control" value={form.frameBrand} onChange={(e) => setForm({ ...form, frameBrand: e.target.value })} />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Frame Color</label>
                  <input className="form-control" value={form.frameColor} onChange={(e) => setForm({ ...form, frameColor: e.target.value })} />
                </div>
              </>
            )}

            {hasOptical && form.type === 'LENS' && (
              <>
                <div className="col-md-6">
                  <label className="form-label">Lens Type</label>
                  <input className="form-control" value={form.lensType} onChange={(e) => setForm({ ...form, lensType: e.target.value })} />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Lens Material</label>
                  <input className="form-control" value={form.lensMaterial} onChange={(e) => setForm({ ...form, lensMaterial: e.target.value })} />
                </div>
              </>
            )}

            {hasMedicine && form.type === 'MEDICINE' && (
              <>
                <div className="col-md-6">
                  <label className="form-label">Batch Number</label>
                  <input className="form-control" value={form.batchNumber} onChange={(e) => setForm({ ...form, batchNumber: e.target.value })} />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Expiry Date</label>
                  <input type="date" className="form-control" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
                </div>
              </>
            )}
          </div>
        </form>
      </Modal>

      <Modal
        show={!!adjustProduct}
        title={`Adjust Stock - ${adjustProduct?.name || ''}`}
        onClose={() => setAdjustProduct(null)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setAdjustProduct(null)}>
              Cancel
            </button>
            <button type="submit" form="adjust-stock-form" className="btn btn-primary">
              Apply
            </button>
          </>
        }
      >
        <form onSubmit={handleAdjust} id="adjust-stock-form">
          <p className="text-body-secondary">Current stock: {adjustProduct && Number(adjustProduct.stockQuantity)}</p>
          <div className="mb-2">
            <label className="form-label">Quantity (use negative to reduce)</label>
            <input type="number" className="form-control" required value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} />
          </div>
          <div className="mb-2">
            <label className="form-label">Note</label>
            <input className="form-control" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} />
          </div>
        </form>
      </Modal>

      <Modal
        show={!!variantsProduct}
        title={`Variants - ${variantsProduct?.name || ''}`}
        onClose={() => setVariantsProduct(null)}
        footer={<button className="btn btn-secondary" onClick={() => setVariantsProduct(null)}>Close</button>}
      >
        {variantsError && <ErrorAlert message={variantsError} />}
        {variantsLoading ? (
          <Spinner />
        ) : (
          <>
            {variants.length === 0 ? (
              <p className="text-body-secondary small">No variants yet.</p>
            ) : (
              <table className="table table-sm mb-3">
                <thead><tr><th>Name</th><th>SKU</th><th>Price</th><th>Stock</th><th></th></tr></thead>
                <tbody>
                  {variants.map((v) => (
                    <tr key={v.id} className={!v.isActive ? 'opacity-50' : ''}>
                      <td>{v.name}</td>
                      <td>{v.sku || '-'}</td>
                      <td>{v.priceOverride != null ? formatCurrency(v.priceOverride) : '-'}</td>
                      <td>{v.stockQuantity != null ? Number(v.stockQuantity) : '-'}</td>
                      <td>
                        {canManage && (
                          <button
                            className={`btn btn-sm btn-outline-${v.isActive ? 'danger' : 'success'}`}
                            onClick={() => toggleVariantActive(v)}
                          >
                            {v.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {canCreate && (
              <form onSubmit={addVariant} className="row g-2 align-items-end">
                <div className="col-md-3">
                  <label className="form-label small mb-1" htmlFor="variant-name">Name</label>
                  <input id="variant-name" className="form-control form-control-sm" required value={variantForm.name} onChange={(e) => setVariantForm({ ...variantForm, name: e.target.value })} />
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1" htmlFor="variant-sku">SKU</label>
                  <input id="variant-sku" className="form-control form-control-sm" value={variantForm.sku} onChange={(e) => setVariantForm({ ...variantForm, sku: e.target.value })} />
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1" htmlFor="variant-barcode">Barcode</label>
                  <input id="variant-barcode" className="form-control form-control-sm" value={variantForm.barcode} onChange={(e) => setVariantForm({ ...variantForm, barcode: e.target.value })} />
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1" htmlFor="variant-price">Price</label>
                  <input id="variant-price" type="number" step="0.01" min="0" className="form-control form-control-sm" value={variantForm.priceOverride} onChange={(e) => setVariantForm({ ...variantForm, priceOverride: e.target.value })} />
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1" htmlFor="variant-stock">Stock</label>
                  <input id="variant-stock" type="number" step="0.01" min="0" className="form-control form-control-sm" value={variantForm.stockQuantity} onChange={(e) => setVariantForm({ ...variantForm, stockQuantity: e.target.value })} />
                </div>
                <div className="col-md-1">
                  <button type="submit" className="btn btn-sm btn-primary w-100">+ Add</button>
                </div>
              </form>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
