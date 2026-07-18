import { prisma, runTransaction } from '../db/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { paiseToRupees } from '../domain/money.js';
import { getUserByHandleOrId } from './userService.js';
import { applyBalanceChange } from './ledger.js';
import { serializePayout } from './withdrawalService.js';

const SETTLE_TARGETS = {
  completed: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  rejected: 'REJECTED',
};
// Statuses that mean "money never reached the user" -> refund the balance.
const REFUND_STATES = ['FAILED', 'CANCELLED', 'REJECTED'];

/**
 * Settle a withdrawal payout — simulates the payment gateway's asynchronous
 * webhook. This is where FAILED PAYOUT RECOVERY (Question 2) happens:
 *
 *   completed              -> mark COMPLETED (balance already debited; no-op)
 *   failed/cancelled/rejected
 *                          -> mark terminal AND credit the amount back to the
 *                             withdrawable balance so the user can withdraw again
 *
 * The atomic guarded update only transitions a still-active (PENDING/PROCESSING)
 * withdrawal, so a duplicate/replayed webhook can never double-refund.
 */
export async function settlePayout({ payoutId, status, reason = null }) {
  const target = SETTLE_TARGETS[String(status).toLowerCase()];
  if (!target) {
    throw new ValidationError('status must be one of: completed, failed, cancelled, rejected');
  }

  const preview = await prisma.payout.findUnique({ where: { id: payoutId } });
  if (!preview) throw new NotFoundError(`Payout "${payoutId}" not found`);

  return runTransaction(async (tx) => {
    // Atomic transition: only an active WITHDRAWAL is settled.
    const claim = await tx.payout.updateMany({
      where: { id: payoutId, type: 'WITHDRAWAL', status: { in: ['PENDING', 'PROCESSING'] } },
      data: {
        status: target,
        failureReason: REFUND_STATES.includes(target) ? (reason ?? target.toLowerCase()) : null,
        completedAt: target === 'COMPLETED' ? new Date() : null,
      },
    });

    if (claim.count === 0) {
      const p = await tx.payout.findUnique({ where: { id: payoutId } });
      if (p.type !== 'WITHDRAWAL') {
        throw new ConflictError('Only WITHDRAWAL payouts can be settled', 'NOT_SETTLEABLE');
      }
      throw new ConflictError(
        `Payout "${payoutId}" is already settled (status=${p.status})`,
        'ALREADY_SETTLED',
      );
    }

    const payout = await tx.payout.findUnique({ where: { id: payoutId } });

    let balanceAfter;
    if (REFUND_STATES.includes(target)) {
      balanceAfter = await applyBalanceChange(tx, {
        userId: payout.userId,
        amount: payout.amount, // positive: refund
        type: 'WITHDRAWAL_REVERSAL',
        payoutId: payout.id,
        reason: `Withdrawal ${target.toLowerCase()} — refunded to balance`,
      });
    } else {
      const user = await tx.user.findUnique({ where: { id: payout.userId } });
      balanceAfter = user.withdrawableBalance;
    }

    return {
      payout: serializePayout(payout),
      refunded: REFUND_STATES.includes(target),
      withdrawableBalancePaise: balanceAfter,
      withdrawableBalance: paiseToRupees(balanceAfter),
    };
  });
}

export async function listPayouts({ userId } = {}) {
  const where = {};
  if (userId) {
    const user = await getUserByHandleOrId(userId);
    where.userId = user.id;
  }
  const payouts = await prisma.payout.findMany({ where, orderBy: { createdAt: 'asc' } });
  return payouts.map(serializePayout);
}

export async function getLedger(userId) {
  const user = await getUserByHandleOrId(userId);
  const entries = await prisma.balanceTransaction.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });
  return entries.map((e) => ({
    id: e.id,
    type: e.type,
    amount: paiseToRupees(e.amount),
    amountPaise: e.amount,
    balanceAfter: paiseToRupees(e.balanceAfter),
    balanceAfterPaise: e.balanceAfter,
    saleId: e.saleId ?? undefined,
    payoutId: e.payoutId ?? undefined,
    reason: e.reason ?? undefined,
    createdAt: e.createdAt,
  }));
}
