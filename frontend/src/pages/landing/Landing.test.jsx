import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Landing from './Landing';
import ProtectedRoute from '../../components/ProtectedRoute';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

// Mirrors the route layout in App.jsx; basename matches the /BizOS/ deployment.
function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]} basename="/BizOS">
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/register" element={<div>Register Page</div>} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <div>Dashboard Page</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('BizOS public landing page', () => {
  it('renders at /BizOS without opening the dashboard', () => {
    useAuth.mockReturnValue({ token: 'abc', user: { role: 'TENANT_ADMIN' } });
    renderAt('/BizOS');
    expect(screen.getByRole('heading', { level: 1, name: /BizOS — Business Operating System/ })).toBeInTheDocument();
    expect(screen.queryByText('Dashboard Page')).not.toBeInTheDocument();
    for (const f of ['Sales & POS', 'Inventory Management', 'Accounting & Financial Reports', 'Customers & Suppliers', 'Purchase Management', 'Business Dashboard & Analytics']) {
      expect(screen.getByText(f)).toBeInTheDocument();
    }
  });

  it('Login buttons point to the existing login route', () => {
    useAuth.mockReturnValue({ token: null, user: null });
    renderAt('/BizOS');
    for (const link of screen.getAllByRole('link', { name: 'Login' })) {
      expect(link).toHaveAttribute('href', '/BizOS/login');
    }
  });

  it('Create Your Account buttons point to the existing registration route', () => {
    useAuth.mockReturnValue({ token: null, user: null });
    renderAt('/BizOS');
    for (const link of screen.getAllByRole('link', { name: 'Create Your Account' })) {
      expect(link).toHaveAttribute('href', '/BizOS/register');
    }
  });
});

describe('/BizOS/dashboard protection', () => {
  it('renders the dashboard for an authenticated user', () => {
    useAuth.mockReturnValue({ token: 'abc', user: { role: 'TENANT_ADMIN' } });
    renderAt('/BizOS/dashboard');
    expect(screen.getByText('Dashboard Page')).toBeInTheDocument();
  });

  it('redirects an unauthenticated user to login', () => {
    useAuth.mockReturnValue({ token: null, user: null });
    renderAt('/BizOS/dashboard');
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });
});
