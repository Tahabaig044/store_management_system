import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';
import RegisterTenant from './RegisterTenant';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ registerTenant: vi.fn() }) }));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
});

describe('ForgotPassword', () => {
  it('says plainly that email reset is unavailable instead of offering a form that cannot work', async () => {
    apiClient.get.mockResolvedValue({ data: { passwordResetByEmail: false } });
    render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    expect(await screen.findByTestId('no-email-reset')).toHaveTextContent(/administrator/i);
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('sends the email when reset by email is available and shows the generic confirmation', async () => {
    apiClient.get.mockResolvedValue({ data: { passwordResetByEmail: true } });
    apiClient.post.mockResolvedValue({ data: {} });
    render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'a@b.co' }));
    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument();
  });
});

describe('ResetPassword', () => {
  const at = (url) => render(<MemoryRouter initialEntries={[url]}><ResetPassword /></MemoryRouter>);

  it('refuses a link without a token', () => {
    at('/reset-password');
    expect(screen.getByText(/incomplete/i)).toBeInTheDocument();
  });

  it('does not submit when the two passwords differ', async () => {
    at('/reset-password?token=abc');
    await userEvent.type(screen.getByLabelText('New password'), 'GoodPass123');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'Different123');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('posts the token and new password, then shows success', async () => {
    apiClient.post.mockResolvedValue({ data: {} });
    at('/reset-password?token=tok123');
    await userEvent.type(screen.getByLabelText('New password'), 'GoodPass123');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'GoodPass123');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/auth/reset-password', { token: 'tok123', password: 'GoodPass123' }));
    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
  });

  it('shows the server message for an expired link', async () => {
    apiClient.post.mockRejectedValue({ response: { data: { error: 'This reset link is invalid or has expired. Request a new one.' } } });
    at('/reset-password?token=old');
    await userEvent.type(screen.getByLabelText('New password'), 'GoodPass123');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'GoodPass123');
    await userEvent.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
  });
});

describe('RegisterTenant signup policy', () => {
  it('shows an invitation-only notice and no form when signup is closed', async () => {
    apiClient.get.mockResolvedValue({ data: { signupMode: 'closed' } });
    render(<MemoryRouter><RegisterTenant /></MemoryRouter>);
    expect(await screen.findByTestId('signup-closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create account/i })).not.toBeInTheDocument();
  });

  it('asks for an invitation code in invite mode', async () => {
    apiClient.get.mockResolvedValue({ data: { signupMode: 'invite' } });
    render(<MemoryRouter><RegisterTenant /></MemoryRouter>);
    expect(await screen.findByText('Invitation code')).toBeInTheDocument();
  });
});
