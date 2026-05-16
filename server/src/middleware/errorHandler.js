/**
 * Centralized error handling middleware.
 */

class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  // Always log the original error so 500s aren't black holes. The request
  // id (set by middleware/requestId.js) is also echoed in the X-Request-Id
  // response header, so a user-reported 500 can be matched to the server
  // log line that produced it.
  const reqId = req.id || '-';
  process.stderr.write(
    `[${new Date().toISOString()}] [${reqId}] ${req.method} ${req.originalUrl} -> ${err.stack || err.message}\n`
  );

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Server Error';

  if (err.code === 'SQLITE_CONSTRAINT') {
    statusCode = 400;
    message = 'Database constraint violation';
  }

  // Do NOT leak internal error messages to clients in production. Raw
  // err.message can include file paths, SQL fragments, library internals,
  // or other server-side details. Only `AppError` instances are considered
  // safe-to-display (they're authored by us with user-facing copy).
  // Non-operational 5xx errors get a generic message; clients should use
  // the requestId to correlate with server logs.
  const isProduction = process.env.NODE_ENV === 'production';
  const isSafeMessage = err.isOperational === true || (statusCode >= 400 && statusCode < 500);
  if (isProduction && !isSafeMessage) {
    message = 'Server Error';
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    requestId: reqId
  });
};

const notFoundHandler = (req, res, next) => {
  next(new AppError('Route not found', 404));
};

module.exports = {
  AppError,
  errorHandler,
  notFoundHandler
};
