// Every error carries a stable machine-readable `code` next to its human message. Clients that queue
// work offline (Phase 3.2) branch on the code - never on message text - to decide whether a rejected
// request is a conflict a person must resolve, a permanent rejection, or a retry.
class AppError extends Error {
  constructor(statusCode, message, details, code) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(404, message, undefined, code);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed', details, code = 'VALIDATION') {
    super(422, message, details, code);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, undefined, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message, undefined, 'FORBIDDEN');
  }
}

class ConflictError extends AppError {
  // `details` carries the machine-readable facts behind a conflict (e.g. the stock actually available), so a
  // client can offer a concrete fix instead of parsing the message.
  constructor(message = 'Conflict', code = 'CONFLICT', details) {
    super(409, message, details, code);
  }
}

module.exports = {
  AppError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
};
