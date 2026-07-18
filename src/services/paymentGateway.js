import { config } from '../config/env.js';

/**
 * Payment gateway abstraction.
 *
 * In production this wraps a real payout provider (RazorpayX, Cashfree, a bank
 * API, ...). Money movement to a user is inherently asynchronous and can fail,
 * so the interface reflects that:
 *
 *   - transferAdvance(): advances are small and fire-and-settle synchronously
 *     in this simulation. Returns { success, providerRef } or throws on a hard
 *     failure (the caller then rolls back and the sale stays claimable).
 *
 *   - initiateWithdrawal(): returns a provider reference and leaves the payout
 *     PENDING. Real gateways confirm the final outcome later via webhook; here
 *     that outcome is delivered through the POST /payouts/:id/settle endpoint.
 *
 * Swapping this class for a real implementation requires no changes to any
 * service — they depend only on this interface.
 */
export class PaymentGateway {
  constructor(mode = config.gatewayMode) {
    this.mode = mode;
    this._seq = 0;
  }

  _ref(prefix) {
    this._seq += 1;
    return `${prefix}_${this._seq}_${this._seq.toString(36)}`;
  }

  /**
   * Transfer an advance payout. Resolves on success; throws to signal a hard
   * failure so the caller's DB transaction rolls back.
   */
  async transferAdvance({ amount }) {
    if (amount <= 0) throw new Error('advance amount must be positive');
    // Simulation: advances always succeed. A real gateway call goes here.
    return { success: true, providerRef: this._ref('adv') };
  }

  /**
   * Initiate a user withdrawal.
   *   - "always" mode: settles COMPLETED immediately (good for smoke tests).
   *   - "auto" mode  : stays PENDING; final state arrives via /settle.
   */
  async initiateWithdrawal({ amount }) {
    if (amount <= 0) throw new Error('withdrawal amount must be positive');
    const providerRef = this._ref('wd');
    if (this.mode === 'always') {
      return { providerRef, status: 'COMPLETED' };
    }
    return { providerRef, status: 'PENDING' };
  }
}

export const paymentGateway = new PaymentGateway();
