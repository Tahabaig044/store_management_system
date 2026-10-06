import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommandCenter from './CommandCenter';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), put: vi.fn() },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const COMMAND_CENTER_RESPONSE = {
  data: {
    range: { from: '2026-09-12T00:00:00.000Z', to: '2026-09-12T23:59:59.999Z', preset: 'today' },
    kpis: {
      sales: 250,
      grossProfit: 110,
      netProfit: 85,
      purchases: 40,
      expenses: 20,
      cash: 150,
      bank: 95,
      receivables: 30,
      payables: 15,
      inventoryValue: 5000,
      salesGrowthPercent: 12.5,
      purchaseGrowthPercent: -5,
      averageInvoiceValue: 125,
    },
    trends: { sales: [{ date: '2026-09-12', total: 250 }], profit: [{ date: '2026-09-12', profit: 100 }] },
    topProducts: [{ productId: 'p1', name: 'Frame A', quantity: 2, revenue: 250, profit: 100 }],
    mostProfitableProducts: [{ productId: 'p1', name: 'Frame A', quantity: 2, revenue: 250, profit: 100 }],
    stock: {
      lowStock: [{ id: 'p2', name: 'Low Stock Lens' }],
      lowStockCount: 1,
      slowMoving: [],
      slowMovingCount: 0,
      deadStock: [],
      deadStockCount: 0,
      expiringMedicines: [],
      expiringCount: 0,
    },
    opticalJobs: { pending: 2, ready: 1, delayed: 0 },
    customers: { new: 1, returning: 2 },
    outstandingPayments: {
      receivablesTotal: 30,
      payablesTotal: 15,
      topReceivables: [{ id: 's1', name: 'Jane Doe', amountDue: 30 }],
      topPayables: [{ id: 'pu1', name: 'Acme Supplies', amountDue: 15 }],
    },
    branchPerformance: [{ branchId: 'b1', branchName: 'Main Branch', total: 250, count: 1 }],
    staffPerformance: [{ staffId: 'u1', staffName: 'Cashier One', total: 250, count: 1 }],
    topSuppliers: [{ supplierId: 'sup1', supplierName: 'Prime Supplies Co', totalPurchased: 40, purchaseCount: 1 }],
    topDebtors: [{ customerId: 'c1', customerName: 'Overdue Jane', amountDue: 30, oldestDaysOverdue: 15 }],
    salesByCategory: [{ categoryId: 'cat1', categoryName: 'Frames', revenue: 250, quantitySold: 5 }],
    salesByPaymentMethod: [{ paymentMethod: 'cash', total: 250, saleCount: 1 }],
    overstock: { items: [{ productId: 'p3', name: 'Overstocked Frame', daysOfStockRemaining: 220, capitalTiedUp: 800 }], count: 1 },
  },
};

function mockListEndpoints() {
  apiClient.get.mockImplementation((url) => {
    if (url === '/dashboard/command-center') return Promise.resolve(COMMAND_CENTER_RESPONSE);
    if (url === '/dashboard/preferences') return Promise.resolve({ data: { preferences: null } });
    // /branches, /categories, /products, /suppliers, /customers
    return Promise.resolve({ data: { items: [] } });
  });
}

function renderCommandCenter() {
  return render(
    <MemoryRouter>
      <CommandCenter />
    </MemoryRouter>
  );
}

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.put.mockReset();
  apiClient.put.mockResolvedValue({ data: { preferences: { widgets: [] } } });
  mockNavigate.mockReset();
});

describe('CommandCenter (Business Command Center)', () => {
  it('renders KPI values from the aggregated API response', async () => {
    mockListEndpoints();
    renderCommandCenter();

    expect(await screen.findByText('Rs. 250.00')).toBeInTheDocument(); // Sales
    expect(screen.getByText('Rs. 110.00')).toBeInTheDocument(); // Gross Profit
    expect(screen.getByText('Rs. 5,000.00')).toBeInTheDocument(); // Inventory Value
  });

  it('shows the ledger-derived financials only when the API provides them (Phase 2.3)', async () => {
    mockListEndpoints();
    const { unmount } = renderCommandCenter();
    await screen.findByText('Sales');
    expect(screen.queryByTestId('ledger-kpis-heading')).not.toBeInTheDocument();
    unmount();

    apiClient.get.mockImplementation((url) => {
      if (url === '/dashboard/command-center') {
        return Promise.resolve({ data: { ...COMMAND_CENTER_RESPONSE.data, accounting: { ledger: { revenue: 300, grossProfit: 150, netProfit: 120, cashAndBank: 120, receivables: 150, payables: 100 } } } });
      }
      if (url === '/dashboard/preferences') return Promise.resolve({ data: { preferences: null } });
      return Promise.resolve({ data: { items: [] } });
    });
    renderCommandCenter();
    expect(await screen.findByTestId('ledger-kpis-heading')).toBeInTheDocument();
    expect(screen.getByText('Ledger Net Profit')).toBeInTheDocument();
    expect(screen.getByText('Cash & Bank Position')).toBeInTheDocument();
    expect(screen.getByText('Cash & Bank Position').closest('.stat-card').querySelector('.stat-card-value')).toHaveTextContent('Rs. 120.00');
  });

  it('shows an error message when the API call fails, instead of a blank screen', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/dashboard/command-center') return Promise.reject({ response: { data: { error: 'Forbidden' } } });
      return Promise.resolve({ data: { items: [] } });
    });
    renderCommandCenter();

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
  });

  it('renders an empty state for widgets with no data, not an error', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url === '/dashboard/command-center') {
        return Promise.resolve({
          data: { ...COMMAND_CENTER_RESPONSE.data, topProducts: [], branchPerformance: [], staffPerformance: [] },
        });
      }
      if (url === '/dashboard/preferences') return Promise.resolve({ data: { preferences: null } });
      return Promise.resolve({ data: { items: [] } });
    });
    renderCommandCenter();

    await screen.findByText('Rs. 250.00');
    expect(screen.getAllByText('No sales in this range.').length).toBeGreaterThan(0);
  });

  it('customization: hiding a widget removes it from the page, and Save Layout persists it', async () => {
    mockListEndpoints();
    renderCommandCenter();
    await screen.findByText('Rs. 250.00');

    expect(screen.getAllByText('Top-Selling Products').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    // The customize panel's checklist repeats each widget's label; scope to
    // the <li> that also contains the checkbox/reorder controls.
    const rows = screen.getAllByText('Top-Selling Products').map((el) => el.closest('li')).filter(Boolean);
    expect(rows).toHaveLength(1);
    fireEvent.click(rows[0].querySelector('input[type="checkbox"]'));

    // "2 sold · Rs. 250.00" only appears inside the Top-Selling Products widget
    // body (Most Profitable Products, which stays visible, renders different text).
    expect(screen.queryByText(/2 sold/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));
    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith(
      '/dashboard/preferences',
      expect.objectContaining({ widgets: expect.any(Array) })
    ));
  });

  it('clicking the Low Stock widget navigates to the pre-filtered Products page', async () => {
    mockListEndpoints();
    renderCommandCenter();
    await screen.findByText('Rs. 250.00');

    fireEvent.click(screen.getByText('Low Stock').closest('.card'));
    expect(mockNavigate).toHaveBeenCalledWith('/products?lowStock=1');
  });

  it('Phase 6.1/6.2: renders the new BI widgets (top suppliers, top debtors, sales by category/payment method, overstock) and growth KPIs', async () => {
    mockListEndpoints();
    renderCommandCenter();
    await screen.findByText('Rs. 250.00');

    expect(screen.getByText('+12.5%')).toBeInTheDocument(); // Sales Growth
    expect(screen.getByText('-5.0%')).toBeInTheDocument(); // Purchase Growth
    expect(screen.getByText('Rs. 125.00')).toBeInTheDocument(); // Avg Invoice Value

    expect(screen.getByText('Prime Supplies Co')).toBeInTheDocument(); // Top Suppliers
    expect(screen.getByText('Frames')).toBeInTheDocument(); // Sales by Category
    expect(screen.getByText('cash')).toBeInTheDocument(); // Sales by Payment Method
    expect(screen.getByText('Overstocked Frame')).toBeInTheDocument(); // Overstock
    expect(screen.getByText('Overstocked Products (1)')).toBeInTheDocument();
  });

  it('Phase 6.2: offers Company and Warehouse filters alongside the existing Branch filter', async () => {
    mockListEndpoints();
    renderCommandCenter();
    await screen.findByText('Rs. 250.00');

    expect(screen.getByText('Company')).toBeInTheDocument();
    expect(screen.getByText('Warehouse')).toBeInTheDocument();
    expect(screen.getByText('Branch')).toBeInTheDocument();
  });
});
