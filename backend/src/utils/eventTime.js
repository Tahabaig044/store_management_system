// Phase 3.2: the time a business event actually happened, as reported by an offline terminal.
//
// A queued transaction is sent long after it was made. The sale/purchase/expense/payment keeps the
// time the customer was actually served - so reports, statements and the ledger date reflect the
// business day, not the moment the terminal got its connection back - wherever the existing
// business rules allow it (a closed accounting period still refuses the posting, visibly).
//
// The device clock is never trusted forward: a time later than the server's "now" (a wrong clock)
// is clamped to now. An unparseable value is a validation error.
const { ValidationError } = require('./errors');

function resolveEventTime(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return now;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError('occurredAt is not a valid date');
  return d.getTime() > now.getTime() ? now : d;
}

module.exports = { resolveEventTime };
