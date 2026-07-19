
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 400 — request is structurally invalid. */
export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** 404 — referenced resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message) {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(message, { status: 409, code });
  }
}

/** 422 — well-formed but violates a business rule (e.g. insufficient balance). */
export class BusinessRuleError extends AppError {
  constructor(message, code = 'BUSINESS_RULE_VIOLATION') {
    super(message, { status: 422, code });
  }
}

/** 429 — too many requests (the one-withdrawal-per-24h limit). */
export class RateLimitError extends AppError {
  constructor(message, details) {
    super(message, { status: 429, code: 'WITHDRAWAL_RATE_LIMITED', details });
  }
}
