import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import { useAuth } from '../../context/AuthContext';

vi.mock('../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockNavigate.mockReset();
});

describe('Login page', () => {
  it('submits the entered credentials and navigates to the dashboard on success', async () => {
    const login = vi.fn().mockResolvedValue({ role: 'TENANT_ADMIN' });
    useAuth.mockReturnValue({ login });
    renderLogin();

    await userEvent.type(screen.getByLabelText('Email'), 'admin@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('admin@example.com', 'password123'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'));
  });

  it('shows the server error message and does not navigate on failed login', async () => {
    const login = vi.fn().mockRejectedValue({ response: { data: { error: 'Invalid email or password' } } });
    useAuth.mockReturnValue({ login });
    renderLogin();

    await userEvent.type(screen.getByLabelText('Email'), 'wrong@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'bad-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
