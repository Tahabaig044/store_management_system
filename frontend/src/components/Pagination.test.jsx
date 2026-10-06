import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Pagination from './Pagination';

describe('Pagination', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(<Pagination page={1} pageSize={20} total={5} onPageChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a page link per page and highlights the current one', () => {
    render(<Pagination page={2} pageSize={10} total={35} onPageChange={vi.fn()} />);
    // ceil(35/10) = 4 pages
    for (const label of ['1', '2', '3', '4']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('2').closest('li')).toHaveClass('active');
    expect(screen.getByText('1').closest('li')).not.toHaveClass('active');
  });

  it('disables Previous on the first page and Next on the last page', () => {
    const { rerender } = render(<Pagination page={1} pageSize={10} total={30} onPageChange={vi.fn()} />);
    expect(screen.getByText('Previous').closest('li')).toHaveClass('disabled');
    expect(screen.getByText('Next').closest('li')).not.toHaveClass('disabled');

    rerender(<Pagination page={3} pageSize={10} total={30} onPageChange={vi.fn()} />);
    expect(screen.getByText('Next').closest('li')).toHaveClass('disabled');
    expect(screen.getByText('Previous').closest('li')).not.toHaveClass('disabled');
  });

  it('calls onPageChange with the target page number when a link is clicked', async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageSize={10} total={30} onPageChange={onPageChange} />);

    await userEvent.click(screen.getByText('3'));
    expect(onPageChange).toHaveBeenCalledWith(3);

    await userEvent.click(screen.getByText('Previous'));
    expect(onPageChange).toHaveBeenCalledWith(1);

    await userEvent.click(screen.getByText('Next'));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
