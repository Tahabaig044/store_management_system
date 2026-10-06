import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import { useAuth } from '../context/AuthContext';

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

function renderAt(path, roles) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/dashboard" element={<div>Home Page</div>} />
        <Route
          path="/protected"
          element={
            <ProtectedRoute roles={roles}>
              <div>Secret Content</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  it('redirects to /login when there is no token or user', () => {
    useAuth.mockReturnValue({ token: null, user: null });
    renderAt('/protected');
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('renders the protected content when authenticated and no roles are required', () => {
    useAuth.mockReturnValue({ token: 'abc', user: { role: 'CASHIER' } });
    renderAt('/protected');
    expect(screen.getByText('Secret Content')).toBeInTheDocument();
  });

  it('redirects to / when the user role is not in the allowed list', () => {
    useAuth.mockReturnValue({ token: 'abc', user: { role: 'CASHIER' } });
    renderAt('/protected', ['TENANT_ADMIN']);
    expect(screen.getByText('Home Page')).toBeInTheDocument();
  });

  it('renders the protected content when the user role is in the allowed list', () => {
    useAuth.mockReturnValue({ token: 'abc', user: { role: 'TENANT_ADMIN' } });
    renderAt('/protected', ['TENANT_ADMIN', 'MANAGER']);
    expect(screen.getByText('Secret Content')).toBeInTheDocument();
  });
});
