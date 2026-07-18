import { AppError } from '../../domain/errors.js';

/** 404 for unmatched routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}

/** Central error translator: turns any thrown error into a consistent JSON body. */
// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity (4 args)
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // Known Prisma errors -> friendlier mapping.
  if (err?.code === 'P2002') {
    return res.status(409).json({
      error: { code: 'UNIQUE_CONFLICT', message: 'A conflicting record already exists', details: err.meta },
    });
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
  }

  console.error('[unhandled error]', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
}
