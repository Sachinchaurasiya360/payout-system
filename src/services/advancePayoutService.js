import { prisma, runTransaction } from '../db/prisma.js';
import { computeAdvance, paiseToRupees } from '../domain/money.js';
import { paymentGateway } from './paymentGateway.js';
import { getUserByHandleOrId } from './userService.js';

/**
 * Advance-payout job. Pays 10% of earnings on every eligible PENDING sale.
 *
 * IDEMPOTENCY (core requirement): a sale must never receive a second advance,
 * no matter how many times this job runs or how many run concurrently. Three
 * layers guarantee this:
 *   1. Candidate filter: only sales with `advancePaidAt IS NULL`.
 *   2. Atomic claim: `updateMany({ where: { status:'PENDING', advancePaidAt:null }})`
 *      sets the flag in ONE atomic statement. `count === 0` means another run
 *      already claimed it — we skip. This defeats the read-modify-write race
 *      without needing a session-scoped row lock.
 *   3. UNIQUE(Payout.saleId): the database physically refuses a duplicate
 *      advance row even if layers 1-2 were somehow bypassed.
 *
 * An advance is a direct transfer to the user; it does NOT touch the
 * withdrawable balance. The balance moves only at reconciliation, where the
 * advance already paid is netted out.
 */
export async function runAdvancePayoutJob({ userId = null } = {}) {
  const where = { status: 'PENDING', advancePaidAt: null };
  if (userId) {
    const user = await getUserByHandleOrId(userId);
    where.userId = user.id;
  }

  const candidates = await prisma.sale.findMany({
    where,
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  const result = {
    candidates: candidates.length,
    paid: 0,
    skipped: 0,
    failed: 0,
    totalTransferredPaise: 0,
    items: [],
  };

  for (const { id } of candidates) {
    try {
      const outcome = await payAdvanceForSale(id);
      if (outcome.status === 'paid') {
        result.paid += 1;
        result.totalTransferredPaise += outcome.amount;
      } else {
        result.skipped += 1;
      }
      result.items.push({ saleId: id, ...outcome });
    } catch (err) {
      // UNIQUE(saleId) violation => another run already paid this sale; that is
      // a *successful* idempotency outcome, not a failure.
      if (err?.code === 'P2002') {
        result.skipped += 1;
        result.items.push({ saleId: id, status: 'skipped', reason: 'already_advanced' });
      } else {
        // Hard transfer failure: the transaction rolled back, so the sale keeps
        // advancePaidAt = NULL and will be retried on the next run.
        result.failed += 1;
        result.items.push({ saleId: id, status: 'failed', reason: err.message });
      }
    }
  }

  result.totalTransferred = paiseToRupees(result.totalTransferredPaise);
  return result;
}

async function payAdvanceForSale(saleId) {
  return runTransaction(async (tx) => {
    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    if (!sale) return { status: 'skipped', reason: 'not_found' };
    if (sale.status !== 'PENDING') return { status: 'skipped', reason: 'not_pending' };
    if (sale.advancePaidAt) return { status: 'skipped', reason: 'already_advanced' };

    const amount = computeAdvance(sale.earning);
    if (amount <= 0) return { status: 'skipped', reason: 'advance_below_one_paisa' };

    // Atomically CLAIM the sale. Only one runner can flip advancePaidAt from
    // null; a loser sees count === 0 and skips. Done before the transfer so a
    // failed transfer (throw -> rollback) reverts the claim for a later retry.
    const claim = await tx.sale.updateMany({
      where: { id: saleId, status: 'PENDING', advancePaidAt: null },
      data: { advancePaidAmount: amount, advancePaidAt: new Date() },
    });
    if (claim.count === 0) return { status: 'skipped', reason: 'already_advanced' };

    // Attempt the transfer. If it throws, the whole transaction (including the
    // claim above) rolls back and the sale stays claimable for the next run.
    const transfer = await paymentGateway.transferAdvance({
      userId: sale.userId,
      amount,
      reference: saleId,
    });

    await tx.payout.create({
      data: {
        userId: sale.userId,
        type: 'ADVANCE',
        status: 'COMPLETED',
        amount,
        saleId,
        providerRef: transfer.providerRef,
        completedAt: new Date(),
      },
    });

    return { status: 'paid', amount, amountRupees: paiseToRupees(amount) };
  });
}
