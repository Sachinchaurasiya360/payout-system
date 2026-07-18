import { prisma, lockRowForUpdate } from '../db/prisma.js';
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
 *   2. Per-sale transaction with `SELECT ... FOR UPDATE` on the sale row, then
 *      a re-check of the flag inside the lock (defeats read-modify-write races).
 *   3. UNIQUE(Payout.saleId): the database physically refuses a duplicate
 *      advance row even if layers 1-2 were somehow bypassed.
 *
 * An advance is a direct transfer to the user; it does NOT touch the
 * withdrawable balance. The balance is affected only at reconciliation, where
 * the advance already paid is netted out.
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
  return prisma.$transaction(async (tx) => {
    await lockRowForUpdate(tx, 'sales', saleId);

    const sale = await tx.sale.findUnique({ where: { id: saleId } });
    if (!sale) return { status: 'skipped', reason: 'not_found' };
    if (sale.status !== 'PENDING') return { status: 'skipped', reason: 'not_pending' };
    if (sale.advancePaidAt) return { status: 'skipped', reason: 'already_advanced' };

    const amount = computeAdvance(sale.earning);
    if (amount <= 0) return { status: 'skipped', reason: 'advance_below_one_paisa' };

    // Attempt the transfer FIRST. If it throws, the whole transaction rolls
    // back and the sale stays claimable for the next run.
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

    await tx.sale.update({
      where: { id: saleId },
      data: { advancePaidAmount: amount, advancePaidAt: new Date() },
    });

    return { status: 'paid', amount, amountRupees: paiseToRupees(amount) };
  });
}
