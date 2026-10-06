// Shared across POS checkout and every "record a payment" modal (Purchases,
// Optical Orders) so the list can never drift out of sync between them.
// The backend stores this as a plain string (no enum) - these values are a
// frontend convention only; existing historical records with any of these
// values (or any other string) keep displaying/working unchanged.
export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
  { value: 'other', label: 'Other' },
];
