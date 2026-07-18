import { runTransaction } from '../db/prisma.js';
import { config } from '../config/env.js';
import { BusinessRuleError, RateLimitError } from '../domain/errors.js';
import { rupeesToPaise, paiseToRupees } from '../domain/money.js';
import { getUserByHandleOrId } from './userService.js';
import { paymentGateway } from './paymentGateway.js';

// A withdrawal in one of these states counts against the 24h limit. FAILED /
// CANCELLED / REJECTED withdrawals are excluded, which is exactly what lets a
// user retry immediately after a failed payout (Question 2).
const ACTIVE_WITHDRAWAL_STATES = ['PENDING', 'PROCESSING', 'COMPLETED'];

/**
 * Initiate a user-requested withdrawal.
 *
 * Enforces: one active withdrawal per 24h window; amount within the available
 * balance; idempotency via a client key. The balance is debited at initiation
 * with an ATOMIC GUARDED decrement (`where balance >= amount`) so two
 * concurrent withdrawals can never overdraw. If the payout later fails the
 * amount is credited back (see payoutService.settlePayout).
 */
export async function initiateWithdrawal({ userId, amount, idempotencyKey = null }) {
  const user = await getUserByHandleOrId(userId);

  return runTransaction(async (tx) => {
    // Idempotent replay: same key => return the original payout, no re-debit.
    if (idempotencyKey) {
      const prior = await tx.payout.findUnique({ where: { idempotencyKey } });
      if (prior) {
        const u = await tx.user.findUnique({ where: { id: user.id } });
        return buildResult(prior, u.withdrawableBalance, { replayed: true });
      }
    }

    const current = await tx.user.findUnique({ where: { id: user.id } });

    // Default to withdrawing the entire available balance.
    const amountPaise =
      amount === undefined || amount === null
        ? current.withdrawableBalance
        : rupeesToPaise(amount);

    if (amountPaise <= 0) {
      throw new BusinessRuleError(
        'Withdrawal amount must be positive (no funds available)',
        'INVALID_AMOUNT',
      );
    }
    if (amountPaise > current.withdrawableBalance) {
      throw new BusinessRuleError(
        `Insufficient balance: requested ${paiseToRupees(amountPaise)}, available ${paiseToRupees(current.withdrawableBalance)}`,
        'INSUFFICIENT_BALANCE',
      );
    }

    await enforceWithdrawalWindow(tx, user.id);

    // Ask the gateway to move the money. In "auto" mode it returns PENDING and
    // the final outcome arrives later via settlePayout.
    let gateway;
    try {
      gateway = await paymentGateway.initiateWithdrawal({ userId: user.id, amount: amountPaise });
    } catch (err) {
      throw new BusinessRuleError(`Payment gateway rejected the request: ${err.message}`, 'GATEWAY_ERROR');
    }

    let payout;
    try {
      payout = await tx.payout.create({
        data: {
          userId: user.id,
          type: 'WITHDRAWAL',
          status: gateway.status,
          amount: amountPaise,
          idempotencyKey,
          providerRef: gateway.providerRef,
          completedAt: gateway.status === 'COMPLETED' ? new Date() : null,
        },
      });
    } catch (err) {
      // Concurrent request with the same idempotency key won the race.
      if (err?.code === 'P2002' && idempotencyKey) {
        const prior = await tx.payout.findUnique({ where: { idempotencyKey } });
        const u = await tx.user.findUnique({ where: { id: user.id } });
        return buildResult(prior, u.withdrawableBalance, { replayed: true });
      }
      throw err;
    }

    // Atomic guarded debit: succeeds only if the balance still covers it.
    const debit = await tx.user.updateMany({
      where: { id: user.id, withdrawableBalance: { gte: amountPaise } },
      data: { withdrawableBalance: { decrement: amountPaise } },
    });
    if (debit.count === 0) {
      // Lost a race to another concurrent withdrawal — abort (rolls back the payout).
      throw new BusinessRuleError('Insufficient balance', 'INSUFFICIENT_BALANCE');
    }

    const after = await tx.user.findUnique({ where: { id: user.id } });
    await tx.balanceTransaction.create({
      data: {
        userId: user.id,
        amount: -amountPaise,
        type: 'WITHDRAWAL_DEBIT',
        balanceAfter: after.withdrawableBalance,
        payoutId: payout.id,
        reason: 'Withdrawal initiated',
      },
    });

    return buildResult(payout, after.withdrawableBalance, { replayed: false });
  });
}

async function enforceWithdrawalWindow(tx, userId) {
  const windowMs = config.withdrawalWindowHours * 60 * 60 * 1000;
  const since = new Date(Date.now() - windowMs);

  const last = await tx.payout.findFirst({
    where: {
      userId,
      type: 'WITHDRAWAL',
      status: { in: ACTIVE_WITHDRAWAL_STATES },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (last) {
    const nextAllowedAt = new Date(last.createdAt.getTime() + windowMs);
    throw new RateLimitError(
      `Only one withdrawal is allowed every ${config.withdrawalWindowHours}h. Try again after ${nextAllowedAt.toISOString()}.`,
      { lastWithdrawalId: last.id, lastWithdrawalAt: last.createdAt, nextAllowedAt },
    );
  }
}

function buildResult(payout, balanceAfter, { replayed }) {
  return {
    payout: serializePayout(payout),
    withdrawableBalancePaise: balanceAfter,
    withdrawableBalance: paiseToRupees(balanceAfter),
    replayed,
  };
}

export function serializePayout(payout) {
  return {
    id: payout.id,
    userId: payout.userId,
    type: payout.type.toLowerCase(),
    status: payout.status.toLowerCase(),
    amount: paiseToRupees(payout.amount),
    amountPaise: payout.amount,
    saleId: payout.saleId ?? undefined,
    idempotencyKey: payout.idempotencyKey ?? undefined,
    providerRef: payout.providerRef ?? undefined,
    failureReason: payout.failureReason ?? undefined,
    createdAt: payout.createdAt,
    completedAt: payout.completedAt ?? undefined,
  };
}
