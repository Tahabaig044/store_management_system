import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

describe('Modal', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(
      <Modal show={false} title="Hidden" onClose={vi.fn()}>
        content
      </Modal>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the title, body, and footer when shown', () => {
    render(
      <Modal show title="My Title" onClose={vi.fn()} footer={<button>Footer Button</button>}>
        <p>Body content</p>
      </Modal>
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
    expect(screen.getByText('Footer Button')).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Modal show title="T" onClose={onClose}>
        body
      </Modal>
    );
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop area is clicked, but not when the dialog content is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Modal show title="T" onClose={onClose}>
        <button>Inside</button>
      </Modal>
    );

    await userEvent.click(screen.getByText('Inside'));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
