export function Spinner() {
  return (
    <div className="d-flex justify-content-center align-items-center py-5">
      <div className="spinner-border text-primary" role="status">
        <span className="visually-hidden">Loading...</span>
      </div>
    </div>
  );
}

export function ErrorAlert({ message }) {
  if (!message) return null;
  return <div className="alert alert-danger py-2">{message}</div>;
}

export function EmptyState({ message = 'No records found.' }) {
  return <div className="text-center text-body-secondary py-5">{message}</div>;
}

// The backend returns { error, details } for validation failures, where
// details is zod's flatten() shape: { fieldErrors: { field: [msgs] } }.
// Without this, every form just showed the generic "Invalid ... data"
// message with no indication of which field was wrong or why.
export function extractErrorMessage(err) {
  const data = err?.response?.data;
  const base = data?.error || err?.message || 'Something went wrong';
  const fieldErrors = data?.details?.fieldErrors;
  if (fieldErrors && Object.keys(fieldErrors).length > 0) {
    const details = Object.entries(fieldErrors)
      .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
      .join('; ');
    return `${base} (${details})`;
  }
  return base;
}
