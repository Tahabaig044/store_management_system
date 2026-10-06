import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from './StatusBadge';

describe('StatusBadge', () => {
  it('maps known statuses to their expected color', () => {
    const cases = [
      ['PAID', 'text-bg-success'],
      ['UNPAID', 'text-bg-danger'],
      ['PARTIAL', 'text-bg-warning'],
      ['PENDING', 'text-bg-warning'],
      ['DELIVERED', 'text-bg-success'],
      ['REVERSED', 'text-bg-danger'],
    ];
    for (const [status, className] of cases) {
      const { container } = render(<StatusBadge status={status} />);
      expect(container.querySelector('span')).toHaveClass(className);
    }
  });

  it('falls back to secondary for an unrecognized status', () => {
    render(<StatusBadge status="SOMETHING_UNEXPECTED" />);
    expect(screen.getByText('SOMETHING UNEXPECTED')).toHaveClass('text-bg-secondary');
  });

  it('replaces underscores with spaces in the displayed label', () => {
    render(<StatusBadge status="IN_LAB" />);
    expect(screen.getByText('IN LAB')).toBeInTheDocument();
  });
});
