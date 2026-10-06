import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Procurement from './Procurement';
import apiClient from '../../api/client';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

beforeEach(() => {
  apiClient.get.mockReset();
  useAuth.mockReturnValue({ user: { role: 'TENANT_ADMIN' }, hasPermission: () => true });
});

describe('Procurement page', () => {
  it('renders Purchase Requests with an approve/reject action for a pending one', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/procurement/purchase-requests') {
        return Promise.resolve({
          data: {
            items: [
              {
                id: 'pr1',
                requestNumber: 'PR-000001',
                status: 'PENDING_APPROVAL',
                items: [{ product: { name: 'Frame A' }, quantity: 5 }],
                requestedBy: { name: 'Store Keeper' },
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Procurement />);
    expect(await screen.findByText('PR-000001')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('switches to the Purchase Orders tab and lists them', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/procurement/purchase-orders') {
        return Promise.resolve({ data: { items: [{ id: 'po1', poNumber: 'PO-000001', supplier: { name: 'Acme' }, total: 500, status: 'APPROVED' }] } });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Procurement />);
    fireEvent.click(screen.getByText('Purchase Orders'));
    expect(await screen.findByText('PO-000001')).toBeInTheDocument();
    expect(screen.getByText('Rs. 500.00')).toBeInTheDocument();
  });

  it('a draft purchase request shows Edit/Submit instead of Approve/Reject', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/procurement/purchase-requests') {
        return Promise.resolve({
          data: {
            items: [{ id: 'pr2', requestNumber: 'PR-000002', status: 'DRAFT', items: [{ product: { name: 'Frame B' }, quantity: 2 }], requestedBy: { name: 'Store Keeper' } }],
          },
        });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Procurement />);
    expect(await screen.findByText('PR-000002')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Submit')).toBeInTheDocument();
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });

  it('switches to the RFQs & Quotations tab, lists RFQs, and opens the compare view with a recommendation', async () => {
    const rfqListItem = {
      id: 'rfq1', rfqNumber: 'RFQ-000001', status: 'OPEN',
      items: [{ product: { name: 'Lens A' }, quantity: 10 }],
      suppliers: [{ supplier: { name: 'Supplier X' } }],
      quotations: [{}],
    };
    const rfqDetail = {
      id: 'rfq1', rfqNumber: 'RFQ-000001', status: 'OPEN',
      items: [{ productId: 'p1', product: { name: 'Lens A' }, quantity: 10 }],
      suppliers: [{ supplierId: 's1', supplier: { name: 'Supplier X' } }],
      quotations: [{ id: 'q1', supplierId: 's1', supplier: { name: 'Supplier X' }, total: 100, deliveryDays: 3, validUntil: null, status: 'RECEIVED' }],
    };
    apiClient.get.mockImplementation((path) => {
      if (path === '/procurement/rfqs') return Promise.resolve({ data: { items: [rfqListItem] } });
      if (path === '/procurement/rfqs/rfq1') return Promise.resolve({ data: { item: rfqDetail } });
      if (path === '/procurement/rfqs/rfq1/compare') return Promise.resolve({ data: { quotations: rfqDetail.quotations, recommendation: { lowestTotalId: 'q1', fastestDeliveryId: 'q1' } } });
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Procurement />);
    fireEvent.click(screen.getByText('RFQs & Quotations'));
    expect(await screen.findByText('RFQ-000001')).toBeInTheDocument();
    fireEvent.click(screen.getByText('View & Compare'));
    expect(await screen.findByText('Lowest total')).toBeInTheDocument();
    expect(screen.getByText('Select & Create PO')).toBeInTheDocument();
  });

  it('switches to the Reports tab and shows dashboard totals and integrity findings', async () => {
    apiClient.get.mockImplementation((path) => {
      if (path === '/procurement/dashboard') {
        return Promise.resolve({
          data: {
            statusSummary: [{ status: 'APPROVED', count: 2, total: 300 }],
            pendingApprovals: { purchaseOrders: 1, purchaseRequests: 0 },
            pendingReceipts: 1,
            topSuppliers: [{ supplierId: 's1', supplierName: 'Supplier X', orderCount: 2, totalValue: 300 }],
          },
        });
      }
      if (path === '/procurement/summary') {
        return Promise.resolve({ data: { counts: { purchaseOrders: 2, findings: 1 }, findings: [{ type: 'OVER_RECEIPT', poNumber: 'PO-000001', ordered: 5, received: 9 }] } });
      }
      return Promise.resolve({ data: { items: [] } });
    });
    render(<Procurement />);
    fireEvent.click(screen.getByText('Reports'));
    expect(await screen.findByText('Supplier X')).toBeInTheDocument();
    expect(screen.getByText('OVER RECEIPT')).toBeInTheDocument();
  });
});
