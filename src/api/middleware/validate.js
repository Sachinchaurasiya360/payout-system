import { ValidationError } from '../../domain/errors.js';

/**
 * Returns middleware that validates `req[source]` against a Zod schema and
 * replaces it with the parsed (typed/coerced) value.
 */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return next(new ValidationError('Request validation failed', details));
  }
  req[source] = result.data;
  next();
};
