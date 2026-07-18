/**
 * Money helpers.
 *
 * All money is stored and computed as an integer number of *paise*
 * (1 rupee = 100 paise). Doing arithmetic in the smallest currency unit with
 * integers eliminates floating-point drift (e.g. 0.1 + 0.2 !== 0.3), which is
 * unacceptable in a financial ledger.
 *
 * The HTTP boundary speaks rupees; everything internal speaks paise.
 */

export const PAISE_PER_RUPEE = 100;

/** Advance payout rate: 10% of a pending sale's earning. */
export const ADVANCE_RATE_NUMERATOR = 10;
export const ADVANCE_RATE_DENOMINATOR = 100;

/**
 * Convert a rupee amount (from an API request) to integer paise.
 * Rounds to the nearest paise to absorb floating-point representation error.
 */
export function rupeesToPaise(rupees) {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new TypeError(`Expected a finite number of rupees, got: ${rupees}`);
  }
  return Math.round(rupees * PAISE_PER_RUPEE);
}

/** Convert integer paise to a rupee number for API responses. */
export function paiseToRupees(paise) {
  assertIntegerPaise(paise);
  return paise / PAISE_PER_RUPEE;
}

/**
 * Advance payout for a sale = floor(10% of earning).
 *
 * We floor (round *down*) so the system never advances more than 10%. Working
 * in paise this is exact for whole-rupee earnings (₹40 -> 400 paise) and safe
 * for fractional ones (₹40.05 -> floor(400.5) = 400 paise).
 */
export function computeAdvance(earningPaise) {
  assertIntegerPaise(earningPaise);
  return Math.floor((earningPaise * ADVANCE_RATE_NUMERATOR) / ADVANCE_RATE_DENOMINATOR);
}

/**
 * The signed balance adjustment applied when a sale is reconciled, given the
 * advance that was already paid on it.
 *
 *   APPROVED : +(earning - advanceAlreadyPaid)   // remaining amount owed
 *   REJECTED : -(advanceAlreadyPaid)             // claw back what was pre-paid
 *
 * Works whether or not an advance was paid (advancePaidPaise may be 0).
 */
export function reconciliationAdjustment(status, earningPaise, advancePaidPaise) {
  assertIntegerPaise(earningPaise);
  assertIntegerPaise(advancePaidPaise);
  if (status === 'APPROVED') return earningPaise - advancePaidPaise;
  if (status === 'REJECTED') return -advancePaidPaise;
  throw new Error(`reconciliationAdjustment: unsupported status "${status}"`);
}

/** Format paise as a human-readable "₹xx.xx" string (for logs/demo output). */
export function formatPaise(paise) {
  assertIntegerPaise(paise);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / PAISE_PER_RUPEE);
  const rem = abs % PAISE_PER_RUPEE;
  return `${sign}₹${rupees}.${String(rem).padStart(2, '0')}`;
}

function assertIntegerPaise(value) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Expected integer paise, got: ${value}`);
  }
}
