// Phase 1.16: Universal Search - a NEW global search bar, the first
// cross-module search UI anywhere in the frontend (every existing search
// input, e.g. on Products/Customers/ActivityLog, is per-page/per-module and
// is left completely unchanged by this phase). Talks to the new
// GET /api/search endpoint only - no existing list endpoint is called here.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiSearch, FiX } from 'react-icons/fi';
import apiClient from '../api/client';
import { extractErrorMessage } from './Feedback';

const DEBOUNCE_MS = 350;

// Human-readable group labels and the query-param key each target page
// reads to pre-fill its own filter (Section 11 - deep link, not a
// duplicate detail page). A null route (RFQ - no dedicated screen exists,
// a disclosed pre-existing Phase 1.9 gap) renders as non-clickable text.
const ENTITY_LABELS = {
  PRODUCT: 'Products',
  PRODUCT_VARIANT: 'Product Variants',
  CUSTOMER: 'Customers',
  SUPPLIER: 'Suppliers',
  SALE: 'Sales',
  PURCHASE: 'Purchases',
  PAYMENT: 'Payments',
  EXPENSE: 'Expenses',
  SALES_RETURN: 'Sales Returns',
  PURCHASE_RETURN: 'Purchase Returns',
  CREDIT_NOTE: 'Credit Notes',
  DEBIT_NOTE: 'Debit Notes',
  QUOTATION: 'Quotations',
  SALES_ORDER: 'Sales Orders',
  PURCHASE_REQUEST: 'Purchase Requests',
  RFQ: 'RFQs',
  PURCHASE_ORDER: 'Purchase Orders',
  GOODS_RECEIPT: 'Goods Receipts',
  USER: 'Users',
  ACTIVITY_LOG: 'Activity Log',
  NOTIFICATION: 'Notifications',
};

export default function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [groups, setGroups] = useState([]);
  const [highlighted, setHighlighted] = useState(-1);
  const ref = useRef(null);
  const debounceRef = useRef(null);

  // Flattened list of every visible result, in display order, for keyboard
  // up/down navigation across group boundaries.
  const flatResults = groups.flatMap((g) => g.items);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setGroups([]);
      setError('');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      apiClient
        .get('/search', { params: { q: trimmed } })
        .then((res) => {
          setGroups(res.data.groups || []);
          setError('');
          setHighlighted(-1);
        })
        .catch((err) => setError(extractErrorMessage(err)))
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  function openResult(result) {
    if (!result.route) return;
    // `search` (not `q`) to match the query-param convention Products.jsx/
    // Customers.jsx/Suppliers.jsx already use for their own deep-linkable
    // filters (e.g. Products' existing ?type=/?lowStock= from the Command
    // Center) - see this phase's report, Deep Links, for which target pages
    // actually read this param today and which don't yet.
    navigate(`${result.route}?search=${encodeURIComponent(result.reference || result.title || query)}`);
    setOpen(false);
    setQuery('');
  }

  function clear() {
    setQuery('');
    setGroups([]);
    setError('');
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open || flatResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, flatResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && highlighted >= 0) {
      e.preventDefault();
      openResult(flatResults[highlighted]);
    }
  }

  const trimmed = query.trim();
  let flatIndex = -1;

  return (
    <div className="position-relative" ref={ref}>
      <div className="input-group input-group-sm">
        <span className="input-group-text bg-transparent border-end-0">
          <FiSearch size={13} />
        </span>
        <input
          type="text"
          className="form-control border-start-0"
          placeholder="Search products, customers, sales, invoices..."
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          aria-label="Universal search"
        />
        {query && (
          <button className="btn btn-outline-secondary" type="button" onClick={clear} aria-label="Clear search">
            <FiX size={13} />
          </button>
        )}
      </div>

      {open && trimmed && (
        <div className="card shadow-sm position-absolute mt-1" style={{ width: '100%', minWidth: 360, zIndex: 1060, maxHeight: 440, overflowY: 'auto' }}>
          {loading ? (
            <div className="text-center text-body-secondary small py-4">Searching...</div>
          ) : error ? (
            <div className="text-center text-danger small py-4">{error}</div>
          ) : groups.length === 0 ? (
            <div className="text-center text-body-secondary small py-4">No results for "{trimmed}".</div>
          ) : (
            groups.map((group) => (
              <div key={group.entity}>
                <div className="px-3 pt-2 pb-1 text-body-secondary text-uppercase" style={{ fontSize: '0.68rem', fontWeight: 600 }}>
                  {ENTITY_LABELS[group.entity] || group.entity}
                </div>
                {group.items.map((item) => {
                  flatIndex += 1;
                  const isHighlighted = flatIndex === highlighted;
                  const clickable = !!item.route;
                  return (
                    <button
                      key={`${item.entityType}-${item.entityId}`}
                      type="button"
                      disabled={!clickable}
                      className={`btn text-start px-3 py-2 border-bottom rounded-0 w-100 ${isHighlighted ? 'bg-body-secondary' : ''}`}
                      onMouseEnter={() => setHighlighted(flatIndex)}
                      onClick={() => openResult(item)}
                      title={clickable ? undefined : 'No detail screen available yet for this item'}
                    >
                      <div className="d-flex justify-content-between align-items-center">
                        <span className="small fw-semibold">{item.title}</span>
                        {item.status && <span className="badge text-bg-secondary" style={{ fontSize: '0.6rem' }}>{item.status}</span>}
                      </div>
                      {item.subtitle && <div className="small text-body-secondary">{item.subtitle}</div>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
