import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AiAssistant from './AiAssistant';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

beforeEach(() => {
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  apiClient.get.mockImplementation((path) => {
    if (path === '/ai/assistant/suggested-questions') return Promise.resolve({ data: { items: ['Which branch is most profitable?'] } });
    if (path === '/ai/assistant/conversations') return Promise.resolve({ data: { items: [] } });
    return Promise.resolve({ data: {} });
  });
});

describe('AiAssistant page', () => {
  it('shows suggested questions before any message is sent', async () => {
    render(<AiAssistant />);
    expect(await screen.findByText('Which branch is most profitable?')).toBeInTheDocument();
  });

  it('clicking a suggested question sends it and renders the grounded answer with a confidence badge', async () => {
    apiClient.post.mockResolvedValue({
      data: {
        conversationId: 'c1',
        message: { id: 'm1', role: 'ASSISTANT', content: 'Main Branch is the most profitable.', confidence: 0.9, grounding: { branches: [] } },
        intent: 'branch_profitability',
        isRecognized: true,
      },
    });
    render(<AiAssistant />);
    const question = await screen.findByText('Which branch is most profitable?');
    fireEvent.click(question);

    expect(await screen.findByText('Main Branch is the most profitable.')).toBeInTheDocument();
    expect(screen.getByText('Confidence: 90%')).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith('/ai/assistant/ask', { question: 'Which branch is most profitable?', conversationId: undefined });
  });

  it('shows an error message if the ask request fails', async () => {
    apiClient.post.mockRejectedValue({ response: { data: { error: 'The daily AI usage limit has been reached' } } });
    render(<AiAssistant />);
    const input = screen.getByPlaceholderText('Ask a business question...');
    fireEvent.change(input, { target: { value: 'Why did profit decline?' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(screen.getByText(/daily AI usage limit/)).toBeInTheDocument());
  });
});
