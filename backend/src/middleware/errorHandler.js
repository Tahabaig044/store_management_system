const { AppError } = require('../utils/errors');
const { captureException } = require('../utils/errorTracking');

// Centralized error handler. Never leaks internals (stack traces, DB errors) to clients.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details,
    });
  }

  // Client mistakes in the request body are 4xx, not server errors (and must not raise an operator alert).
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body', code: 'BAD_JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' });
  }

  if (err.code === 'P2002') {
    // Prisma unique constraint violation
    return res.status(409).json({ error: 'A record with these details already exists', code: 'DUPLICATE' });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Resource not found' });
  }

  // Response shape to the client is unchanged (Phase 12 preserves this
  // exactly) - only the server-side capture is new, via the same
  // provider-agnostic hook used by the process-level handlers in app.js.
  captureException(err, { requestId: req.id, path: req.path, method: req.method });
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = errorHandler;
