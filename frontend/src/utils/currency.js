// Centralized currency display formatter (Pakistani Rupees). This is
// DISPLAY-ONLY localization - it never touches the underlying numeric value,
// which continues to flow through the app exactly as the backend returns it
// (no conversion, no multiplication/division, no exchange rate applied).
//
// Every monetary value rendered anywhere in the app should go through this
// single function rather than each page formatting money on its own -
// before this existed, five different pages each had their own near-
// identical (and inconsistently USD-prefixed) `money()` helper.
export function formatCurrency(amount) {
  const value = Number(amount) || 0;
  const formatted = Math.abs(value).toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}Rs. ${formatted}`;
}
