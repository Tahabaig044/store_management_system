import { describe, it, expect } from 'vitest';
import { formatCurrency } from './currency';

describe('formatCurrency', () => {
  it('formats a whole number with two decimal places and the Rs. prefix', () => {
    expect(formatCurrency(4800)).toBe('Rs. 4,800.00');
  });

  it('formats small amounts without a thousands separator', () => {
    expect(formatCurrency(60)).toBe('Rs. 60.00');
    expect(formatCurrency(35)).toBe('Rs. 35.00');
    expect(formatCurrency(5)).toBe('Rs. 5.00');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('Rs. 0.00');
  });

  it('formats large amounts with thousands separators', () => {
    expect(formatCurrency(125000)).toBe('Rs. 125,000.00');
    expect(formatCurrency(8500)).toBe('Rs. 8,500.00');
    expect(formatCurrency(3200)).toBe('Rs. 3,200.00');
  });

  it('formats negative amounts with a leading minus before the Rs. prefix', () => {
    expect(formatCurrency(-500)).toBe('-Rs. 500.00');
  });

  it('rounds to two decimal places rather than truncating', () => {
    expect(formatCurrency(4800.005)).toBe('Rs. 4,800.01');
  });

  it('treats null, undefined, and non-numeric input as zero rather than throwing or printing NaN', () => {
    expect(formatCurrency(null)).toBe('Rs. 0.00');
    expect(formatCurrency(undefined)).toBe('Rs. 0.00');
    expect(formatCurrency('not a number')).toBe('Rs. 0.00');
  });

  it('accepts a numeric string, since API responses often carry Decimal fields as strings', () => {
    expect(formatCurrency('4800.5')).toBe('Rs. 4,800.50');
  });

  it('never returns the USD symbol', () => {
    expect(formatCurrency(4800)).not.toContain('$');
  });
});
